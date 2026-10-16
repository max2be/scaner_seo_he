import Fastify from 'fastify';
import { z } from 'zod';
import { checkDataDirectory } from '@hsi/storage';
export const HealthSchema = z.object({ status: z.enum(['ok', 'unavailable']) }).strict();
export function buildApp(dataDir: string) {
  const app = Fastify({ logger: false });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  });
  app.get('/api/health', async (_request, reply) => {
    try { await checkDataDirectory(dataDir); return HealthSchema.parse({ status: 'ok' }); }
    catch { return reply.code(503).send(HealthSchema.parse({ status: 'unavailable' })); }
  });
  app.setNotFoundHandler((_request, reply) => reply.code(401).send({ error: 'authentication_required' }));
  app.setErrorHandler((_error, _request, reply) => reply.code(500).send({ error: 'internal_error' }));
  return app;
}
