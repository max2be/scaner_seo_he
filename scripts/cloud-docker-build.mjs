// Cloud-only build adapter: proxy variables are inherited, never printed or saved.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lookup } from 'node:dns/promises';
const directory = await mkdtemp(join(tmpdir(), 'hsi-build-'));
try {
  const source = process.env.SSL_CERT_FILE || process.env.NODE_EXTRA_CA_CERTS;
  if (!source) throw new Error('Cloud public CA bundle is not configured');
  const ca = join(directory, 'ca.pem');
  await writeFile(ca, await readFile(source), { mode: 0o600 });
  const config = process.env.DOCKER_CONFIG || '/workspace/.docker-hsi';
  await mkdir(config, { recursive: true });
  const override = join(directory, 'build.yaml');
  const hosts = {};
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY']) {
    if (process.env[name]) {
      const host = new URL(process.env[name]).hostname;
      hosts[host] = (await lookup(host, { family: 4 })).address;
    }
  }
  const extraHosts = `      extra_hosts: ${JSON.stringify(hosts)}\n`;
  const build = '    build:\n      network: host\n' + extraHosts + '      args:\n        HTTP_PROXY:\n        HTTPS_PROXY:\n        NO_PROXY:\n      secrets: [cloud_ca]\n';
  await writeFile(override, `services:\n  inspector-web:\n${build}  inspector-worker:\n${build}secrets:\n  cloud_ca:\n    file: ${ca}\n`);
  const child = spawn('docker', ['compose', '-f', 'deploy/compose.yaml', '-f', override, 'build'], {
    env: { ...process.env, DOCKER_CONFIG: config }, stdio: 'inherit',
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
} finally { await rm(directory, { recursive: true, force: true }); }
