import { z } from 'zod';
import { ScanRepository } from '@hsi/storage';
import { workOnce } from './jobs.js';
import { checkDataDirectory } from '@hsi/storage';
import { buildApp } from './app.js';
const config = z.object({ DATA_DIR: z.string().min(1).default('./data'),
  HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001) }).parse(process.env);
try {
  await checkDataDirectory(config.DATA_DIR);
  const app = buildApp(config.DATA_DIR);
  await app.listen({ host: config.HOST, port: config.PORT });
  const controller = new AbortController(); const repo = new ScanRepository(config.DATA_DIR, config.JOB_CONCURRENCY);
  let pending: Promise<void> | undefined;
  const poll = () => {
    if (pending || controller.signal.aborted) return;
    pending = workOnce(repo, controller.signal).catch(() => console.error(JSON.stringify({ event: 'queue_read_failed' }))).finally(() => { pending = undefined; });
  };
  const timer = setInterval(poll, 500); poll();
  console.log(JSON.stringify({ event: 'started', service: 'worker', stage: 'M3' }));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
    controller.abort(); clearInterval(timer);
    void Promise.all([app.close(), pending]).then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
  });
} catch {
  console.error(JSON.stringify({ event: 'startup_failed', service: 'worker' }));
  process.exitCode = 1;
}
