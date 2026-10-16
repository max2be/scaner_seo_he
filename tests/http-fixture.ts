import { createServer, type RequestListener } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { SafeHttpClient } from '@hsi/core';
import { ProjectConfigSchema } from '@hsi/contracts';
import { createNodeTransport, type Transport } from '../packages/core/src/http/transport.js';
import type { PinnedTarget, Resolver } from '../packages/core/src/http/policy.js';
export const certificate = readFileSync(new URL('./fixtures/tls/fixture.crt', import.meta.url), 'utf8');
const key = readFileSync(new URL('./fixtures/tls/fixture.key', import.meta.url), 'utf8');
export const publicResolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];
const closers: (() => Promise<void>)[] = [];
export async function cleanupFixtures() { await Promise.all(closers.splice(0).map(close => close())); }
export async function fixture(handler: RequestListener, secure = false) {
  const server = secure ? createSecureServer({ key, cert: certificate }, handler) : createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port missing');
  const base = `${secure ? 'https' : 'http'}://shop.example.com:${address.port}`;
  closers.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const pins: PinnedTarget[] = [];
  const direct = createNodeTransport(secure ? certificate : undefined);
  const transport: Transport = (target, settings, signal) => {
    pins.push(target);
    // Only this test adapter maps a public validated target to our disposable fixture.
    // Production never has a private-IP switch and always uses the pinned public IP.
    return direct({ ...target, address: '127.0.0.1', family: 4 }, settings, signal);
  };
  function config(http: Record<string, unknown> = {}) {
    const p = JSON.parse(readFileSync(new URL('../docs/examples/project.example.json', import.meta.url), 'utf8'));
    p.baseUrl = base; p.discovery.seedUrls = [base]; p.discovery.sitemapUrls = []; p.sources = {};
    p.http = { ...p.http, respectRobots: false, requestsPerSecondPerHost: 100, maxRetries: 0, timeoutMs: 1000, ...http };
    return ProjectConfigSchema.parse(p);
  }
  function client(http: Record<string, unknown> = {}, dependencies: ConstructorParameters<typeof SafeHttpClient>[1] = {}) {
    return new SafeHttpClient(config(http), { resolver: publicResolver, transport, random: () => 0, ...dependencies });
  }
  return { server, base, pins, transport, config, client };
}
