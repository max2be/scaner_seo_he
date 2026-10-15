import { createHash } from 'node:crypto';
import { type DiscoveryRecord, type PageObservation, type RuleProfile, type Entity, type DiscoverySummary,
  type AnalysisSummary, AnalysisSummarySchema, type UrlRecord } from '@hsi/contracts';
import { SafeHttpClient, RuleEngine, seoRules, normalizedTarget, type RuleContext, type HttpFetchResult } from '@hsi/core';
import { parsePageFacts, normalizeUrl } from '@hsi/sources';
import { DurableDiscoveryStore } from '@hsi/storage';
import type { ProjectConfig } from '@hsi/contracts';
const entityRuleIds = new Set(['EXPECTED_PAGE_NOT_200', 'EXPECTED_URL_MISSING_FROM_SITEMAP', 'ROBOTS_DISALLOWED_EXPECTED', 'NOINDEX_EXPECTED_PAGE', 'PRODUCT_DATA_CONFLICT', 'SSR_CONTENT_MISSING']);
const genericEngine = new RuleEngine(seoRules.filter(rule => !entityRuleIds.has(rule.id)));
const entityEngine = new RuleEngine(seoRules.filter(rule => entityRuleIds.has(rule.id) || rule.id === 'CANONICAL_CONFLICT'));
export async function hasExpectedEntity(store: DurableDiscoveryStore, url: string) {
  const coverage = store.state.feed;
  if (!coverage.complete || coverage.snapshotConsistency !== 'consistent') return false;
  for await (const edge of store.provenanceFor(url)) if (edge.entity?.publicationState === 'published' && edge.entity.expectedIndexable === true && (edge.entity.expectedStatus ?? 200) === 200) return true;
  return false;
}
/** Called before URL checkpoint, so HTTP result, extracted facts and diagnostic checks commit together. */
export async function collectObservation(project: ProjectConfig, profile: RuleProfile, store: DurableDiscoveryStore,
  record: DiscoveryRecord, result: HttpFetchResult, client: SafeHttpClient, signal: AbortSignal): Promise<void> {
  const observation: PageObservation = { schemaVersion: '1.0', url: record.url, result, checks: [], duplicateTitleEligible: false };
  if (result.status === 'fetched' && /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(result.evidence.contentType)) {
    const responseUrl = result.responseUrlRaw ?? result.evidence.responseUrl;
    observation.responseIdentity = createHash('sha256').update(normalizedTarget(responseUrl)).digest('hex');
    const probe = profile.unknownRouteProbes.find(p => p.url === record.url);
    const facts = parsePageFacts(result.body, responseUrl, { userAgent: project.http.userAgent, contentType: result.evidence.contentType,
      ...(result.xRobotsTag ? { xRobotsTag: result.xRobotsTag } : {}), ...(probe?.notFoundMarker ? { notFoundMarker: probe.notFoundMarker } : {}) });
    observation.facts = facts;
    let knownNonIndexable = false; const feed = store.state.feed;
    if (feed.complete && feed.snapshotConsistency === 'consistent') {
      let hadEntity = false; let allNonIndexable = true;
      for await (const edge of store.provenanceFor(record.url)) if (edge.entity) {
        hadEntity = true; allNonIndexable &&= edge.entity.publicationState !== 'published' || edge.entity.expectedIndexable === false;
      }
      knownNonIndexable = hadEntity && allNonIndexable;
    }
    const finalUrl = responseUrl;
    const checks: { kind: 'canonical' | 'trailing_slash'; target: string }[] = [];
    const unique = [...new Set(facts.canonicals.map(c => c.url))];
    if (!probe && !knownNonIndexable && result.evidence.httpStatus === 200 && !facts.noindex && unique.length === 1 && facts.canonicals[0]?.absolute && !facts.canonicals[0].fragment && !facts.canonicalInvalid) {
      const target = unique[0]!;
      if (target !== record.url && target !== finalUrl && normalizeUrl(target, finalUrl, project).kind === 'include') checks.push({ kind: 'canonical', target });
    }
    if (!probe && !knownNonIndexable && !facts.noindex && profile.checkTrailingSlash && result.evidence.httpStatus === 200) {
      const variant = new URL(record.url);
      if (variant.pathname !== '/' && !/\.[a-z0-9]{1,8}$/i.test(variant.pathname.replace(/\/$/, ''))) {
        variant.pathname = variant.pathname.endsWith('/') ? variant.pathname.slice(0, -1) : variant.pathname + '/';
        checks.push({ kind: 'trailing_slash', target: variant.href });
      }
    }
    for (const check of checks) {
      signal.throwIfAborted();
      const known = await store.observation(check.target);
      const fetched = observation.checks.find(c => c.target === check.target)?.result ?? known?.result ?? await client.fetch(check.target, { signal });
      signal.throwIfAborted(); observation.checks.push({ ...check, result: fetched });
    }
    // A duplicate group excludes redirects and deliberate non-self canonical copies.
    observation.duplicateTitleEligible = !probe && !knownNonIndexable && result.evidence.httpStatus === 200 && !result.redirectChain.length && !facts.noindex && !facts.truncated &&
      unique.length <= 1 && !facts.canonicalInvalid && (!unique[0] || normalizedTarget(unique[0], project.canonicalPolicy) === normalizedTarget(record.url, project.canonicalPolicy));
  }
  await store.recordObservation(observation);
}
export async function analyzeScan(project: ProjectConfig, profile: RuleProfile, store: DurableDiscoveryStore,
  scanId: string, coverage: DiscoverySummary, signal: AbortSignal,
  commit: (progress: NonNullable<DurableDiscoveryStore['analysisProgress']>) => Promise<void> = progress => store.commitAnalysis(progress)): Promise<AnalysisSummary> {
  const progress = store.analysisProgress; if (!progress) throw new Error('legacy_scan_has_no_analysis');
  if (progress.phase !== 'done') {
    progress.phase = 'running';
    for (let record = await store.analysisNext(progress.offset); record; record = await store.analysisNext(progress.offset)) {
      signal.throwIfAborted();
      const observation = await store.observation(record.url);
      if (!observation) {
        if (await store.recordAnalysisError({ schemaVersion: '1.0', code: 'page_observation_missing', url: record.url })) progress.errors++;
      } else {
        const result = observation.result;
        const url: UrlRecord = { schemaVersion: '1.0', projectId: project.id, scanId, url: record.url, normalizedUrl: record.url,
          sourceSet: record.sourceSet, sourcePages: [], entityRefs: [], status: result.status,
          ...(result.status === 'fetched' ? { evidence: result.evidence } : {}), ...(result.status === 'fetch_error' ? { errorCode: result.errorCode } : {}) };
        const titleGroup = observation.facts?.titleHash ? await store.titleGroup(observation.facts.titleHash) : undefined;
        const context: RuleContext = { project, url, analysis: { profile, observation, coverage, ...(titleGroup ? { titleGroup } : {}) } };
        async function evaluate(engine: RuleEngine, entity?: Entity) {
          signal.throwIfAborted(); const evaluated = await engine.evaluate({ ...context, ...(entity ? { entity } : {}) });
          progress!.rulesEvaluated += evaluated.evaluations.filter(e => e.result.verdict !== 'not_applicable').length;
          for (const error of evaluated.errors) if (await store.recordAnalysisError(error)) progress!.errors++;
          for (const { result } of evaluated.evaluations) if (result.verdict === 'finding' || result.verdict === 'needs_review') {
            if (await store.recordFinding(result.finding)) { if (result.verdict === 'needs_review') progress!.needsReview++; else progress!.findings++; }
          }
        }
        // Iterate disk provenance; never accumulate all entities or incoming links of a popular URL.
        let linked = false; let hadEntity = false; let allNonIndexable = true;
        for await (const edge of store.provenanceFor(record.url)) {
          if (edge.source === 'link' && !linked && edge.sourceUrl) { context.analysis!.provenance = edge; linked = true; }
          if (edge.entity) {
            hadEntity = true; allNonIndexable &&= edge.entity.publicationState !== 'published' || edge.entity.expectedIndexable === false;
            if (await store.mark('analysis-entity', JSON.stringify([record.url, edge.entity.type, edge.entity.id]))) await evaluate(entityEngine, edge.entity);
          }
        }
        if (hadEntity && allNonIndexable && coverage.backendComplete && coverage.snapshotConsistency === 'consistent') context.analysis!.indexableExpected = false;
        await evaluate(genericEngine);
      }
      progress.offset += 67; progress.urlsAnalyzed++; signal.throwIfAborted(); await commit(progress);
    }
  }
  const summary = AnalysisSummarySchema.parse({ schemaVersion: '1.0', engineVersion: '1.0.0', urlsAnalyzed: progress.urlsAnalyzed,
    rulesEvaluated: progress.rulesEvaluated, findings: progress.findings, needsReview: progress.needsReview,
    errors: progress.errors, coverageComplete: coverage.discoveryComplete && progress.errors === 0 });
  if (progress.phase !== 'done') { await store.recordAnalysisSummary(summary); progress.phase = 'done'; await commit(progress); }
  return summary;
}

export function assertRuleProfileForProject(project: ProjectConfig, profile: RuleProfile) {
  for (const probe of profile.unknownRouteProbes) {
    const normalized = normalizeUrl(probe.url, project.baseUrl, project);
    if (normalized.kind !== 'include' || normalized.url !== probe.url) throw new Error('probe_url_not_in_project_scope');
  }
}
