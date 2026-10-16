import { spawn, execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
const execute = promisify(execFile);
const { values } = parseArgs({ options: { sizes: { type: 'string', default: '10000,100000' }, output: { type: 'string' }, storage: { type: 'string', default: 'disk' } } });
const sizes = values.sizes.split(',').map(Number);
if (!sizes.length || new Set(sizes).size !== sizes.length || sizes.some(n => ![10000, 100000].includes(n))) throw Error('use_sizes_10000_100000');
if (!['disk', 'docker-tmpfs'].includes(values.storage)) throw Error('use_storage_disk_or_docker_tmpfs');
if (values.output) {
  try { await lstat(values.output); throw Error('output_exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const runs = [];
for (const count of sizes) {
  const docker = values.storage === 'docker-tmpfs';
  const name = 'hsi-pipeline-' + randomUUID();
  const args = docker ? ['run', '--rm', '--no-healthcheck', '--name', name, '--init', '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '4g', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=3g',
    '--mount', `type=bind,source=${resolve('scripts/fixtures')},target=/app/scripts/fixtures,readonly`,
    '--mount', `type=bind,source=${resolve('docs/examples')},target=/app/docs/examples,readonly`,
    'hsi:0.1.0', 'node', '--max-old-space-size=128', 'scripts/fixtures/pipeline-load.mjs', String(count), 'docker-tmpfs'] : ['--max-old-space-size=128', 'scripts/fixtures/pipeline-load.mjs', String(count)];
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(docker ? 'docker' : process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const stop = () => child.kill('SIGTERM');
      const timer = setTimeout(stop, 3600000);
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      const clear = () => { clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); };
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 16384) child.kill('SIGTERM'); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); process.stderr.write(chunk); });
      child.once('error', error => { clear(); reject(error); });
      child.once('close', code => { clear(); if (code !== 0) reject(Error('pipeline_failed_' + code + ': ' + stderr.slice(-2000) + '; completedMetrics=' + stdout.slice(0, 16000))); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } });
    });
    runs.push(result); console.log(JSON.stringify(result));
  } finally { if (docker) await execute('docker', ['rm', '-f', name], { env: process.env }).catch(() => {}); }
}
if (values.output) await writeFile(values.output, JSON.stringify({ schemaVersion: '1.0', runs }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
