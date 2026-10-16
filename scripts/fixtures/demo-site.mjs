// Synthetic fixture only. Never imported by application runtime.
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { ProjectConfigSchema } from '@hsi/contracts';
import { SafeHttpClient } from '@hsi/core';
import { createNodeTransport } from '../../packages/core/dist/http/transport.js';
const shop = 'http://shop.example.com';
const content = 'http://content.example.org';
export const html = (title, extra = '', links = '') =>
  `<html><head><title>${title}</title><meta name="description" content="Synthetic fixture content">${extra}</head><body><h1>${title}</h1><p>${'Useful synthetic text. '.repeat(30)}</p>${links}</body></html>`;
const map = (urls) => '<urlset>' + urls.map(url => `<url><loc>${url}</loc></url>`).join('') + '</urlset>';
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function close(server) {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
export async function demoSite() {
  let released = false;
  const hits = new Map();
  const remember = (name) => hits.set(name, (hits.get(name) ?? 0) + 1);
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://' + req.headers.host);
    const base = url.hostname === 'content.example.org' ? content : shop;
    remember(base + url.pathname);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/robots.txt') { res.setHeader('content-type', 'text/plain'); res.end('User-agent: *\nDisallow: /blocked\n'); }
    else if (url.pathname === '/sitemap.xml') { res.setHeader('content-type', 'application/xml'); res.end(`<sitemapindex><sitemap><loc>${base}/pages.xml</loc></sitemap><sitemap><loc>${base}/extra.xml.gz</loc></sitemap></sitemapindex>`); }
    else if (url.pathname === '/pages.xml') { res.setHeader('content-type', 'application/xml'); res.end(map((base === shop ? ['/', '/product', '/missing', '/deleted'] : ['/', '/article', '/shell']).map(path => base + path))); }
    else if (url.pathname === '/extra.xml.gz') { res.setHeader('content-type', 'application/gzip'); res.end(gzipSync(map([base + '/about']))); }
    else if (url.pathname === '/malformed.xml') { res.setHeader('content-type', 'application/xml'); res.end('<urlset><url><loc>broken'); }
    else if (url.pathname === '/blocked') { res.writeHead(500); res.end('must never fetch'); }
    else if (url.pathname === '/old') { res.writeHead(301, { location: '/moved' }); res.end(); }
    else if (url.pathname === '/moved') { res.writeHead(308, { location: '/about' }); res.end(); }
    else if (url.pathname === '/loop-a' || url.pathname === '/loop-b') { res.writeHead(302, { location: url.pathname === '/loop-a' ? '/loop-b' : '/loop-a' }); res.end(); }
    else if (url.pathname === '/slash/') { res.writeHead(308, { location: '/slash' }); res.end(); }
    else if (url.pathname === '/deleted' || url.pathname === '/broken' || (url.pathname === '/missing' && !released)) { res.writeHead(404); res.end('Missing fixture page'); }
    else if (url.pathname === '/shell') res.end('<html><head></head><body><div id="app"></div></body></html>');
    else {
      const rating = url.pathname === '/product' ? '<script type="application/ld+json">' + JSON.stringify({ '@type': 'Product', name: 'Synthetic product', aggregateRating: { ratingValue: 5, ...(released ? { ratingCount: 10 } : {}) } }) + '</script>' : '';
      const canonical = `<link rel="canonical" href="${base}${url.pathname}">`;
      const links = url.pathname === '/' ? (base === shop ? '<a href="/product">Product</a><a href="/broken">Broken</a><a href="/old">Old</a><a href="/blocked" rel="nofollow">Blocked</a><a href="/shell">Shell</a><a href="/slash/">Slash</a><button data-href="/guess">More</button>' : '<a href="/article">Article</a>') : '';
      res.end(html(base + url.pathname, canonical + rating, links));
    }
  };
  const server = createServer(handler);
  const cert = await readFile(new URL('../../tests/fixtures/tls/fixture.crt', import.meta.url), 'utf8');
  const key = await readFile(new URL('../../tests/fixtures/tls/fixture.key', import.meta.url));
  const feed = createSecureServer({ cert, key }, (req, res) => {
    remember('feed');
    if (req.headers.authorization !== 'Bearer synthetic-demo-token') { res.writeHead(401); res.end(); return; }
    const cursor = new URL(req.url, 'https://shop.example.com').searchParams.get('cursor');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ schemaVersion: '1.0', snapshotId: 'synthetic-fixed', nextCursor: cursor ? null : 'second', items: cursor ? [
      { id: 'deleted', type: 'product', url: shop + '/deleted', publicationState: 'deleted' },
      { id: 'product', type: 'product', url: shop + '/product', publicationState: 'published', expectedStatus: 200, expectedIndexable: true },
    ] : [{ id: 'missing', type: 'product', url: shop + '/missing', publicationState: 'published', expectedStatus: 200, expectedIndexable: true }] }));
  });
  try {
    const port = await listen(server), tlsPort = await listen(feed);
    const plain = createNodeTransport(), secure = createNodeTransport(cert);
    const transport = (target, settings, signal) => {
      if (![new URL(shop).hostname, new URL(content).hostname].includes(target.url.hostname)) throw Error('unexpected_fixture_host');
      const url = new URL(target.url); url.port = String(url.protocol === 'https:' ? tlsPort : port);
      return (url.protocol === 'https:' ? secure : plain)({ ...target, url, address: '127.0.0.1', family: 4 }, settings, signal);
    };
    const dependencies = { resolver: async () => [{ address: '93.184.216.34', family: 4 }], transport, random: () => 0 };
    const template = JSON.parse(await readFile(new URL('../../docs/examples/project.example.json', import.meta.url), 'utf8'));
    const profile = (base, id, integrated) => ProjectConfigSchema.parse({ ...template, id, name: 'Synthetic ' + id, baseUrl: base, allowedHosts: [new URL(base).hostname],
      canonicalPolicy: { trailingSlash: 'unknown', preferredHost: new URL(base).hostname, expectedScheme: 'http', checkSelfCanonical: false },
      discovery: { ...template.discovery, seedUrls: [base + '/'], sitemapUrls: [base + '/sitemap.xml'], maxUrls: 100, crawlLinks: true },
      http: { ...template.http, respectRobots: true, requestsPerSecondPerHost: 100, timeoutMs: 2000, maxRetries: 0 },
      sources: integrated ? { backend: { enabled: true, type: 'entity-feed-v1', endpoint: 'https://shop.example.com/entities', allowedHosts: ['shop.example.com'], auth: { type: 'bearer', tokenEnv: 'SYNTHETIC_DEMO_TOKEN' }, pageSize: 2 } } : {},
    });
    const clients = project => ({ client: new SafeHttpClient(project, dependencies), ...(project.sources.backend?.enabled ? { backendClient: SafeHttpClient.forBackend(project, () => 'synthetic-demo-token', dependencies) } : {}) });
    return { shop: profile(shop, 'demo-shop', true), content: profile(content, 'demo-content', false), clients, hits, release: () => { released = true; }, close: () => Promise.all([close(server), close(feed)]) };
  } catch (error) { await Promise.all([close(server), close(feed)]); throw error; }
}
