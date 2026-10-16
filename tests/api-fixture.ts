import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { ProjectConfigSchema } from '@hsi/contracts';
import { buildApp, type WebOptions } from '../apps/web/src/app.js';
import { hashPassword } from '../apps/web/src/password-hash.js';
export const fixturePassword = 'synthetic-password-for-api-tests';
export const publicOrigin = 'https://inspector.example.com';
let encoded: Promise<string> | undefined;
const resources: {
    directory: string;
    app: FastifyInstance;
}[] = [];
export async function passwordHash() {
    return encoded ??= hashPassword(fixturePassword);
}
export async function apiFixture(options: Omit<WebOptions, 'auth'> = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'hsi-api-'));
    const auth = { passwordHash: await passwordHash(), publicOrigin };
    const app = buildApp(directory, { ...options, auth });
    await app.ready();
    resources.push({ directory, app });
    return { directory, app, auth };
}
export async function cleanupApiFixtures() {
    for (const resource of resources.splice(0)) {
        await resource.app.close();
        await rm(resource.directory, { recursive: true, force: true });
    }
}
export async function login(app: FastifyInstance, previousCookie?: string) {
    const result = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: publicOrigin, ...(previousCookie ? { cookie: previousCookie } : {}) }, payload: { password: fixturePassword } });
    if (result.statusCode !== 200)
        throw new Error('fixture_login_failed:' + result.statusCode);
    const cookie = String(result.headers['set-cookie']).split(';')[0]!;
    const csrfToken = result.json().csrfToken as string;
    return { cookie, csrfToken, headers: { cookie, origin: publicOrigin, 'x-csrf-token': csrfToken }, result };
}
export async function client(app: FastifyInstance) {
    const auth = await login(app);
    return { ...auth, request: (method: HTTPMethods, url: string, payload?: object, headers?: Record<string, string>) => app.inject({ method, url, headers: { ...auth.headers, ...headers }, ...(payload ? { payload } : {}) }) };
}
export async function apiProject(id = 'api-project') {
    const project = ProjectConfigSchema.parse(JSON.parse(await readFile('docs/examples/project.example.json', 'utf8')));
    return ProjectConfigSchema.parse({ ...project, id, sources: {}, discovery: { ...project.discovery, seedUrls: [], sitemapUrls: [] } });
}
