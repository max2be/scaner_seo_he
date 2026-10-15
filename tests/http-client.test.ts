import { afterEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns';
import http from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpFetchResultSchema } from '@hsi/contracts';
import { SafeHttpClient, retryDelay } from '@hsi/core';
import { createNodeTransport } from '../packages/core/src/http/transport.js';
import { fixture, cleanupFixtures, publicResolver } from './http-fixture.js';
afterEach(cleanupFixtures);
describe('HTTP GET, evidence and redirects / AC-19', () => {
  it('uses GET, preserves Host/UA and returns bounded transient body plus typed evidence', async () => {
    let method; let host; let agent;
    const site = await fixture((req, res) => { method = req.method; host = req.headers.host; agent = req.headers['user-agent']; res.setHeader('content-type', 'text/html'); res.setHeader('set-cookie', 'session=private'); res.end('<h1>Hello</h1>'); });
    const result = await site.client().fetch(`${site.base}/page?email=private@example.org`);
    expect(result.status).toBe('fetched'); expect(result.body?.toString()).toBe('<h1>Hello</h1>');
    if (result.status !== 'fetched') throw new Error('Not fetched');
    expect(result.evidence).toMatchObject({ httpStatus: 200, method: 'GET', contentType: 'text/html', responseBytes: 14 });
    expect(JSON.stringify(result)).not.toContain('Hello');
    expect(result.evidence.htmlExtract).toBeUndefined(); expect(JSON.stringify(result.evidence)).not.toContain('private');
    expect(result.attempts[0]?.bodySha256).toBe(result.evidence.bodySha256);
    expect(HttpFetchResultSchema.safeParse(Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'body'))).success).toBe(true);
    expect(method).toBe('GET'); expect(host).toBe(new URL(site.base).host); expect(agent).toContain('HeadlessSEOInspector');
    expect(site.pins[0]?.address).toBe('93.184.216.34');
  });
  it('does not invoke DNS again when the native connector opens a numeric IP', async () => {
    const site = await fixture((_req, res) => res.end('ok'));
    const spy = vi.spyOn(dns, 'lookup');
    try { expect((await site.client().fetch(site.base)).status).toBe('fetched'); expect(spy).not.toHaveBeenCalled(); }
    finally { spy.mockRestore(); }
  });
  it('rejects a socket peer differing from the pinned address', async () => {
    const site = await fixture((_req, res) => res.end('must not read'));
    const original = http.request;
    const peer = vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions) => {
      const request = original(options);
      request.once('socket', socket => Object.defineProperty(socket, 'remoteAddress', { value: '169.254.169.254' }));
      return request;
    }) as typeof http.request);
    try { expect(await site.client().fetch(site.base)).toMatchObject({ status: 'fetch_error', errorCode: 'peer_address_mismatch' }); }
    finally { peer.mockRestore(); }
  });
  it('retains a 301/308 chain and resolves relative Location', async () => {
    const site = await fixture((req, res) => { if (req.url === '/a') { res.writeHead(301, { location: '/b' }); res.end(); } else if (req.url === '/b') { res.writeHead(308, { location: 'c' }); res.end(); } else res.end('ok'); });
    const result = await site.client().fetch(`${site.base}/a`);
    expect(result).toMatchObject({ status: 'fetched', redirectChain: [{ status: 301 }, { status: 308 }] });
    if (result.status === 'fetched') expect(result.evidence.responseUrl).toBe(`${site.base}/c`);
  });
  it('stops redirect loops and maxRedirects with chain evidence', async () => {
    const site = await fixture((req, res) => { res.writeHead(302, { location: req.url === '/a' ? '/b' : '/a' }); res.end(); });
    expect(await site.client().fetch(`${site.base}/a`)).toMatchObject({ status: 'fetch_error', errorCode: 'redirect_loop', redirectChain: [{ status: 302 }, { status: 302 }] });
    expect(await site.client({ maxRedirects: 0 }).fetch(`${site.base}/a`)).toMatchObject({ status: 'fetch_error', errorCode: 'max_redirects' });
  });
  it.each(['http://127.0.0.1/private', 'http://[::1]/private', 'http://169.254.169.254/meta', 'https://other.example.org/private', 'https://u:p@shop.example.com/'])('blocks redirect %s before connection', async location => {
    let hits = 0; const site = await fixture((_req, res) => { hits++; res.writeHead(302, { location }); res.end(); });
    expect((await site.client().fetch(`${site.base}/a`)).status).toBe('fetch_error'); expect(hits).toBe(1);
  });
  it('revalidates DNS on every redirect and rejects a rebound target', async () => {
    const site = await fixture((_req, res) => { res.writeHead(308, { location: '/next' }); res.end(); });
    const resolver = vi.fn().mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    expect(await site.client({}, { resolver }).fetch(site.base)).toMatchObject({ status: 'fetch_error', errorCode: 'dns_address_blocked' });
    expect(site.pins).toHaveLength(1);
  });
  it('records both P0-candidate confirmation attempts without automatically assigning severity', async () => {
    let count = 0; const site = await fixture((_req, res) => { res.writeHead(++count === 1 ? 404 : 200); res.end('body'); });
    const result = await site.client().fetch(`${site.base}/expected`, { confirmExpectedMissing: true });
    expect(result).toMatchObject({ status: 'fetched', evidence: { httpStatus: 200 } });
    expect(result.attempts.map(attempt => attempt.httpStatus)).toEqual([404, 200]);
    expect(result).not.toHaveProperty('severity');
  });
});
describe('Resource and retry controls / AC-20', () => {
  it.each([['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]] as const)('decodes %s within both size caps', async (encoding, encode) => {
    const site = await fixture((_req, res) => { res.setHeader('content-encoding', encoding); res.end(encode(Buffer.from('hello'))); });
    expect((await site.client().fetch(site.base)).body?.toString()).toBe('hello');
  });
  it('blocks decompression bombs and declared oversize bodies', async () => {
    const site = await fixture((req, res) => { if (req.url === '/gzip') { res.setHeader('content-encoding', 'gzip'); res.end(gzipSync('x'.repeat(100000))); } else { res.setHeader('content-length', '10000000'); res.end('x'); } });
    const client = site.client({ maxResponseBytes: 1024 });
    for (const path of ['/gzip', '/length']) expect(await client.fetch(site.base + path)).toMatchObject({ status: 'fetch_error', errorCode: 'response_too_large' });
  });
  it('bounds chunked wire bodies, malformed gzip and unsupported encodings', async () => {
    const site = await fixture((req, res) => { if (req.url === '/chunk') { res.write('x'.repeat(600)); res.end('y'.repeat(600)); } else { res.setHeader('content-encoding', req.url === '/badgzip' ? 'gzip' : 'unknown'); res.end('bad data'); } });
    const client = site.client({ maxResponseBytes: 1024 });
    expect(await client.fetch(site.base + '/chunk')).toMatchObject({ status: 'fetch_error', errorCode: 'response_too_large' });
    expect((await client.fetch(site.base + '/badgzip')).status).toBe('fetch_error');
    expect(await client.fetch(site.base + '/unknown')).toMatchObject({ status: 'fetch_error', errorCode: 'unsupported_content_encoding' });
  });
  it('enforces timeout while waiting for headers/body and DNS', async () => {
    const site = await fixture((req, res) => { if (req.url === '/body') { res.write('start'); } });
    for (const path of ['/headers', '/body']) expect(await site.client({ timeoutMs: 100 }).fetch(site.base + path)).toMatchObject({ status: 'fetch_error', errorCode: 'timeout' });
    const client = site.client({ timeoutMs: 100 }, { resolver: () => new Promise(() => {}) });
    expect(await client.fetch(site.base)).toMatchObject({ status: 'fetch_error', errorCode: 'timeout' });
  });
  it('never connects if a timed-out DNS promise resolves late', async () => {
    const site = await fixture((_req, res) => res.end('must not read'));
    let resolveDns!: (records: { address: string; family: number }[]) => void;
    const transport = vi.fn();
    const client = site.client({ timeoutMs: 100 }, { resolver: () => new Promise(resolve => { resolveDns = resolve; }), transport });
    expect(await client.fetch(site.base)).toMatchObject({ status: 'fetch_error', errorCode: 'timeout' });
    resolveDns([{ address: '93.184.216.34', family: 4 }]); await delay(10);
    expect(transport).not.toHaveBeenCalled();
  });
  it('retries 429 no sooner than Retry-After and keeps attempt evidence', async () => {
    const times: number[] = []; const site = await fixture((_req, res) => { times.push(Date.now()); if (times.length === 1) res.writeHead(429, { 'retry-after': '1' }); res.end('body'); });
    const result = await site.client({ maxRetries: 2 }).fetch(site.base);
    expect(result).toMatchObject({ status: 'fetched', evidence: { httpStatus: 200 } });
    expect(result.attempts.map(attempt => attempt.httpStatus)).toEqual([429, 200]); expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(990);
  });
  it('applies Retry-After to other queued requests for the same host', async () => {
    const starts: number[] = []; const site = await fixture((_req, res) => { starts.push(Date.now());
      if (starts.length === 1) res.writeHead(429, { 'retry-after': '1' }); res.end(); });
    const client = site.client({ concurrency: 1 });
    await Promise.all([client.fetch(site.base + '/a'), client.fetch(site.base + '/b')]);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(990);
  });
  it('caps retries at two and does not retry ordinary 404', async () => {
    let count = 0; const site = await fixture((req, res) => { count++; res.writeHead(req.url === '/404' ? 404 : 503); res.end(); });
    const client = site.client({ maxRetries: 5 });
    const result = await client.fetch(site.base + '/503'); expect(result.attempts).toHaveLength(3);
    await client.fetch(site.base + '/404'); expect(count).toBe(4);
  });
  it('does not shorten oversized Retry-After, and parses date form', async () => {
    const site = await fixture((_req, res) => { res.writeHead(429, { 'retry-after': '86400' }); res.end(); });
    expect(await site.client({ maxRetries: 2 }).fetch(site.base)).toMatchObject({ status: 'fetch_error', errorCode: 'retry_after_exceeds_budget' });
    expect(site.pins).toHaveLength(1);
    expect(retryDelay('Thu, 15 Oct 2026 12:00:05 GMT', Date.parse('2026-10-15T12:00:00Z'))).toBe(5000);
    expect(retryDelay('nonsense')).toBeUndefined();
  });
  it('applies per-host start spacing and global concurrent connection limit', async () => {
    let active = 0; let maximum = 0; const starts: number[] = [];
    const site = await fixture((_req, res) => { starts.push(Date.now()); active++; maximum = Math.max(maximum, active); void delay(90).then(() => { active--; res.end('ok'); }); });
    const client = site.client({ concurrency: 2, requestsPerSecondPerHost: 25 });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => client.fetch(`${site.base}/${i}`)));
    expect(results.every(result => result.status === 'fetched')).toBe(true); expect(maximum).toBeLessThanOrEqual(2);
    starts.slice(1).forEach((time, i) => expect(time - starts[i]!).toBeGreaterThanOrEqual(30));
  });
  it('opens a circuit after five transient failures, without another connection', async () => {
    const site = await fixture((_req, res) => { res.writeHead(503); res.end(); }); const client = site.client();
    for (let i = 0; i < 5; i++) await client.fetch(site.base);
    expect(await client.fetch(site.base)).toMatchObject({ status: 'fetch_error', errorCode: 'circuit_open' }); expect(site.pins).toHaveLength(5);
  });
  it('permits recovery after circuit cooldown', async () => {
    let hits = 0; const site = await fixture((_req, res) => { res.writeHead(++hits <= 5 ? 503 : 200); res.end(); });
    const client = site.client(); for (let i = 0; i < 5; i++) await client.fetch(site.base);
    const now = Date.now.bind(Date); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + 61000);
    try { expect(await client.fetch(site.base)).toMatchObject({ status: 'fetched', evidence: { httpStatus: 200 } }); }
    finally { clock.mockRestore(); }
  });
  it('cancels active/queued work without leaking concurrency permits', async () => {
    const site = await fixture((req, res) => { if (req.url === '/ok') res.end('ok'); });
    const client = site.client({ concurrency: 1 }); const controller = new AbortController();
    const first = client.fetch(site.base + '/hang', { signal: controller.signal });
    const queued = client.fetch(site.base + '/queued', { signal: controller.signal });
    await delay(30); controller.abort();
    expect(await first).toMatchObject({ status: 'fetch_error', errorCode: 'canceled' });
    expect(await queued).toMatchObject({ status: 'fetch_error', errorCode: 'canceled' });
    expect((await client.fetch(site.base + '/ok')).status).toBe('fetched');
  });
});
describe('TLS identity and SNI / AC-22', () => {
  it('retains original Host and SNI while connecting to pinned IP', async () => {
    let host; let sni;
    const site = await fixture((req, res) => { host = req.headers.host; sni = (req.socket as import('node:tls').TLSSocket).servername; res.end('secure'); }, true);
    expect((await site.client().fetch(site.base)).body?.toString()).toBe('secure');
    expect(host).toBe(new URL(site.base).host); expect(sni).toBe('shop.example.com');
  });
  it('rejects an untrusted certificate', async () => {
    const site = await fixture((_req, res) => res.end('must not read'), true);
    const untrusted = createNodeTransport();
    const client = site.client({}, { transport: (pin, settings, signal) => untrusted({ ...pin, address: '127.0.0.1', family: 4 }, settings, signal) });
    expect(await client.fetch(site.base)).toMatchObject({ status: 'fetch_error', errorCode: 'tls_error' });
  });
  it('rejects wrong TLS hostname even with a trusted fixture certificate', async () => {
    const site = await fixture((_req, res) => res.end('must not read'), true);
    const config = site.config(); config.allowedHosts.push('other.example.com');
    const client = new SafeHttpClient(config, { resolver: publicResolver, transport: site.transport });
    expect(await client.fetch(site.base.replace('shop.example.com', 'other.example.com'))).toMatchObject({ status: 'fetch_error', errorCode: 'tls_error' });
  });
  it('blocks HTTPS downgrade redirects', async () => {
    const site = await fixture((_req, res) => { res.writeHead(302, { location: 'http://shop.example.com/next' }); res.end(); }, true);
    expect(await site.client().fetch(site.base)).toMatchObject({ status: 'fetch_error', errorCode: 'https_downgrade' });
  });
});
