// Reproducible two-site acceptance; no production access or credentials.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { defaultRuleProfile, FindingSchema } from '@hsi/contracts';
import { ScanRepository, ProjectRepository, FileReportReader, FileDiffReader } from '@hsi/storage';
import { runScan } from '../apps/worker/dist/jobs.js';
import { compareScans } from '../apps/worker/dist/reporting.js';
import { demoSite } from './fixtures/demo-site.mjs';
const { values } = parseArgs({ options: { output: { type: 'string' } } });
const retained = values.output !== undefined;
const directory = retained ? resolve(values.output) : await mkdtemp(join(tmpdir(), 'hsi-demo-'));
if (retained) await mkdir(directory, { mode: 0o700 }); // Never overwrite another demo/data directory.
let site;
try {
  site = await demoSite();
  const repo = new ScanRepository(join(directory, 'data'));
  await mkdir(repo.root, { mode: 0o700 });
  const projects = new ProjectRepository(repo.root);
  await projects.create(site.shop); await projects.create(site.content);
  const rules = defaultRuleProfile();
  const cases = [];
  const check = (name, condition) => { assert(condition, name); cases.push(name); };
  async function scan(project, id) {
    await repo.enqueue(project, id, rules);
    const manifest = await runScan(repo, project.id, id, { discovery: site.clients(project) });
    const path = repo.scanPath(project.id, id);
    const reader = await FileReportReader.open(path);
    const page = await reader.page({ limit: 200 });
    assert(!page.nextCursor, 'fixture_exceeds_demo_page');
    const findings = page.items.map(item => FindingSchema.parse(item));
    assert.equal(reader.descriptor.summary.total, findings.length);
    for (const name of ['summary.json', 'findings.jsonl', 'findings.csv', 'report.html', 'manifest.json', 'checkpoint.json', 'urls.jsonl']) await readFile(join(path, name));
    check(id + '_accounted', manifest.discovered === manifest.fetched + manifest.skippedRobots + manifest.fetchErrors + manifest.queued);
    return { manifest, findings, path, summary: reader.descriptor.summary };
  }
  const before = await scan(site.shop, 'before');
  const repeat = await scan(site.shop, 'repeat');
  const standalone = await scan(site.content, 'standalone');
  check('two_sites_complete', before.manifest.status === 'completed' && standalone.manifest.status === 'completed');
  check('stable_finding_ids', JSON.stringify(before.findings.map(f => f.id).sort()) === JSON.stringify(repeat.findings.map(f => f.id).sort()));
  const has = (rule, suffix) => before.findings.some(f => f.ruleId === rule && f.url.endsWith(suffix));
  check('published_missing_confirmed_p0', before.findings.some(f => f.ruleId === 'EXPECTED_PAGE_NOT_200' && f.entity?.id === 'missing' && f.severity === 'P0' && f.evidence.httpStatus === 404));
  check('broken_link_source', before.findings.some(f => f.ruleId === 'BROKEN_INTERNAL_LINK' && f.url.endsWith('/broken') && f.evidence.sourcePage === site.shop.baseUrl + '/'));
  check('rating_count_missing', has('PRODUCT_RATING_COUNT_MISSING', '/product'));
  check('button_needs_review', before.findings.some(f => f.ruleId === 'BUTTON_NAV_SUSPECTED' && f.verdict === 'needs_review'));
  check('deleted_no_p0', !before.findings.some(f => f.url.endsWith('/deleted') && f.severity === 'P0'));
  check('standalone_shell_needs_review', standalone.findings.some(f => f.ruleId === 'SSR_CONTENT_MISSING' && f.url.endsWith('/shell') && f.verdict === 'needs_review'));
  check('standalone_no_p0', !standalone.findings.some(f => f.severity === 'P0'));
  check('correct_canonical_no_conflict', !before.findings.some(f => f.ruleId === 'CANONICAL_CONFLICT'));
  check('no_rating_no_rating_error', !standalone.findings.some(f => f.ruleId === 'PRODUCT_RATING_COUNT_MISSING'));
  check('unknown_slash_no_false_rule', !before.findings.some(f => f.ruleId.includes('TRAILING_SLASH')));
  const robots = await scan({ ...site.content, id: 'demo-robots', discovery: { ...site.content.discovery, sitemapUrls: [], seedUrls: [site.content.baseUrl + '/blocked'] } }, 'robots');
  check('robots_not_requested', robots.manifest.skippedRobots === 1 && !site.hits.has(site.content.baseUrl + '/blocked'));
  check('shell_needs_review', before.findings.some(f => f.ruleId === 'SSR_CONTENT_MISSING' && f.url.endsWith('/shell') && f.verdict === 'needs_review'));
  check('shell_no_false_p0', !before.findings.some(f => f.url.endsWith('/shell') && f.severity === 'P0'));
  check('button_does_not_invent_url', !site.hits.has(site.shop.baseUrl + '/guess'));
  const urls = (await readFile(join(before.path, 'urls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const old = urls.find(record => record.record.url.endsWith('/old'));
  check('redirect_chain_preserved', JSON.stringify(old).includes('301') && JSON.stringify(old).includes('308'));
  check('feed_pagination', site.hits.get('feed') === 4);
  site.release();
  const after = await scan(site.shop, 'after');
  await compareScans(repo, site.shop.id, 'before', 'after');
  const diff = await FileDiffReader.open(after.path, 'before');
  check('release_diff_resolved', diff.descriptor.summary.counts.resolved >= 2);
  check('release_no_expected_missing', !after.findings.some(f => f.ruleId === 'EXPECTED_PAGE_NOT_200'));
  const malformed = await scan({ ...site.content, id: 'demo-malformed', discovery: { ...site.content.discovery, sitemapUrls: [site.content.baseUrl + '/malformed.xml'] } }, 'malformed');
  check('malformed_xml_incomplete', malformed.manifest.status === 'incomplete' && !malformed.manifest.discoveryComplete);
  const limited = await scan({ ...site.content, id: 'demo-limited', discovery: { ...site.content.discovery, maxUrls: 1 } }, 'limited');
  check('limit_incomplete', limited.manifest.status === 'incomplete' && limited.manifest.truncated);
  const loop = await scan({ ...site.content, id: 'demo-loop', discovery: { ...site.content.discovery, sitemapUrls: [], seedUrls: [site.content.baseUrl + '/loop-a'] } }, 'loop');
  check('loop_bounded_and_diagnosed', loop.manifest.status === 'incomplete' && loop.findings.some(f => f.ruleId === 'REDIRECT_LOOP'));
  const artifacts = await readFile(join(before.path, 'journal.jsonl'), 'utf8');
  check('no_auth_or_raw_html', !artifacts.includes('synthetic-demo-token') && !artifacts.includes('<html>'));
  const labelled = ['published_missing_confirmed_p0', 'broken_link_source', 'rating_count_missing', 'button_needs_review', 'standalone_shell_needs_review', 'deleted_no_p0', 'standalone_no_p0', 'correct_canonical_no_conflict', 'no_rating_no_rating_error', 'unknown_slash_no_false_rule', 'robots_not_requested', 'shell_no_false_p0', 'button_does_not_invent_url'];
  check('no_unlabelled_p0', before.findings.every(f => f.severity !== 'P0' || f.ruleId === 'EXPECTED_PAGE_NOT_200' && f.entity?.id === 'missing'));
  const result = { labelled: { cases: labelled.length, passed: labelled.filter(name => cases.includes(name)).length, falseP0: 0 }, schemaVersion: '1.0', sites: 2, scans: 8, passed: cases.length, checks: cases,
    baselineFindings: before.findings.length, standaloneFindings: standalone.findings.length, diff: diff.descriptor.summary.counts,
    transport: 'disposable-http-and-trusted-tls', productionRequests: 0, ...(retained ? { retained: true } : {}) };
  if (retained) await writeFile(join(directory, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(result));
} finally {
  await site?.close();
  if (!retained) await rm(directory, { recursive: true, force: true });
}
