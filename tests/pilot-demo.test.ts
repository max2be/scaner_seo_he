import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectConfigSchema } from '@hsi/contracts';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function execute(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/demo.mjs', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('demo_timeout')); }, 25000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
it('AC-04/05/06/09…19/27/28: same binary completes two sites, stable reruns and release diff, with durable evidence', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'hsi-demo-acceptance-')); roots.push(parent);
  const output = join(parent, 'new-demo');
  const result = await execute(['--output', output]);
  expect(result.stderr).toBe(''); expect(result.code).toBe(0);
  const summary = JSON.parse(result.stdout);
  expect(summary).toMatchObject({ sites: 2, scans: 8, productionRequests: 0, transport: 'disposable-http-and-trusted-tls', diff: { new: 0, unknown: 0 } });
  expect(summary.diff.resolved).toBeGreaterThanOrEqual(2);
  expect(summary.passed).toBe(summary.checks.length);
  expect(summary.checks).toEqual(expect.arrayContaining(['stable_finding_ids', 'published_missing_confirmed_p0', 'deleted_no_p0', 'robots_not_requested', 'redirect_chain_preserved', 'malformed_xml_incomplete', 'limit_incomplete', 'loop_bounded_and_diagnosed', 'no_auth_or_raw_html']));
  expect(JSON.parse(await readFile(join(output, 'acceptance.json'), 'utf8'))).toEqual(summary);
  const shop = ProjectConfigSchema.parse(JSON.parse(await readFile(join(output, 'data/projects/demo-shop/project.json'), 'utf8')));
  const content = ProjectConfigSchema.parse(JSON.parse(await readFile(join(output, 'data/projects/demo-content/project.json'), 'utf8')));
  expect(shop.allowedHosts).not.toEqual(content.allowedHosts);
  expect(shop.sources.backend?.enabled).toBe(true); expect(content.sources.backend?.enabled).not.toBe(true);
}, 30000);
it('demo refuses to overwrite an existing output and preserves its contents', async () => {
  const output = await mkdtemp(join(tmpdir(), 'hsi-demo-existing-')); roots.push(output);
  await writeFile(join(output, 'keep'), 'operator file');
  const result = await execute(['--output', output]);
  expect(result.code).not.toBe(0);
  expect(await readFile(join(output, 'keep'), 'utf8')).toBe('operator file');
});
