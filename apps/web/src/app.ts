import Fastify from 'fastify';
import { z } from 'zod';
import { checkDataDirectory, isMissing, StorageConflict, ScanRepository } from '@hsi/storage';
import { registerAuth, type WebAuthConfig } from './auth.js';
import { ApiInputError } from './input.js';
import { CredentialOriginsSchema } from './credentials.js';
import { registerRoutes } from './routes.js';
export const HealthSchema = z.object({ status: z.enum(['ok', 'unavailable']) }).strict();
export interface WebOptions {
    auth?: WebAuthConfig;
    now?: () => number;
    concurrency?: number;
    backendCredentialOrigins?: Record<string, string[]>;
}
export function buildApp(dataDir: string, options: WebOptions = {}) {
    const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 1048576, requestTimeout: 15000, connectionTimeout: 15000, routerOptions: { maxParamLength: 200 } });
    registerAuth(app, dataDir, options.auth, options.now);
    app.addHook('onSend', async (_request, reply) => {
        reply.header('cache-control', 'no-store');
        reply.header('x-content-type-options', 'nosniff');
        reply.header('x-frame-options', 'DENY');
        reply.header('referrer-policy', 'no-referrer');
        reply.header('cross-origin-resource-policy', 'same-origin');
        reply.header('vary', 'Cookie, Origin');
        if (!reply.getHeader('content-security-policy'))
            reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        if (options.auth)
            reply.header('strict-transport-security', 'max-age=31536000');
    });
    app.get('/api/health', async (_request, reply) => {
        try {
            await checkDataDirectory(dataDir);
            return HealthSchema.parse({ status: 'ok' });
        }
        catch {
            return reply.code(503).send(HealthSchema.parse({ status: 'unavailable' }));
        }
    });
    registerRoutes(app, dataDir, options.concurrency ?? 2, CredentialOriginsSchema.parse(options.backendCredentialOrigins ?? {}));
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'resource_not_found' }));
    app.setErrorHandler(async (error, request, reply) => {
        if (error instanceof ApiInputError)
            return reply.code(400).send({ error: 'invalid_request', issues: error.issues });
        if (error instanceof StorageConflict) {
            let currentScanId: string | undefined;
            const params = request.params as {
                id?: string;
            } | undefined;
            if (params?.id && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(params.id)) {
                try {
                    currentScanId = (await new ScanRepository(dataDir).list(params.id)).find(v => ['queued', 'running', 'interrupted'].includes(v.status))?.scanId;
                }
                catch { /* Do not expose storage paths or data in the error response. */ }
            }
            return reply.code(409).send({ error: error.code, ...(currentScanId ? { currentScanId } : {}) });
        }
        if (error instanceof Error && ['unknown_rule_override', 'invalid_rule_profile', 'backend_credential_binding_required'].includes(error.message))
            return reply.code(400).send({ error: error.message === 'backend_credential_binding_required' ? error.message : 'invalid_rule_profile' });
        if (isMissing(error))
            return reply.code(404).send({ error: 'resource_not_found' });
        if (error instanceof Error && /^(?:stale_or_invalid_(?:report|diff)_cursor|invalid_(?:report|diff)_cursor)$/.test(error.message))
            return reply.code(400).send({ error: 'invalid_cursor' });
        if (error instanceof Error && ['report_stale', 'report_generation_mismatch'].includes(error.message))
            return reply.code(409).send({ error: 'report_not_ready' });
        if (error && typeof error === 'object' && 'statusCode' in error && [400, 413, 415].includes(Number(error.statusCode)))
            return reply.code(Number(error.statusCode)).send({ error: Number(error.statusCode) === 413 ? 'request_too_large' : 'invalid_request' });
        return reply.code(500).send({ error: 'internal_error' });
    });
    return app;
}
