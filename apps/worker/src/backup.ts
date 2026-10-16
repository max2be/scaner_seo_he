import { parseArgs } from 'node:util';
import { createBackup, restoreBackup } from '@hsi/storage';
try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: 'string' },
      target: { type: 'string' },
      offline: { type: 'boolean', default: false },
    },
  });
  if (
    positionals.length !== 1 ||
    !['create', 'restore'].includes(positionals[0]!) ||
    !values.source ||
    !values.target ||
    !values.offline
  )
    throw new Error('invalid_backup_arguments');
  const execute = positionals[0] === 'create' ? createBackup : restoreBackup;
  const result = await execute(values.source, values.target, { offline: values.offline });
  console.log(
    JSON.stringify({
      event: positionals[0] === 'create' ? 'backup_created' : 'backup_restored',
      files: result.files,
      bytes: result.bytes,
      authExcluded: true,
    }),
  );
} catch {
  console.error(
    JSON.stringify({ event: 'backup_failed', code: 'check_offline_paths_permissions_and_integrity' }),
  );
  process.exitCode = 1;
}
