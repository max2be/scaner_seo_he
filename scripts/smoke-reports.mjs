import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { SafeHttpClient } from '@hsi/core';
import { createNodeTransport } from './packages/core/dist/http/transport.js';
import { ProjectConfigSchema, defaultRuleProfile, FindingSchema } from '@hsi/contracts';
import { ScanRepository, DurableDiscoveryStore, FileReportReader, FileDiffReader } from '@hsi/storage';
import { runScan } from './apps/worker/dist/jobs.js';
import { rebuildScanReport, compareScans } from './apps/worker/dist/reporting.js';
if (process.getuid() === 0) throw new Error('nonroot_required');
let requests = 0;
const server = createServer((req, res) => {
  requests++; res.setHeader('content-type', 'text/html'); res.setHeader('set-cookie', 'private=must-not-persist');
  if (req.url === '/missing') { res.writeHead(404); res.end('missing'); }
  else res.end('<html><head><title>Fixture product</title><meta name="description" content="details"><script type="application/ld+json">{"@type":"Product","aggregateRating":{"ratingValue":5}}</script></head><body><h1>Fixture</h1><p>' + 'Valid content. '.repeat(20) + '</p><a href="/missing">Missing</a><button data-href="/other">Go</button></body></html>');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const directory = await mkdtemp('/data/epic06-smoke-');
try {
  const address = server.address(); const base = `http://shop.example.com:${address.port}`;
  const project = ProjectConfigSchema.parse({
    schemaVersion:'1.0',id:'container-seo-fixture',name:'Synthetic container fixture',baseUrl:base,allowedHosts:['shop.example.com'],
    discovery:{sitemapUrls:[],seedUrls:[base],crawlLinks:true,maxDepth:3,queryPolicy:{mode:'allowlist',allowedKeys:[],dropTrackingKeys:[]},maxUrls:10},
    canonicalPolicy:{trailingSlash:'unknown',expectedScheme:'http',preferredHost:'shop.example.com',checkSelfCanonical:false},
    http:{userAgent:'HeadlessSEOInspector/1.0',respectRobots:false,requestsPerSecondPerHost:100,concurrency:2,timeoutMs:1000,maxResponseBytes:500000,maxRedirects:8,maxRetries:0},
    sources:{},reports:{keepLastRuns:2,htmlEnabled:true}
  });
  const direct = createNodeTransport();
  // Synthetic, local-only adapter; there is no private-IP project setting in production.
  const client = new SafeHttpClient(project,{resolver:async()=>[{address:'93.184.216.34',family:4}],transport:(target,settings,signal)=>direct({...target,address:'127.0.0.1',family:4},settings,signal)});
  const repo = new ScanRepository(directory); const scan = await repo.enqueue(project,'smoke',{...defaultRuleProfile(),checkTrailingSlash:false});
  const manifest = await runScan(repo,project.id,scan.scanId,{discovery:{client}});
  if (manifest.status !== 'completed' || manifest.fetched !== 2) throw new Error('analysis_scan_failed');
  const path = repo.scanPath(project.id,scan.scanId); const original = await readFile(join(path,'findings.jsonl'),'utf8');
  const all = original.trim().split('\n').map(line=>FindingSchema.parse(JSON.parse(line))); const ids = new Set(all.map(f=>f.ruleId));
  for(const id of ['PRODUCT_RATING_COUNT_MISSING','BROKEN_INTERNAL_LINK','BUTTON_NAV_SUSPECTED']) if(!ids.has(id)) throw new Error('missing_rule_output');
  if(all.some(f=>f.severity==='P0')) throw new Error('false_p0');
  const wal=await readFile(join(path,'journal.jsonl'),'utf8');
  if(wal.includes('must-not-persist')||wal.includes('<script')||wal.includes('Valid content.')) throw new Error('sensitive_or_raw_body_persisted');
  const restored=await DurableDiscoveryStore.resume(path);
  if(restored.analysisProgress?.phase!=='done') throw new Error('analysis_checkpoint_lost');
  await restored.close();
  if(await readFile(join(path,'findings.jsonl'),'utf8')!==original||requests!==2) throw new Error('replay_mismatch');
  const report = await FileReportReader.open(path);
  if(report.descriptor.summary.total !== all.length || !(await readFile(join(report.directory,'report.html'),'utf8')).includes('Content-Security-Policy')) throw new Error('report_invalid');
  const first = await report.page({limit:2}); if(first.items.length!==2 || !first.nextCursor) throw new Error('report_page_invalid');
  const lease = await repo.lock(project.id);
  try { await rebuildScanReport(repo,project.id,scan.scanId); } finally { await lease.release(); }
  if(requests!==2) throw new Error('offline_export_refetched');
  const next = await repo.enqueue(project,'second',{...defaultRuleProfile(),checkTrailingSlash:false});
  if((await runScan(repo,project.id,next.scanId,{discovery:{client}})).status!=='completed') throw new Error('second_scan_failed');
  const secondLease = await repo.lock(project.id); let diff;
  try { diff=await compareScans(repo,project.id,scan.scanId,next.scanId); } finally { await secondLease.release(); }
  if(diff.counts.persisting!==all.length||diff.counts.resolved||diff.counts.new) throw new Error('diff_mismatch');
  if((await (await FileDiffReader.open(repo.scanPath(project.id,next.scanId),scan.scanId)).page({status:'persisting'})).items.length!==all.length) throw new Error('diff_paging_mismatch');
  console.log(JSON.stringify({reports:true,seekPagination:true,offlineRebuildNoRequests:true,diff:true,nonroot:true,seoPipeline:true,findings:all.length,analysisVersion:'1.1',replay:true,noFalseP0:true,noExternalTargets:true,noRawHtmlOrCookies:true}));
} finally { await rm(directory,{recursive:true,force:true}); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
