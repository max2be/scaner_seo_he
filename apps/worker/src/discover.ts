import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { ProjectConfigSchema } from '@hsi/contracts';
import { discover } from '@hsi/sources';
import { FileDiscoveryStore, FileResponseSpool } from '@hsi/storage';
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
try {
  const { values } = parseArgs({ options: { project: { type: 'string' }, output: { type: 'string' } }, strict: true });
  if (!values.project || !values.output) throw new Error('missing_arguments');
  const project = ProjectConfigSchema.parse(JSON.parse(await readFile(values.project, 'utf8')));
  const store = await FileDiscoveryStore.create(values.output);
  try {
    const result = await discover(project, { store, signal: controller.signal,
      createSpool: () => FileResponseSpool.create(store.directory), onPage: (record, page) => store.recordPage(record, page) });
    console.log(JSON.stringify({ directory: store.directory, ...result }));
    process.exitCode = result.discoveryComplete ? 0 : 2;
  } finally { await store.close(); }
} catch {
  console.error(JSON.stringify({ error: 'discovery_failed', hint: 'Validate project/output arguments, permissions, configuration and credential presence; values are never logged.' }));
  process.exitCode = 1;
}
