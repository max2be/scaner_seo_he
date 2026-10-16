import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
it('runs the built API/Argon2/session/worker/export pipeline over real local HTTP sockets', () => {
  const result = spawnSync(process.execPath, ['scripts/smoke-api.mjs'], { encoding: 'utf8', timeout: 20000, maxBuffer: 16000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout); expect(output).toMatchObject({ argon2id: true, csrf: true, duplicate409: true, workerResume: true, authorizedExports: true, logoutRevoked: true, noExternalTargets: true });
  expect(result.stdout).not.toMatch(/password|idHash|csrfToken|Bearer/);
});
it('fails startup closed on invalid configured credentials without logging supplied values', () => {
  const result = spawnSync(process.execPath, ['apps/web/dist/main.js'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, ADMIN_PASSWORD_HASH: 'private-invalid-hash-fixture', PUBLIC_ORIGIN: 'https://inspector.example.com' } });
  expect(result.status).toBe(1); expect(result.stderr).toContain('startup_failed'); expect(result.stderr).not.toContain('private-invalid-hash-fixture');
});
it('hashes passwords through the built stdin CLI and rejects oversized input without echoing it', () => {
  const password = 'synthetic-cli-password';
  const valid = spawnSync(process.execPath, ['apps/web/dist/password.js'], { encoding: 'utf8', input: password + '\n', timeout: 5000 });
  expect(valid.status).toBe(0); expect(valid.stdout.trim()).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/); expect(valid.stdout).not.toContain(password);
  const invalid = spawnSync(process.execPath, ['apps/web/dist/password.js'], { encoding: 'utf8', input: 'sensitive-fixture'.repeat(100), timeout: 5000 });
  expect(invalid.status).toBe(1); expect(invalid.stderr).not.toContain('sensitive-fixture'); expect(invalid.stdout).toBe('');
});
