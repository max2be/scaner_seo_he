import { ProjectConfigSchema, DiscoverySummarySchema, type DiscoveryIssue, type DiscoveryRecord,
  type DiscoveryRecovery, type DiscoveryStore, type DiscoverySummary, type ProjectConfig, type Provenance, type ResponseSpool } from '@hsi/contracts';
import { SafeHttpClient, type HttpFetchResult } from '@hsi/core';
import { normalizeUrl, safeUrl } from './normalization.js';
import { parseSitemap } from './sitemap.js';
import { parseLinks } from './html.js';
import { importEntityFeed, type FeedState } from './feed.js';
import { SourceFailure } from './errors.js';
export interface DiscoveryOptions {
  store: DiscoveryStore;
  recovery?: DiscoveryRecovery;
  additionalSeeds?: readonly string[];
  confirmExpectedMissing?: (record: DiscoveryRecord) => Promise<boolean>;
  createSpool: () => Promise<ResponseSpool>;
  client?: SafeHttpClient;
  backendClient?: SafeHttpClient;
  readToken?: (name: string) => string | undefined;
  signal?: AbortSignal;
  onPage?: (record: DiscoveryRecord, result: HttpFetchResult) => Promise<void>;
  limits?: { maxSitemaps?: number; maxSitemapDepth?: number; maxFeedPages?: number; maxEntities?: number };
}
/** Standalone discovery coordinator; no scan lifecycle, rules or UI side effects. */
export async function discover(input: ProjectConfig, options: DiscoveryOptions): Promise<DiscoverySummary> {
  const project = ProjectConfigSchema.parse(input); const store = options.store;
  const client = options.client ?? new SafeHttpClient(project); const signal = options.signal;
  let processed = 0; let fetched = 0; let skippedRobots = 0; let fetchErrors = 0;
  let sourceErrors = 0; let excluded = 0; let truncated = false; let issueCount = 0; let sitemapComplete = true;
  const limitsSeen = new Set<string>(); const feed: FeedState = { complete: !project.sources.backend?.enabled, snapshotConsistency: 'unknown', pages: 0, entities: 0 };
  async function issue(kind: DiscoveryIssue['kind'], source: DiscoveryIssue['source'], code: string, url?: string) {
    if (kind === 'limit') {
      truncated = true;
      if (limitsSeen.has(source + code)) return;
      limitsSeen.add(source + code);
    }
    const safe = url ? safeUrl(url) : undefined;
    await store.issue({ schemaVersion: '1.0', kind, source, code, ...(safe ? { url: safe } : {}) }); issueCount++;
    if (kind === 'source_error') sourceErrors++;
  }
  async function add(inputUrl: string, base: string, depth: number, source: Provenance['source'],
    extra: Partial<Pick<Provenance, 'entity' | 'href' | 'sourceUrl'>> = {}): Promise<'included' | 'excluded' | 'limit'> {
    signal?.throwIfAborted();
    const normalized = normalizeUrl(inputUrl, base, project);
    if (normalized.kind === 'exclude') { excluded++; return 'excluded'; }
    const result = await store.add(normalized.url, depth, source, project.discovery.maxUrls);
    if (result === 'limit') { excluded++; await issue('limit', source === 'backend' ? 'backend' : source === 'sitemap' ? 'sitemap' : 'crawl', 'max_urls', normalized.url); return 'limit'; }
    // All actual source edges are preserved append-only, not accumulated in a URL-sized array.
    const sourceUrl = extra.sourceUrl ? safeUrl(extra.sourceUrl) : undefined;
    const href = extra.href ? safeUrl(new URL(extra.href, base).href) : undefined;
    await store.provenance({ schemaVersion: '1.0', targetUrl: normalized.url, source,
      ...(sourceUrl ? { sourceUrl } : {}), ...(href ? { href } : {}), ...(extra.entity ? { entity: extra.entity } : {}) });
    return 'included';
  }
  const recovery = options.recovery; const restored = recovery?.state;
  if (restored) {
    ({ processed, fetched, skippedRobots, fetchErrors, sourceErrors, excluded, truncated, issueCount, sitemapComplete } = restored);
    Object.assign(feed, restored.feed);
  }
  let phase = restored?.phase ?? 'init';
  let maps = restored?.maps ?? 0;
  const feedRecovery = { cursor: restored?.feed.cursor ?? null, ...(restored?.feed.snapshot !== undefined ? { snapshot: restored.feed.snapshot } : {}), commit: async () => commit() };
  async function commit() {
    await recovery?.commit({ schemaVersion: '1.0', phase, processed, fetched, skippedRobots, fetchErrors,
      sourceErrors, excluded, truncated, issueCount, sitemapComplete, maps,
      feed: { ...feed, cursor: feedRecovery.cursor, ...(feedRecovery.snapshot !== undefined ? { snapshot: feedRecovery.snapshot } : {}) } });
  }

  const ancestors = new Set<string>();
  async function sitemap(rawUrl: string, depth: number): Promise<void> {
    signal?.throwIfAborted();
    let target: URL;
    try { target = new URL(rawUrl); target.hash = ''; } catch { throw new SourceFailure('sitemap_url_invalid'); }
    if (!safeUrl(target.href) || !project.allowedHosts.includes(target.hostname)) throw new SourceFailure('sitemap_destination_blocked');
    if (ancestors.has(target.href)) throw new SourceFailure('sitemap_cycle');
    if (depth > (options.limits?.maxSitemapDepth ?? 32)) throw new SourceFailure('sitemap_depth_limit');
    if (!await store.mark('sitemap', target.href)) return; // shared child in a DAG is not a cycle
    if (++maps > (options.limits?.maxSitemaps ?? 10000)) throw new SourceFailure('sitemap_count_limit');
    ancestors.add(target.href); const spool = await options.createSpool();
    try {
      const result = await client.fetchToSink(target.href, () => spool.createSink(), signal ? { signal } : {});
      if (result.status !== 'fetched') throw new SourceFailure('sitemap_' + (result.status === 'fetch_error' ? result.errorCode : 'robots_disallowed'));
      if (result.evidence.httpStatus !== 200) throw new SourceFailure('sitemap_http_' + result.evidence.httpStatus);
      await parseSitemap(spool.read(), async entry => {
        signal?.throwIfAborted();
        if (entry.kind === 'sitemap') await sitemap(entry.url, depth + 1);
        else if (await add(entry.url, target.href, 0, 'sitemap', { sourceUrl: target.href }) === 'limit') throw new SourceFailure('max_urls');
      });
    } finally { ancestors.delete(target.href); await spool.close(); }
  }
  async function durableSitemaps() {
    if (!recovery) return;
    for (let task = await recovery.nextSitemap(); task; task = await recovery.nextSitemap()) {
      signal?.throwIfAborted(); const target = task.url;
      try {
        if (task.ancestors.includes(target)) throw new SourceFailure('sitemap_cycle');
        if (task.ancestors.length > (options.limits?.maxSitemapDepth ?? 32)) throw new SourceFailure('sitemap_depth_limit');
        if (await store.mark('sitemap', target)) {
          if (++maps > (options.limits?.maxSitemaps ?? 10000)) throw new SourceFailure('sitemap_count_limit');
          if (!safeUrl(target) || !project.allowedHosts.includes(new URL(target).hostname)) throw new SourceFailure('sitemap_destination_blocked');
          const spool = await options.createSpool();
          try {
            const result = await client.fetchToSink(target, () => spool.createSink(), signal ? { signal } : {});
            if (result.status !== 'fetched') throw new SourceFailure('sitemap_' + (result.status === 'fetch_error' ? result.errorCode : 'robots_disallowed'));
            if (result.evidence.httpStatus !== 200) throw new SourceFailure('sitemap_http_' + result.evidence.httpStatus);
            await parseSitemap(spool.read(), async entry => {
              signal?.throwIfAborted();
              if (entry.kind === 'sitemap') {
                let child: URL;
                try { child = new URL(entry.url); child.hash = ''; } catch { throw new SourceFailure('sitemap_url_invalid'); }
                if (!safeUrl(child.href) || !project.allowedHosts.includes(child.hostname)) throw new SourceFailure('sitemap_destination_blocked');
                await recovery.enqueueSitemap({ url: child.href, ancestors: [...task!.ancestors, target] });
              }
              else if (await add(entry.url, target, 0, 'sitemap', { sourceUrl: target }) === 'limit') throw new SourceFailure('max_urls');
            });
          } finally { await spool.close(); }
        }
      } catch (error) {
        if (signal?.aborted || !(error instanceof SourceFailure)) throw error;
        sitemapComplete = false; await issue('source_error', 'sitemap', error.code, target);
        if (error.code.endsWith('_limit') || error.code === 'max_urls') await issue('limit', 'sitemap', error.code, target);
      }
      await commit();
    }
  }
  try {
    if (recovery && phase === 'init') {
      for (const url of project.discovery.sitemapUrls) await recovery.enqueueSitemap({ url, ancestors: [] });
      phase = 'sitemap'; await commit();
    }
    if (recovery && phase === 'sitemap') { await durableSitemaps(); phase = 'backend'; await commit(); }
    for (const url of recovery ? [] : project.discovery.sitemapUrls) {
      try { await sitemap(url, 0); }
      catch (error) {
        sitemapComplete = false;
        if (signal?.aborted) throw error;
        if (!(error instanceof SourceFailure)) throw error;
        await issue('source_error', 'sitemap', error.code, url);
        if (error.code.endsWith('_limit') || error.code === 'max_urls') await issue('limit', 'sitemap', error.code, url);
      }
    }
    if (project.sources.backend?.enabled && (!recovery || phase === 'backend')) {
      try {
        const backendClient = options.backendClient ?? SafeHttpClient.forBackend(project, options.readToken);
        await importEntityFeed(project, backendClient, store, async entity => {
          if (await add(entity.url, project.baseUrl, 0, 'backend', { entity, sourceUrl: project.sources.backend?.enabled ? project.sources.backend.endpoint : project.baseUrl }) === 'limit') throw new SourceFailure('max_urls');
        }, feed, signal, { maxPages: options.limits?.maxFeedPages ?? 10000, maxEntities: options.limits?.maxEntities ?? 1000000 }, recovery ? feedRecovery : undefined);
      } catch (error) {
        if (signal?.aborted) throw error;
        const code = error instanceof SourceFailure ? error.code : error && typeof error === 'object' && 'code' in error && error.code === 'backend_credential_unavailable' ? 'feed_credential_unavailable' : undefined;
        if (!code) throw error;
        await issue('source_error', 'backend', code);
        if (code.endsWith('_limit') || code === 'max_urls') await issue('limit', 'backend', code);
      }
    }
    if (recovery && phase === 'backend') { phase = 'seeds'; await commit(); }
    if (!recovery || phase === 'seeds') {
      for (const url of [...project.discovery.seedUrls, ...(options.additionalSeeds ?? [])]) await add(url, project.baseUrl, 0, 'seed');
      if (recovery) { phase = 'crawl'; await commit(); }
    }
    for (let record = await store.next(); record; record = await store.next()) {
      signal?.throwIfAborted();
      const confirmExpectedMissing = await options.confirmExpectedMissing?.(record) ?? false;
      const result = await client.fetch(record.url, { ...(signal ? { signal } : {}), ...(confirmExpectedMissing ? { confirmExpectedMissing } : {}) }); signal?.throwIfAborted(); processed++;
      if (result.status === 'fetch_error') { fetchErrors++; await issue('fetch_error', 'crawl', result.errorCode, record.url); }
      else if (result.status === 'skipped_robots') skippedRobots++;
      else {
        fetched++;
        if (result.evidence.httpStatus >= 500 || [401, 403, 429].includes(result.evidence.httpStatus))
          await issue('source_error', 'crawl', 'page_http_' + result.evidence.httpStatus, record.url);
      }
      await recovery?.recordPage(record, result);
      await options.onPage?.(record, result);
      if (result.status !== 'fetched' || !project.discovery.crawlLinks || result.evidence.httpStatus >= 500 || [401, 403, 429].includes(result.evidence.httpStatus) || !/^text\/html(?:;|$)/i.test(result.evidence.contentType)) { await commit(); continue; }
      const parsed = parseLinks(result.body, result.evidence.responseUrl);
      for (const link of parsed.links) {
        if (link.nofollow) { excluded++; continue; } // conservative default, no guessed JS navigation
        const decision = normalizeUrl(link.href, parsed.base, project);
        if (decision.kind === 'exclude') { excluded++; continue; }
        if (record.depth >= project.discovery.maxDepth && !await store.get(decision.url)) {
          excluded++; await issue('limit', 'crawl', 'max_depth', record.url); continue;
        }
        await add(decision.url, parsed.base, record.depth + 1, 'link', { href: link.href, sourceUrl: result.evidence.responseUrl });
      }
      await commit();
    }
  } catch (error) {
    if (recovery) throw error; // Leave the last committed task as recovery authority.
    if (!signal?.aborted) throw error;
    await issue('canceled', 'crawl', 'canceled');
  }
  if (recovery) signal?.throwIfAborted();
  if (store.count === 0 && !signal?.aborted) await issue('source_error', 'crawl', 'no_urls_discovered');
  const complete = sitemapComplete && feed.complete && sourceErrors === 0 && fetchErrors === 0 && !truncated && !signal?.aborted;
  const summary = DiscoverySummarySchema.parse({ schemaVersion: '1.0', status: complete ? 'completed' : 'incomplete', discoveryComplete: complete,
    sitemapComplete, backendComplete: feed.complete, snapshotConsistency: feed.snapshotConsistency,
    discovered: store.count, processed, fetched, skippedRobots, fetchErrors, sourceErrors, excluded, truncated, issueCount });
  await store.finish(summary); phase = 'done'; await commit(); return summary;
}
