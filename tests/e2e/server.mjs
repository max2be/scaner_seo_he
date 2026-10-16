// Disposable HTTPS HSI + file-backed reports/worker. Never use production storage or secrets.
import { createServer as httpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { ProjectConfigSchema, ReportContextSchema } from '@hsi/contracts';
import {
  ProjectRepository,
  StorageConflict,
  ScanRepository,
  OperationRepository,
  FileReportWriter,
  atomicJson,
} from '@hsi/storage';
import { SafeHttpClient } from '@hsi/core';
import { buildReport } from '@hsi/reports';
import { createNodeTransport } from '../../packages/core/dist/http/transport.js';
import { buildApp } from '../../apps/web/dist/app.js';
import { hashPassword } from '../../apps/web/dist/password-hash.js';
import { runScan } from '../../apps/worker/dist/jobs.js';
import { processOperation } from '../../apps/worker/dist/operations.js';
const directory = await mkdtemp(join(tmpdir(), 'hsi-browser-'));
const key = await readFile('tests/fixtures/tls/fixture.key');
const cert = await readFile('tests/fixtures/tls/fixture.crt');
const origin = 'https://127.0.0.1:4178';
const example = JSON.parse(await readFile('docs/examples/project.example.json', 'utf8'));
const project = ProjectConfigSchema.parse({
  ...example,
  id: 'browser-reports',
  name: 'Каталог · тестовый проект',
  sources: {},
  discovery: { ...example.discovery, seedUrls: [], sitemapUrls: [], maxUrls: 1 },
});
const repo = new ScanRepository(directory);
await new ProjectRepository(directory).create(project);
const identity = (n) => 'sha256:' + createHash('sha256').update(String(n)).digest('hex');
async function seed(scanId, count, incomplete, time) {
  const manifest = await repo.enqueue(project, scanId);
  await atomicJson(join(repo.scanPath(project.id, scanId), 'manifest.json'), {
    ...manifest,
    createdAt: time,
    startedAt: time,
    finishedAt: time,
    status: incomplete ? 'incomplete' : 'completed',
    discovered: count,
    queued: 0,
    fetched: count,
    truncated: incomplete,
    scanComplete: !incomplete,
    discoveryComplete: !incomplete,
    reasons: incomplete ? ['max_urls_reached', 'sitemap_source_unchecked'] : [],
  });
  await writeFile(
    join(repo.scanPath(project.id, scanId), 'scanner_errors.jsonl'),
    incomplete
      ? JSON.stringify({ schemaVersion: '1.0', kind: 'limit', source: 'crawl', code: 'max_urls_reached' }) +
          '\n'
      : '',
  );
  const context = ReportContextSchema.parse({
    schemaVersion: '1.0',
    projectId: project.id,
    scanId,
    status: incomplete ? 'incomplete' : 'completed',
    createdAt: time,
    startedAt: time,
    finishedAt: time,
    generatedAt: time,
    sourceCheckpoint: JSON.parse(
      await readFile(join(repo.scanPath(project.id, scanId), 'checkpoint.json'), 'utf8'),
    ).checkpointSha256,
    scopeHash: 'b'.repeat(64),
    policyHash: 'c'.repeat(64),
    engineVersion: '1.0.0',
    ruleVersions: { TITLE_MISSING: '1.0.0' },
    discovery: {
      schemaVersion: '1.0',
      status: incomplete ? 'incomplete' : 'completed',
      discoveryComplete: !incomplete,
      sitemapComplete: !incomplete,
      backendComplete: true,
      snapshotConsistency: 'consistent',
      discovered: count,
      processed: count,
      fetched: count,
      skippedRobots: 0,
      fetchErrors: 0,
      sourceErrors: 0,
      excluded: 0,
      truncated: incomplete,
      issueCount: incomplete ? 1 : 0,
    },
    analysis: {
      schemaVersion: '1.0',
      engineVersion: '1.0.0',
      urlsAnalyzed: count,
      rulesEvaluated: count,
      findings: count,
      needsReview: 0,
      errors: 0,
      coverageComplete: !incomplete,
    },
    htmlEnabled: true,
    csvBom: true,
  });
  async function* findings() {
    for (let n = 0; n < count; n++)
      yield {
        schemaVersion: '1.0',
        id: identity(incomplete ? n + 20000 : n),
        projectId: project.id,
        scanId,
        ruleId: 'TITLE_MISSING',
        ruleVersion: '1.0.0',
        severity: n % 2 ? 'P2' : 'P1',
        verdict: 'finding',
        confidence: 'high',
        url: 'https://shop.example.com/' + (n === 10000 ? 'needle' : 'page/' + n),
        expected: 'Title present',
        actual: 'Title missing',
        evidence: {
          source: 'server_html',
          httpStatus: 200,
          excerpt:
            '<img src="https://never-request.example/pixel" onerror="window.__evidenceXss=1"><script>window.__evidenceXss=1</script>',
        },
        suggestionKey: 'title.add',
        firstSeenAt: time,
        lastSeenAt: time,
      };
  }
  await buildReport(
    context,
    findings(),
    await FileReportWriter.create(repo.scanPath(project.id, scanId), context),
  );
}
await seed('before', 10001, false, '2026-10-14T00:00:00.000Z');
await seed('after', 1, true, '2026-10-14T01:00:00.000Z');
const queuedProject = { ...project, id: 'browser-queued', name: 'Очередь · тестовый проект' };
await new ProjectRepository(directory).create(queuedProject);
await repo.enqueue(queuedProject, 'waiting');
const site = httpsServer({ key, cert }, (_req, res) => {
  res.writeHead(404);
  res.end();
});
site.listen(0, '127.0.0.1');
await once(site, 'listening');
const direct = createNodeTransport(cert.toString());
function fixtureClient(config) {
  return new SafeHttpClient(config, {
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: (target, settings, signal) => {
      if (target.url.hostname !== 'shop.example.com') throw new Error('fixture_host_not_allowed');
      const url = new URL(target.url);
      url.port = String(site.address().port);
      return direct({ ...target, url, address: '127.0.0.1', family: 4 }, settings, signal);
    },
  });
}
const app = buildApp(directory, {
  auth: { publicOrigin: origin, passwordHash: await hashPassword('synthetic-browser-password-only') },
});
await app.listen({ host: '127.0.0.1', port: 0 });
const webPort = app.server.address().port;
const tls = httpsServer({ key, cert }, (req, res) => {
  const proxied = httpRequest(
    { hostname: '127.0.0.1', port: webPort, path: req.url, method: req.method, headers: req.headers },
    (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    },
  );
  proxied.on('error', () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(proxied);
});
tls.listen(4178, '127.0.0.1');
await once(tls, 'listening');
let running = false;
const controller = new AbortController();
const worker = setInterval(() => {
  if (running) return;
  running = true;
  void (async () => {
    for (const id of await new ProjectRepository(directory).list()) {
      const config = (await new ProjectRepository(directory).read(id)).project;
      const client = fixtureClient(config);
      if (
        (await new OperationRepository(directory).list(id)).some((op) =>
          ['queued', 'interrupted'].includes(op.state),
        )
      )
        await processOperation(repo, id, controller.signal, { client });
      for (const scan of await repo.list(id))
        if (
          scan.status === 'queued' &&
          (scan.scanId !== 'waiting' || (await repo.cancelRequested(id, scan.scanId)))
        )
          await runScan(repo, id, scan.scanId, { signal: controller.signal, discovery: { client } });
    }
  })()
    .catch((error) => {
      if (error instanceof StorageConflict) return;
      console.error('synthetic_worker_failed:' + (error instanceof Error ? error.name : 'unknown'));
      process.exitCode = 1;
    })
    .finally(() => {
      running = false;
    });
}, 300);
async function close() {
  clearInterval(worker);
  controller.abort();
  while (running) await new Promise((resolve) => setTimeout(resolve, 30));
  tls.close();
  tls.closeAllConnections();
  site.close();
  site.closeAllConnections();
  await app.close();
  await rm(directory, { recursive: true, force: true });
  process.exit();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void close());
console.log('HSI browser fixture ready (synthetic data only)');
