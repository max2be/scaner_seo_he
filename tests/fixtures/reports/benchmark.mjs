// Standalone child: the heap cap proves exports/indexes cannot retain all 100k findings.
import { mkdtemp, rm, stat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildReport, buildDiff } from '@hsi/reports';
import { FileReportWriter, FileReportReader, FileDiffWriter, FileDiffReader } from '@hsi/storage';
const directory = await mkdtemp(join(tmpdir(), 'hsi-100k-reports-'));
const time = '2026-10-15T00:00:00.000Z', count = 100000, start = performance.now();
let maxHeap = 0;
const measure = () => { maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed); };
const context = { schemaVersion: '1.0', projectId: 'benchmark', scanId: 'before', status: 'completed', createdAt: time, startedAt: time, finishedAt: time, generatedAt: time,
  sourceCheckpoint: 'a'.repeat(64), scopeHash: 'b'.repeat(64), policyHash: 'c'.repeat(64), engineVersion: '1.0.0', ruleVersions: { TITLE_MISSING: '1.0.0' },
  discovery: { schemaVersion: '1.0', status: 'completed', discoveryComplete: true, sitemapComplete: true, backendComplete: true, snapshotConsistency: 'consistent',
    discovered: count, processed: count, fetched: count, skippedRobots: 0, fetchErrors: 0, sourceErrors: 0, excluded: 0, truncated: false, issueCount: 0 },
  analysis: { schemaVersion: '1.0', engineVersion: '1.0.0', urlsAnalyzed: count, rulesEvaluated: count, findings: count, needsReview: 0, errors: 0, coverageComplete: true }, htmlEnabled: true, csvBom: true };
const id = n => 'sha256:' + createHash('sha256').update(String(n)).digest('hex');
async function* input() {
  for (let n = 0; n < count; n++) { if (n % 1000 === 0) measure(); yield { schemaVersion: '1.0', id: id(n), projectId: 'benchmark', scanId: 'before', ruleId: 'TITLE_MISSING', ruleVersion: '1.0.0', severity: n % 2 ? 'P1' : 'P2', verdict: 'finding', confidence: 'high',
    url: 'https://shop.example.com/page/' + n, expected: 'Title present', actual: 'Missing', evidence: { source: 'server_html', httpStatus: 200, excerpt: '<script>synthetic</script>' }, suggestionKey: 'title.add', firstSeenAt: time, lastSeenAt: time }; }
}
function assert(value, message) { if (!value) throw new Error(message); }
try {
  const beforeDir = join(directory, 'before'); await buildReport(context, input(), await FileReportWriter.create(beforeDir, context)); measure();
  const reader = await FileReportReader.open(beforeDir, false), first = await reader.page({ limit: 10 });
  const seek = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString()); seek.ordinal = count - 10;
  const pageStart = performance.now(); const last = await reader.page({ limit: 10, cursor: Buffer.from(JSON.stringify(seek)).toString('base64url') });
  const seekMs = performance.now() - pageStart;
  assert(last.scanned === 10 && last.items.length === 10 && last.nextCursor === null && last.items[9].url.endsWith('/99999'), 'last_page_seek_failed');
  assert((await reader.find(id(99999)))?.url.endsWith('/99999'), 'identity_lookup_failed');
  const search = await reader.page({ filter: { urlContains: '/never-matches' } });
  assert(search.items.length === 0 && search.scanned === 10000 && search.nextCursor && search.total === null, 'text_search_work_budget_failed');
  const filtered = await reader.page({ filter: { severity: 'P2', source: 'server_html' }, limit: 200 });
  assert(filtered.items.length === 200 && filtered.candidateCount === 50000 && filtered.scanned === 200, 'filter_index_failed');
  const jsonlBytes = (await stat(join(reader.directory, 'findings.jsonl'))).size;
  const csvBytes = (await stat(join(reader.directory, 'findings.csv'))).size;
  const htmlBytes = (await stat(join(reader.directory, 'report.html'))).size;
  // Verify actual generated row counts with bounded chunks, including HTML second pass.
  async function occurrences(path, needle) { const f = await open(path, 'r'); let found = 0, tail = ''; const b = Buffer.alloc(65536); try { for (;;) { const r = await f.read(b, 0, b.length, null); if (!r.bytesRead) break; const text = tail + b.subarray(0, r.bytesRead).toString(); let i = 0, match; while ((match = text.indexOf(needle, i)) !== -1) { found++; i = match + needle.length; } tail = text.slice(Math.max(i, text.length - needle.length + 1)); measure(); } } finally { await f.close(); } return found; }
  assert(await occurrences(join(reader.directory, 'findings.jsonl'), '\n') === count, 'jsonl_count');
  assert(await occurrences(join(reader.directory, 'findings.csv'), '\r\n') === count + 1, 'csv_count');
  assert(await occurrences(join(reader.directory, 'report.html'), '<tr>') === count + 1, 'html_count');
  const afterDir = join(directory, 'after'), afterContext = { ...context, scanId: 'after', status: 'incomplete', analysis: { ...context.analysis, findings: 0, coverageComplete: false } };
  await buildReport(afterContext, (async function* () {})(), await FileReportWriter.create(afterDir, afterContext));
  const summary = await buildDiff(reader, await FileReportReader.open(afterDir, false), await FileDiffWriter.create(afterDir, 'before'));
  assert(summary.counts.unknown === count && summary.counts.resolved === 0, '100k_incomplete_diff');
  const diff = await FileDiffReader.open(afterDir, 'before'); assert((await diff.page({ status: 'unknown', sort: 'desc', limit: 1 })).items.length === 1, 'diff_paging'); measure();
  const rssMiB = process.resourceUsage().maxRSS / 1024, heapMiB = maxHeap / 1024 / 1024;
  assert(rssMiB < 256, 'rss_budget_exceeded:' + JSON.stringify({rssMiB,heapMiB,memory:process.memoryUsage()}));
  console.log(JSON.stringify({ count, diffUnknown: summary.counts.unknown, jsonlBytes, csvBytes, htmlBytes, seekScanned: last.scanned, seekMs, heapMiB, rssMiB, seconds: (performance.now() - start) / 1000 }));
} finally { await rm(directory, { recursive: true, force: true }); }
