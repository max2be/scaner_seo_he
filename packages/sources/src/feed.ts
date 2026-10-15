import { EntityFeedSchema, type Entity, type ProjectConfig, type DiscoveryStore } from '@hsi/contracts';
import type { SafeHttpClient } from '@hsi/core';
import { SourceFailure } from './errors.js';
export interface FeedState { complete: boolean; snapshotConsistency: 'consistent' | 'unknown' | 'changed'; pages: number; entities: number }
export async function importEntityFeed(project: ProjectConfig, client: SafeHttpClient, store: DiscoveryStore,
  emit: (entity: Entity) => Promise<void>, state: FeedState, signal?: AbortSignal,
  limits: { maxPages: number; maxEntities: number } = { maxPages: 10000, maxEntities: 1000000 },
  recovery?: { cursor: string | null; snapshot?: string; commit: () => Promise<void> }): Promise<void> {
  const backend = project.sources.backend; if (!backend?.enabled) { state.complete = true; return; }
  let cursor: string | null = recovery?.cursor ?? null; let snapshot: string | undefined = recovery?.snapshot;
  if (recovery && state.complete) return;
  while (true) {
    signal?.throwIfAborted();
    if (state.pages >= limits.maxPages) throw new SourceFailure('feed_page_limit');
    if (!await store.mark('feed-cursor', JSON.stringify(cursor))) throw new SourceFailure('feed_cursor_loop');
    const url = new URL(backend.endpoint); url.searchParams.set('limit', String(backend.pageSize));
    url.searchParams.delete('cursor'); if (cursor !== null) url.searchParams.set('cursor', cursor);
    const result = await client.fetch(url.href, signal ? { signal } : {});
    if (result.status !== 'fetched') throw new SourceFailure('feed_' + (result.status === 'fetch_error' ? result.errorCode : 'unavailable'));
    if (result.evidence.httpStatus !== 200) throw new SourceFailure('feed_http_' + result.evidence.httpStatus);
    let json: unknown; try { json = JSON.parse(result.body.toString('utf8')); } catch { throw new SourceFailure('feed_invalid_json'); }
    const parsed = EntityFeedSchema.safeParse(json); if (!parsed.success) throw new SourceFailure('feed_invalid_schema');
    const page = parsed.data;
    if (state.pages === 0) { snapshot = page.snapshotId; state.snapshotConsistency = snapshot ? 'consistent' : 'unknown'; }
    else if (page.snapshotId !== snapshot) { state.snapshotConsistency = 'changed'; throw new SourceFailure('feed_snapshot_changed'); }
    state.pages++;
    for (const entity of page.items) {
      if (state.entities >= limits.maxEntities) throw new SourceFailure('feed_entity_limit');
      if (!await store.mark('feed-entity', JSON.stringify([entity.type, entity.id]))) throw new SourceFailure('feed_duplicate_entity');
      if (!project.allowedHosts.includes(new URL(entity.url).hostname)) throw new SourceFailure('feed_entity_outside_hosts');
      await emit(entity); state.entities++;
    }
    cursor = page.nextCursor;
    if (cursor === null) state.complete = true;
    if (recovery) { recovery.cursor = cursor; if (snapshot !== undefined) recovery.snapshot = snapshot; await recovery.commit(); }
    if (cursor === null) return;
  }
}
