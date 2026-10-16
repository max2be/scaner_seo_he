import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ProjectConfigSchema, defaultRuleProfile } from '@hsi/contracts';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function input(rules: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'hsi-rules-cli-')); roots.push(root);
  const project = ProjectConfigSchema.parse(JSON.parse(await readFile('docs/examples/project.example.json', 'utf8')));
  project.sources = {}; project.discovery.seedUrls = []; project.discovery.sitemapUrls = [];
  const projectFile = join(root, 'project.json'); const rulesFile = join(root, 'rules.json'); const data = join(root, 'data');
  await writeFile(projectFile, JSON.stringify(project)); await writeFile(rulesFile, JSON.stringify(rules));
  const result = spawnSync(process.execPath, ['apps/worker/dist/scan.js', '--action', 'start', '--data', data, '--project', projectFile, '--rules', rulesFile, '--scan-id', 'cli'], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  if (result.error) throw result.error; return { result, data, project };
}
describe('Built production CLI analysis profile', () => {
  it('accepts --rules, freezes the validated profile and writes analysis1.1 without target requests', async () => {
    const rules = { ...defaultRuleProfile(), checkTrailingSlash: false, severityOverrides: { DESCRIPTION_MISSING: 'INFO' as const } };
    const { result, data, project } = await input(rules); expect(result.status).toBe(2); expect(JSON.parse(result.stdout).status).toBe('incomplete');
    const directory = join(data, 'projects', project.id, 'scans', 'cli');
    expect(JSON.parse(await readFile(join(directory, 'rules.json'), 'utf8'))).toEqual(rules);
    expect(JSON.parse(await readFile(join(directory, 'checkpoint.json'), 'utf8'))).toMatchObject({ schemaVersion: '1.1', analysis: { phase: 'done' } });
    expect(JSON.parse(await readFile(join(directory, 'analysis-summary.json'), 'utf8'))).toMatchObject({ urlsAnalyzed: 0, coverageComplete: false });
  });
  it('rejects unknown override IDs before enqueue and does not echo supplied values', async () => {
    const { result, data } = await input({ ...defaultRuleProfile(), severityOverrides: { TYPO: 'P0' }, secret: 'sensitive-fixture-value' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('scan_command_failed'); expect(result.stderr).not.toContain('sensitive-fixture-value');
    await expect(stat(join(data, 'projects'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects an unknown-route probe outside project allowlist before network or enqueue', async () => {
    const { result, data } = await input({ ...defaultRuleProfile(), unknownRouteProbes: [{ url: 'https://elsewhere.example.org/control' }] });
    expect(result.status).toBe(1); expect(result.stderr).not.toContain('elsewhere.example.org');
    await expect(stat(join(data, 'projects'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
