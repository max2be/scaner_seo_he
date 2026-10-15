import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp as web } from '../apps/web/src/app.js';
import { buildApp as worker } from '../apps/worker/src/app.js';
import { checkDataDirectory } from '@hsi/storage';
const directories: string[] = [];
async function temporary() { const path = await mkdtemp(join(tmpdir(), 'hsi-test-')); directories.push(path); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('M0 service boundaries', () => {
  it.each([['web', web], ['worker', worker]] as const)('%s health checks writable storage and closes private routes', async (_name, create) => {
    const app = create(await temporary());
    try {
      const health = await app.inject({ url: '/api/health' });
      expect(health.statusCode).toBe(200); expect(health.json()).toEqual({ status: 'ok' });
      expect(health.headers['cache-control']).toBe('no-store');
      for (const url of ['/', '/api/projects', '/api/projects/demo/scans/a/download/html', '/data/projects/demo/project.json']) {
        const result = await app.inject({ url }); expect(result.statusCode).toBe(401);
        expect(result.json()).toEqual({ error: 'authentication_required' });
      }
    } finally { await app.close(); }
  });
  it('reports storage failure without disclosing filesystem paths', async () => {
    const dir = await temporary(); const file = join(dir, 'not-a-directory'); await writeFile(file, 'private');
    const app = web(file);
    try { const result = await app.inject({ url: '/api/health' }); expect(result.statusCode).toBe(503); expect(result.json()).toEqual({ status: 'unavailable' }); }
    finally { await app.close(); }
  });
  it('readiness does not modify existing files or leave probe files behind', async () => {
    const dir = await temporary(); await writeFile(join(dir, 'project.json'), 'existing');
    await Promise.all(Array.from({ length: 10 }, () => checkDataDirectory(dir)));
    expect(await readdir(dir)).toEqual(['project.json']); expect(await readFile(join(dir, 'project.json'), 'utf8')).toBe('existing');
  });
});
