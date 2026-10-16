import { mkdir, writeFile, symlink, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { apiFixture, cleanupApiFixtures } from './api-fixture.js';
const directories: string[] = [];
afterEach(async () => {
  await cleanupApiFixtures();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function uiFixture() {
  const uiDirectory = await mkdtemp(join(tmpdir(), 'hsi-ui-static-'));
  directories.push(uiDirectory);
  await mkdir(join(uiDirectory, 'assets'));
  await writeFile(
    join(uiDirectory, 'index.html'),
    '<!doctype html><title>HSI login</title><script src="/assets/index-test.js" type="module"></script>',
  );
  await writeFile(join(uiDirectory, 'assets/index-test.js'), 'document.title="HSI";');
  await writeFile(join(uiDirectory, 'assets/index-test.css'), 'body{color:#123}');
  await writeFile(join(uiDirectory, 'assets/hidden.map'), 'private-source-map');
  await symlink(join(uiDirectory, 'index.html'), join(uiDirectory, 'assets/linked.js'));
  return apiFixture({ uiDirectory });
}
describe('Public login shell and exact static asset boundary', () => {
  it('serves login shell/JS/CSS and HEAD without exposing protected data; CSP accepts only local resources', async () => {
    const { app } = await uiFixture();
    for (const url of ['/', '/assets/index-test.js', '/assets/index-test.css']) {
      const result = await app.inject({ url });
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.headers['content-security-policy']).toContain("script-src 'self'");
      expect(result.headers['content-security-policy']).not.toContain('unsafe-inline');
      expect(result.body).not.toContain('csrfToken');
      const head = await app.inject({ method: 'HEAD', url });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
    }
    expect((await app.inject({ url: '/' })).headers['content-type']).toContain('text/html');
    expect((await app.inject({ url: '/assets/index-test.js' })).headers['content-type']).toContain(
      'javascript',
    );
    for (const url of [
      '/api/projects',
      '/assets/hidden.map',
      '/assets/missing.js',
      '/data/project.json',
      '/assets/..%2f..%2fpackage.json',
    ])
      expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/', payload: {} })).statusCode).toBe(401);
  });
  it('fails closed for missing builds and linked files without revealing paths', async () => {
    const { app } = await uiFixture();
    expect((await app.inject({ url: '/assets/linked.js' })).json()).toEqual({ error: 'ui_unavailable' });
    const missing = await apiFixture({ uiDirectory: '/tmp/hsi-build-does-not-exist' });
    const response = await missing.app.inject({ url: '/' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'ui_unavailable' });
    expect((await missing.app.inject({ url: '/api/projects' })).statusCode).toBe(401);
  });
});
