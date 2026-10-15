import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { LoginSchema, SessionViewSchema, type SessionFile } from '@hsi/contracts';
import { FileAuthStore, StorageConflict } from '@hsi/storage';
import { parseInput } from './input.js';
import { parsePasswordHash, verifyPassword } from './password-hash.js';
export const cookieName = '__Host-hsi_session';
export interface WebAuthConfig {
    passwordHash: string;
    publicOrigin: string;
}
export function validateAuthConfig(config: WebAuthConfig) {
    parsePasswordHash(config.passwordHash);
    const url = new URL(config.publicOrigin);
    if (url.origin !== config.publicOrigin || url.protocol !== 'https:' || url.username || url.password)
        throw new Error('invalid_public_origin');
    return config;
}
export function cookieToken(request: FastifyRequest) {
    const cookies = request.headers.cookie?.split(';').map(v => v.trim()).filter(v => v.startsWith(cookieName + '=')) ?? [];
    if (cookies.length !== 1)
        return;
    const value = cookies[0]!.slice(cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}
export function equalToken(a: string, b: string) {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}
const sessionView = (v: SessionFile) => SessionViewSchema.parse({ schemaVersion: v.schemaVersion, role: v.role, csrfToken: v.csrfToken, expiresAt: v.expiresAt });
const cookie = (token: string, age: number) => cookieName + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + age;
export function registerAuth(app: FastifyInstance, dataDir: string, input?: WebAuthConfig, now?: () => number) {
    const config = input ? validateAuthConfig(input) : undefined;
    const store = config ? new FileAuthStore(dataDir, createHash('sha256').update(config.passwordHash + '\n' + config.publicOrigin).digest('hex'), now) : undefined;
    const sessions = new WeakMap<FastifyRequest, SessionFile>();
    let kdfs = 0;
    app.addHook('onRequest', async (request, reply) => {
        if (request.method === 'GET' && request.routeOptions.url === '/api/health')
            return;
        if (request.routeOptions.url === '/api/auth/login' && request.method === 'POST') {
            if (!store || !config)
                return reply.code(503).send({ error: 'authentication_unavailable' });
            if (request.headers.origin !== config.publicOrigin || request.headers['sec-fetch-site'] === 'cross-site')
                return reply.code(403).send({ error: 'origin_rejected' });
            if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
                return reply.code(415).send({ error: 'json_required' });
            let retry: number;
            try {
                retry = await store.attempt(request.ip);
            }
            catch (error) {
                if (error instanceof StorageConflict)
                    return reply.code(429).header('retry-after', '1').send({ error: 'login_throttled', retryAfter: 1 });
                throw error;
            }
            if (retry || kdfs >= 2)
                return reply.code(429).header('retry-after', retry || 1).send({ error: 'login_throttled', retryAfter: retry || 1 });
            return;
        }
        const session = await store?.get(cookieToken(request));
        if (!session)
            return reply.code(401).send({ error: 'authentication_required' });
        sessions.set(request, session);
        if (!['GET', 'HEAD'].includes(request.method)) {
            const csrf = request.headers['x-csrf-token'];
            if (!config || request.headers.origin !== config.publicOrigin || request.headers['sec-fetch-site'] === 'cross-site' || typeof csrf !== 'string' || !equalToken(csrf, session.csrfToken))
                return reply.code(403).send({ error: 'csrf_rejected' });
            if (request.method !== 'DELETE' && request.headers['content-type'] && !request.headers['content-type'].toLowerCase().startsWith('application/json'))
                return reply.code(415).send({ error: 'json_required' });
        }
    });
    app.post('/api/auth/login', async (request, reply) => {
        const body = parseInput(LoginSchema, request.body);
        if (!store || !config)
            return reply.code(503).send({ error: 'authentication_unavailable' });
        // Recheck after asynchronous rate-store work; no unbounded KDF queue.
        if (kdfs >= 2)
            return reply.code(429).header('retry-after', '1').send({ error: 'login_throttled', retryAfter: 1 });
        kdfs++;
        let valid: boolean;
        try {
            valid = await verifyPassword(body.password, config.passwordHash);
        }
        finally {
            kdfs--;
        }
        if (!valid)
            return reply.code(401).send({ error: 'invalid_credentials' });
        try {
            const value = await store.create(cookieToken(request));
            reply.header('set-cookie', cookie(value.token, 8 * 3600));
            return sessionView(value.session);
        }
        catch (error) {
            if (error instanceof StorageConflict)
                return reply.code(429).header('retry-after', '1').send({ error: 'login_throttled', retryAfter: 1 });
            throw error;
        }
    });
    app.get('/api/me', async (request) => sessionView(sessions.get(request)!));
    app.post('/api/auth/logout', async (request, reply) => {
        await store!.remove(cookieToken(request));
        return reply.header('set-cookie', cookie('', 0)).code(204).send();
    });
}
