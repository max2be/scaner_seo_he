import { afterEach, describe, expect, it } from 'vitest';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApp } from '../apps/web/src/app.js';
import { hashPassword, parsePasswordHash, verifyPassword } from '../apps/web/src/password-hash.js';
import { FileAuthStore } from '@hsi/storage';
import { apiFixture, cleanupApiFixtures, fixturePassword, login, passwordHash, publicOrigin } from './api-fixture.js';
afterEach(cleanupApiFixtures);
describe('Argon2id / file sessions / privacy (AC-02)', () => {
    it('uses real Argon2id PHC with random salts and constant-time verification', async () => {
        const a = await passwordHash(), b = await hashPassword(fixturePassword);
        expect(a).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
        expect(a).not.toBe(b);
        expect(await verifyPassword(fixturePassword, a)).toBe(true);
        expect(await verifyPassword('wrong', a)).toBe(false);
        for (const hash of ['plaintext', a.replace('argon2id', 'argon2i'), a.replace('m=65536', 'm=1'), a.replace('t=3', 't=9'), a.replace('m=65536', 'm=999999')])
            expect(() => parsePasswordHash(hash)).toThrow();
        await expect(hashPassword('short')).rejects.toThrow();
    });
    it.each(['/', '/api/me', '/api/projects', '/api/openapi.json', '/api/projects/one/scans/s/download/html', '/data/projects/private/project.json'])('rejects anonymous %s without data or paths', async (url) => {
        const { app } = await apiFixture();
        const result = await app.inject({ url });
        expect(result.statusCode).toBe(401);
        expect(result.json()).toEqual({ error: 'authentication_required' });
        expect(result.headers['cache-control']).toBe('no-store');
        expect(result.headers['x-content-type-options']).toBe('nosniff');
    });
    it('keeps installation closed with no auth config and validates configured HTTPS origin/hash', async () => {
        const { directory, auth } = await apiFixture();
        const app = buildApp(directory);
        try {
            expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: fixturePassword } })).statusCode).toBe(503);
            expect((await app.inject({ url: '/api/projects' })).statusCode).toBe(401);
        }
        finally {
            await app.close();
        }
        for (const publicOrigin of ['http://inspector.example.com', 'https://inspector.example.com/path', 'https://u:p@inspector.example.com', 'https://inspector.example.com/'])
            expect(() => buildApp(directory, { auth: { ...auth, publicOrigin } })).toThrow();
    });
    it('requires matching login Origin/JSON, rejects wrong password without reflecting data', async () => {
        const { app, directory } = await apiFixture();
        const missing = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: fixturePassword } });
        expect(missing.statusCode).toBe(403);
        expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.example.com' }, payload: { password: fixturePassword } })).statusCode).toBe(403);
        expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: publicOrigin, 'content-type': 'text/plain' }, payload: 'secret-password' })).statusCode).toBe(415);
        const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: publicOrigin }, payload: { password: 'sensitive-wrong-password' } });
        expect(wrong.statusCode).toBe(401);
        expect(wrong.body).not.toContain('sensitive');
        expect(wrong.body).not.toContain(directory);
        expect(wrong.headers['set-cookie']).toBeUndefined();
    });
    it('rotates login session, persists only hashed cookie identity, enforces expiry/logout/restart', async () => {
        let now = Date.now();
        const { app, directory, auth } = await apiFixture({ now: () => now });
        const first = await login(app);
        expect(first.result.headers['set-cookie']).toMatch(/HttpOnly; Secure; SameSite=Strict/);
        expect(first.cookie).toMatch(/^__Host-hsi_session=[a-f0-9]{64}$/);
        expect((await app.inject({ url: '/api/me', headers: { cookie: first.cookie } })).json()).toMatchObject({ role: 'admin', csrfToken: first.csrfToken });
        const second = await login(app, first.cookie);
        expect(second.cookie).not.toBe(first.cookie);
        expect((await app.inject({ url: '/api/me', headers: { cookie: first.cookie } })).statusCode).toBe(401);
        const files = await readdir(join(directory, 'auth/sessions'));
        expect(files).toHaveLength(1);
        const content = await readFile(join(directory, 'auth/sessions', files[0]!), 'utf8');
        expect(content).not.toContain(second.cookie.split('=')[1]);
        expect(content).not.toContain(fixturePassword);
        expect(content).not.toContain(auth.passwordHash);
        expect((await stat(join(directory, 'auth/sessions', files[0]!))).mode & 0o777).toBe(0o600);
        const restarted = buildApp(directory, { auth, now: () => now });
        try {
            expect((await restarted.inject({ url: '/api/me', headers: { cookie: second.cookie } })).statusCode).toBe(200);
        }
        finally {
            await restarted.close();
        }
        const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: second.headers });
        expect(logout.statusCode).toBe(204);
        expect(logout.headers['set-cookie']).toContain('Max-Age=0');
        expect((await app.inject({ url: '/api/me', headers: second.headers })).statusCode).toBe(401);
        const third = await login(app);
        now += 8 * 3600000 + 1;
        expect((await app.inject({ url: '/api/me', headers: third.headers })).statusCode).toBe(401);
    });
    it('rejects forged, duplicate and corrupted sessions; config rotation revokes old sessions', async () => {
        const { app, directory, auth } = await apiFixture();
        const session = await login(app);
        for (const cookie of ['__Host-hsi_session=../../private', '__Host-hsi_session=' + '0'.repeat(64), session.cookie + '; ' + session.cookie])
            expect((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
        const nextApp = buildApp(directory, { auth: { ...auth, passwordHash: await hashPassword('different-synthetic-password') } });
        try {
            expect((await nextApp.inject({ url: '/api/me', headers: session.headers })).statusCode).toBe(401);
        }
        finally {
            await nextApp.close();
        }
        const filename = (await readdir(join(directory, 'auth/sessions')))[0]!;
        await writeFile(join(directory, 'auth/sessions', filename), '{}');
        expect((await app.inject({ url: '/api/me', headers: session.headers })).statusCode).toBe(401);
    });
    it.each(['missing', 'wrong', 'origin', 'cross-site'] as const)('rejects authenticated write with %s CSRF/Origin', async (mode) => {
        const { app } = await apiFixture();
        const session = await login(app);
        const headers: Record<string, string> = { ...session.headers };
        if (mode === 'missing')
            delete headers['x-csrf-token'];
        if (mode === 'wrong')
            headers['x-csrf-token'] = '0'.repeat(64);
        if (mode === 'origin')
            headers.origin = 'https://evil.example.com';
        if (mode === 'cross-site')
            headers['sec-fetch-site'] = 'cross-site';
        const result = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: {} });
        expect(result.statusCode).toBe(403);
        expect((await app.inject({ url: '/api/projects', headers: session.headers })).json().items).toEqual([]);
    });
    it('persists rate limits across restart, ignores spoofed XFF and resets after bounded windows', async () => {
        let now = Date.now();
        const { app, directory, auth } = await apiFixture({ now: () => now });
        for (let n = 0; n < 5; n++)
            expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: publicOrigin, 'x-forwarded-for': '93.184.216.' + n }, payload: { password: 'wrong' } })).statusCode).toBe(401);
        const blocked = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: publicOrigin }, payload: { password: fixturePassword } });
        expect(blocked.statusCode).toBe(429);
        expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
        const restarted = buildApp(directory, { auth, now: () => now });
        try {
            expect((await restarted.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: publicOrigin }, payload: { password: fixturePassword } })).statusCode).toBe(429);
        }
        finally {
            await restarted.close();
        }
        now += 300001;
        expect((await login(app)).cookie).toBeTruthy();
        const disk = await readFile(join(directory, 'auth/rate.json'), 'utf8');
        expect(disk).not.toContain('127.0.0.1');
        expect(disk).not.toContain(fixturePassword);
    }, 10000);
    it('caps disk sessions to32 and rejects the evicted oldest bearer', async () => {
        const { directory } = await apiFixture();
        let now = Date.now();
        const store = new FileAuthStore(directory, 'a'.repeat(64), () => now++);
        const first = await store.create();
        for (let n = 0; n < 32; n++)
            await store.create();
        expect((await readdir(join(directory, 'auth/sessions')))).toHaveLength(32);
        expect(await store.get(first.token)).toBeUndefined();
    });
});
