import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { ProjectConfigSchema, defaultRuleProfile } from '@hsi/contracts';
import { validateRuleProfile } from '@hsi/core';
import { ScanRepository, StorageConflict } from '@hsi/storage';
import { assertRuleProfileForProject } from './analysis.js';
import { runScan, workOnce } from './jobs.js';
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
try {
  const { values } = parseArgs({ options: { action: { type: 'string', default: 'start' }, data: { type: 'string' },
    project: { type: 'string' }, rules: { type: 'string' }, 'project-id': { type: 'string' }, 'scan-id': { type: 'string' },
    concurrency: { type: 'string', default: '2' }, keep: { type: 'string' }, days: { type: 'string' }, export: { type: 'string' } }, strict: true });
  if (!values.data) throw new Error('missing_data');
  const repo = new ScanRepository(values.data, Number(values.concurrency)); let result: unknown;
  if (values.action === 'start' || values.action === 'enqueue') {
    if (!values.project) throw new Error('missing_project');
    const project = ProjectConfigSchema.parse(JSON.parse(await readFile(values.project, 'utf8')));
    const profile = values.rules ? validateRuleProfile(JSON.parse(await readFile(values.rules, 'utf8'))) : defaultRuleProfile();
    assertRuleProfileForProject(project, profile);
    const manifest = await repo.enqueue(project, values['scan-id'], profile);
    result = values.action === 'enqueue' ? manifest : await runScan(repo, project.id, manifest.scanId, { signal: controller.signal });
  } else if (values.action === 'work') { await workOnce(repo, controller.signal); result = { event: 'work_complete' }; }
  else {
    const projectId = values['project-id']; if (!projectId) throw new Error('missing_project_id');
    if (values.action === 'retention') {
      if (!values.keep || !values.export) throw new Error('missing_retention_policy');
      result = { removed: await repo.retain(projectId, { keep: Number(values.keep), ...(values.days ? { days: Number(values.days) } : {}), exportTo: values.export }) };
    } else {
      const scanId = values['scan-id']; if (!scanId) throw new Error('missing_scan_id');
      if (values.action === 'resume') result = await runScan(repo, projectId, scanId, { resume: true, signal: controller.signal });
      else if (values.action === 'status') result = await repo.manifest(projectId, scanId);
      else if (values.action === 'cancel') { await repo.requestCancel(projectId, scanId); result = { event: 'cancel_requested' }; }
      else throw new Error('unknown_action');
    }
  }
  console.log(JSON.stringify(result));
  if (result && typeof result === 'object' && 'status' in result && ['incomplete', 'interrupted', 'canceled'].includes(String(result.status))) process.exitCode = 2;
  if (result && typeof result === 'object' && 'status' in result && result.status === 'failed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof StorageConflict ? error.code : 'scan_command_failed', statusCode: error instanceof StorageConflict ? 409 : 500 }));
  process.exitCode = error instanceof StorageConflict ? 3 : 1;
}
