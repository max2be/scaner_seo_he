// Local synthetic TLS proxy acceptance. No operator data, credentials or real targets.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { hashPassword } from '../apps/web/dist/password-hash.js';
const execute = promisify(execFile);
const docker = async (args) =>
  (
    await execute('docker', args, {
      env: process.env,
      maxBuffer: 1048576,
    })
  ).stdout.trim();
const prefix = 'hsi-tls-' + randomUUID().slice(0, 12);
const directory = await mkdtemp(join(tmpdir(), prefix));
const network = prefix + '-network',
  web = prefix + '-web',
  proxy = prefix + '-proxy',
  image = prefix + ':fixture';
const cert = await readFile('tests/fixtures/tls/fixture.crt');
const password = 'synthetic-proxy-password-only';
const flags = [
  '--user',
  '1000:1000',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--read-only',
  '--tmpfs',
  '/tmp:rw,nosuid,nodev,size=64m',
];
function assert(value, message) {
  if (!value) throw new Error(message);
}
try {
  const compose = await readFile('deploy/compose.tls.yaml', 'utf8');
  const base = compose.match(/image: (nginx:[^\s]+)/)?.[1];
  assert(/^nginx:[\w.-]+@sha256:[a-f0-9]{64}$/.test(base ?? ''), 'proxy_image_not_pinned');
  await writeFile(
    join(directory, 'nginx.conf'),
    (await readFile('deploy/nginx.conf', 'utf8')).replaceAll('inspector.example.com', 'shop.example.com'),
  );
  await writeFile(join(directory, 'cert.pem'), cert);
  await writeFile(join(directory, 'key.pem'), await readFile('tests/fixtures/tls/fixture.key'));
  await writeFile(
    join(directory, 'Dockerfile'),
    `FROM ${base}\nCOPY --chown=1000:1000 nginx.conf /etc/nginx/nginx.conf\nCOPY --chown=1000:1000 key.pem /etc/hsi/tls/key.pem\nCOPY --chown=1000:1000 cert.pem /etc/hsi/tls/cert.pem\nRUN chown -R 1000:1000 /etc/hsi && chmod 0700 /etc/hsi /etc/hsi/tls && chmod 0400 /etc/hsi/tls/key.pem && chmod 0444 /etc/hsi/tls/cert.pem\nENTRYPOINT ["nginx"]\nCMD ["-g","daemon off;"]\n`,
  );
  await docker(['build', '-t', image, directory]);
  await docker(['network', 'create', network]);
  await docker([
    'run',
    '-d',
    '--name',
    web,
    '--network',
    network,
    '--network-alias',
    'inspector-web',
    ...flags,
    '-e',
    'DATA_DIR=/tmp/data',
    '-e',
    'HOST=0.0.0.0',
    '-e',
    'PUBLIC_ORIGIN=https://shop.example.com',
    '-e',
    'ADMIN_PASSWORD_HASH=' + (await hashPassword(password)),
    'hsi:0.1.0',
    'node',
    'apps/web/dist/main.js',
  ]);
  await docker(['run', '--rm', '--network', network, ...flags, image, '-t']);
  await docker([
    'run',
    '-d',
    '--name',
    proxy,
    '--network',
    network,
    ...flags,
    '-p',
    '127.0.0.1::8443',
    image,
  ]);
  const port = Number((await docker(['port', proxy, '8443/tcp'])).match(/:(\d+)$/)?.[1]);
  assert(port, 'proxy_port_missing');
  function call(path, method = 'GET', body, headers = {}, servername = 'shop.example.com') {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          host: '127.0.0.1',
          port,
          servername,
          ca: cert,
          path,
          method,
          headers: {
            Host: 'shop.example.com',
            ...(data === undefined
              ? {}
              : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
            ...headers,
          },
          timeout: 5000,
        },
        (res) => {
          let response = '';
          res.on('data', (chunk) => {
            response += chunk;
            if (response.length > 2097152) req.destroy(new Error('fixture_response_limit'));
          });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: response }));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('fixture_timeout')));
      req.end(data);
    });
  }
  let health;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      health = await call('/api/health');
      if (health.status === 200) break;
    } catch {
      /* readiness only */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(health?.status === 200, 'tls_health_failed');
  assert(health.headers['strict-transport-security'] === 'max-age=31536000', 'hsts_missing');
  assert(!/nginx\/\d/.test(health.headers.server ?? ''), 'proxy_version_leaked');
  const root = await call('/');
  assert(
    root.status === 200 && root.headers['content-security-policy'].includes("script-src 'self'"),
    'tls_ui_failed',
  );
  const asset = root.body.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];
  assert(asset && (await call(asset)).status === 200, 'tls_asset_failed');
  assert((await call('/api/projects')).status === 401, 'anonymous_api_open');
  assert(
    (await call('/api/projects/project/scans/scan/download/csv')).status === 401,
    'anonymous_export_open',
  );
  const logged = await call('/api/auth/login', 'POST', { password }, { Origin: 'https://shop.example.com' });
  assert(logged.status === 200, 'tls_login_failed');
  const cookie = logged.headers['set-cookie'][0];
  assert(/HttpOnly; Secure; SameSite=Strict/.test(cookie), 'cookie_not_secure');
  const session = JSON.parse(logged.body),
    cookieHeader = { Cookie: cookie.split(';')[0] };
  assert((await call('/api/me', 'GET', undefined, cookieHeader)).status === 200, 'tls_session_failed');
  assert(
    (await call('/api/auth/logout', 'POST', {}, { ...cookieHeader, Origin: 'https://shop.example.com' }))
      .status === 403,
    'csrf_not_enforced',
  );
  assert(
    (
      await call(
        '/api/auth/logout',
        'POST',
        {},
        { ...cookieHeader, Origin: 'https://shop.example.com', 'X-CSRF-Token': session.csrfToken },
      )
    ).status === 204,
    'tls_logout_failed',
  );
  assert((await call('/api/me', 'GET', undefined, cookieHeader)).status === 401, 'revoked_session_alive');
  let rejected = false;
  try {
    await call('/', 'GET', undefined, {}, 'unapproved.example.com');
  } catch {
    rejected = true;
  }
  assert(rejected, 'unknown_sni_accepted');
  assert(
    (
      await call(
        '/api/auth/login',
        'POST',
        { password: 'x'.repeat(1048576) },
        { Origin: 'https://shop.example.com' },
      )
    ).status === 413,
    'request_body_limit_failed',
  );
  assert((await docker(['exec', proxy, 'id', '-u'])) === '1000', 'proxy_not_nonroot');
  console.log(
    JSON.stringify({
      tlsVerified: true,
      nginxConfig: true,
      nonroot: true,
      hsts: true,
      localAssets: true,
      privateApi401: true,
      secureSession: true,
      csrf: true,
      logoutRevoked: true,
      unknownSniRejected: true,
      bodyLimit: true,
      noExternalTargets: true,
    }),
  );
} finally {
  for (const name of [proxy, web]) await docker(['rm', '-f', name]).catch(() => {});
  await docker(['network', 'rm', network]).catch(() => {});
  await docker(['image', 'rm', image]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
