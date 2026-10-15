import { z } from 'zod';
import { checkDataDirectory } from '@hsi/storage';
import { buildApp } from './app.js';
const config = z.object({ DATA_DIR: z.string().min(1).default('./data'),
  HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000) }).parse(process.env);
try {
  await checkDataDirectory(config.DATA_DIR);
  const app = buildApp(config.DATA_DIR);
  await app.listen({ host: config.HOST, port: config.PORT });
  console.log(JSON.stringify({ event: 'started', service: 'web', stage: 'M0' }));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
    void app.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
  });
} catch {
  console.error(JSON.stringify({ event: 'startup_failed', service: 'web' }));
  process.exitCode = 1;
}
