// Local synthetic HTTP fixture only. This adapter is never shipped as a project setting.
import { ScanRepository } from '@hsi/storage';
import { SafeHttpClient } from '@hsi/core';
import { createNodeTransport } from '../../../packages/core/dist/http/transport.js';
import { runScan } from '../../../apps/worker/dist/jobs.js';
const [data, projectId, scanId] = process.argv.slice(2);
const repo = new ScanRepository(data); const project = await repo.project(projectId, scanId);
const direct = createNodeTransport();
const client = new SafeHttpClient(project, { resolver: async () => [{ address: '93.184.216.34', family: 4 }],
  transport: (target, settings, signal) => direct({ ...target, address: '127.0.0.1', family: 4 }, settings, signal) });
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
const result = await runScan(repo, projectId, scanId, { signal: controller.signal, discovery: { client } });
console.log(JSON.stringify(result));
