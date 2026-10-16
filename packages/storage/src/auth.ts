import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { z } from 'zod';
import { SessionFileSchema, type SessionFile } from '@hsi/contracts';
import { FileLease } from './locks.js';
import { atomicJson } from './atomic.js';
import { isMissing, readSmallJson, safeDataPath } from './safe-files.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenPattern = /^[a-f0-9]{64}$/;
const RateSchema = z.object({ schemaVersion: z.literal('1.0'), global: z.object({ count: z.number().int().nonnegative(), resetAt: z.number().int().nonnegative() }).strict(),
    clients: z.array(z.object({ id: z.string().regex(tokenPattern), count: z.number().int().nonnegative(), resetAt: z.number().int().nonnegative() }).strict()).max(2048),
}).strict();
/** Single-admin, absolute8h sessions. Cookie bearer tokens are never stored on disk. */
export class FileAuthStore {
    constructor(readonly root: string, readonly authVersion: string, readonly now: () => number = Date.now) {
    }
    private async locked<T>(fn: () => Promise<T>) {
        await mkdir(await safeDataPath(this.root, 'auth'), { recursive: true, mode: 0o700 });
        const lease = await FileLease.acquire(await safeDataPath(this.root, 'auth', 'auth.lock'));
        lease.onLost(() => process.exit(1));
        try {
            lease.assertHeld();
            return await fn();
        }
        finally {
            await lease.release();
        }
    }
    async attempt(ip: string): Promise<number> {
        return this.locked(async () => {
            const time = this.now();
            let state: z.infer<typeof RateSchema>;
            try {
                state = RateSchema.parse(await readSmallJson(this.root, ['auth', 'rate.json']));
            }
            catch (e) {
                if (!isMissing(e))
                    throw e;
                state = { schemaVersion: '1.0', global: { count: 0, resetAt: time + 60000 }, clients: [] };
            }
            if (state.global.resetAt <= time)
                state.global = { count: 0, resetAt: time + 60000 };
            state.clients = state.clients.filter(c => c.resetAt > time);
            const id = hash(ip);
            let client = state.clients.find(c => c.id === id);
            if (!client) {
                if (state.clients.length >= 2048)
                    return 60;
                client = { id, count: 0, resetAt: time + 300000 };
                state.clients.push(client);
            }
            const retry = state.global.count >= 20 ? state.global.resetAt - time : client.count >= 5 ? client.resetAt - time : 0;
            if (!retry) {
                state.global.count++;
                client.count++;
            }
            await atomicJson(await safeDataPath(this.root, 'auth', 'rate.json'), state);
            return Math.max(0, Math.ceil(retry / 1000));
        });
    }
    async get(token: string | undefined): Promise<SessionFile | undefined> {
        if (!token || !tokenPattern.test(token))
            return;
        try {
            const session = SessionFileSchema.parse(await readSmallJson(this.root, ['auth', 'sessions', hash(token) + '.json'], 4096));
            if (session.idHash !== hash(token) || session.authVersion !== this.authVersion || Date.parse(session.expiresAt) <= this.now())
                return;
            return session;
        }
        catch (e) {
            if (isMissing(e) || e instanceof z.ZodError || e instanceof SyntaxError)
                return;
            throw e;
        }
    }
    async create(previous?: string) {
        return this.locked(async () => {
            const parent = await safeDataPath(this.root, 'auth', 'sessions');
            await mkdir(parent, { recursive: true, mode: 0o700 });
            const sessions: SessionFile[] = [];
            for (const name of await readdir(parent)) {
                if (!/^[a-f0-9]{64}\.json$/.test(name))
                    continue;
                const stored = SessionFileSchema.safeParse(await readSmallJson(this.root, ['auth', 'sessions', name], 4096));
                if (!stored.success || stored.data.authVersion !== this.authVersion || Date.parse(stored.data.expiresAt) <= this.now())
                    await rm(await safeDataPath(this.root, 'auth', 'sessions', name));
                else
                    sessions.push(stored.data);
            }
            sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            for (const old of sessions.slice(0, Math.max(0, sessions.length - 31)))
                await rm(await safeDataPath(this.root, 'auth', 'sessions', old.idHash + '.json'), { force: true });
            if (previous && tokenPattern.test(previous))
                await rm(await safeDataPath(this.root, 'auth', 'sessions', hash(previous) + '.json'), { force: true });
            const token = randomBytes(32).toString('hex');
            const time = this.now();
            const session = SessionFileSchema.parse({ schemaVersion: '1.0', role: 'admin', idHash: hash(token), csrfToken: randomBytes(32).toString('hex'), authVersion: this.authVersion, createdAt: new Date(time).toISOString(), expiresAt: new Date(time + 8 * 3600000).toISOString() });
            await atomicJson(await safeDataPath(this.root, 'auth', 'sessions', session.idHash + '.json'), session);
            return { token, session };
        });
    }
    async remove(token: string | undefined) {
        if (token && tokenPattern.test(token))
            await this.locked(async () => {
                await rm(await safeDataPath(this.root, 'auth', 'sessions', hash(token) + '.json'), { force: true });
            });
    }
}
