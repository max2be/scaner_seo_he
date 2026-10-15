import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
async function freePort() {
  const server = createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const dir = await mkdtemp(join(tmpdir(), 'hsi-smoke-'));
try {
  for (const service of ['web', 'worker']) {
    const port = await freePort();
    const child = spawn(process.execPath, [`apps/${service}/dist/main.js`], { env: { ...process.env, DATA_DIR: dir, HOST: '127.0.0.1', PORT: String(port) }, stdio: 'ignore' });
    const exited = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', () => resolve({ code: 1 })); });
    try {
      let ready = false;
      for (let i = 0; i < 50; i++) {
        if (child.exitCode !== null) throw new Error(`${service} exited before readiness`);
        try { const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }); ready = response.ok && (await response.json()).status === 'ok'; } catch { /* startup pending */ }
        if (ready) break; await delay(100);
      }
      if (!ready) throw new Error(`${service} failed readiness`);
      const denied = await fetch(`http://127.0.0.1:${port}/api/projects`);
      if (denied.status !== 401) throw new Error(`${service} exposes private endpoint`);
      child.kill('SIGTERM');
      const outcome = await Promise.race([exited, delay(5000, { code: 'timeout' })]);
      if (outcome.code !== 0) throw new Error(`${service} shutdown failed`);
      console.log(`${service}: health ok, private API 401, graceful shutdown ok`);
    } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await exited; } }
  }
} finally { await rm(dir, { recursive: true, force: true }); }
