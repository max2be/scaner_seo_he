import { afterEach, describe, expect, it } from 'vitest';
import { fixture, cleanupFixtures } from './http-fixture.js';
afterEach(cleanupFixtures);
describe('robots policy / AC-17', () => {
  it('returns skipped_robots without fetching content or claiming noindex/404', async () => {
    const seen: string[] = [];
    const site = await fixture((req, res) => { seen.push(req.url!); res.end(req.url === '/robots.txt' ? 'User-agent: *\nDisallow: /private' : 'must not read'); });
    const result = await site.client({ respectRobots: true }).fetch(site.base + '/private/product');
    expect(result).toMatchObject({ status: 'skipped_robots', reason: 'robots_disallowed', attempts: [] });
    expect(result.robotsAttempts).toHaveLength(1); expect(result.robotsAttempts[0]?.httpStatus).toBe(200);
    expect(result).not.toHaveProperty('evidence'); expect(result.body).toBeUndefined(); expect(seen).toEqual(['/robots.txt']);
  });
  it('honors specific UA groups, longest allow/disallow, wildcard and end anchor', async () => {
    const site = await fixture((req, res) => res.end(req.url === '/robots.txt'
      ? 'User-agent: *\nDisallow: /\n\nUser-agent: HeadlessSEOInspector\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$' : 'ok'));
    const client = site.client({ respectRobots: true });
    expect((await client.fetch(site.base + '/home')).status).toBe('fetched');
    expect((await client.fetch(site.base + '/private/a')).status).toBe('skipped_robots');
    expect((await client.fetch(site.base + '/private/public/a')).status).toBe('fetched');
    expect((await client.fetch(site.base + '/file.pdf')).status).toBe('skipped_robots');
  });
  it('deduplicates concurrent robots loads per origin', async () => {
    let robots = 0; const site = await fixture((req, res) => { if (req.url === '/robots.txt') robots++; res.end(''); });
    const client = site.client({ respectRobots: true });
    const results = await Promise.all(['/a', '/b', '/c'].map(path => client.fetch(site.base + path)));
    expect(results.every(result => result.status === 'fetched')).toBe(true); expect(robots).toBe(1);
  });
  it.each([404, 410])('allows when robots is absent (%i)', async status => {
    const site = await fixture((req, res) => { if (req.url === '/robots.txt') res.writeHead(status); res.end('ok'); });
    expect((await site.client({ respectRobots: true }).fetch(site.base + '/a')).status).toBe('fetched');
  });
  it.each([401, 403])('fails closed on robots %i', async status => {
    let pages = 0;
    const site = await fixture((req, res) => { if (req.url === '/robots.txt') res.writeHead(status); else pages++; res.end(''); });
    expect((await site.client({ respectRobots: true }).fetch(site.base + '/a')).status).toBe('skipped_robots'); expect(pages).toBe(0);
  });
  it.each([429, 503])('robots %i is a source failure, not page404', async status => {
    let pages = 0; const site = await fixture((req, res) => { if (req.url === '/robots.txt') res.writeHead(status); else pages++; res.end(''); });
    const result = await site.client({ respectRobots: true }).fetch(site.base + '/a');
    expect(result).toMatchObject({ status: 'fetch_error', errorCode: 'robots_unavailable' });
    expect(result.robotsAttempts[0]?.httpStatus).toBe(status); expect(pages).toBe(0);
  });
  it('treats robots timeout and HTML challenge as unavailable', async () => {
    const site = await fixture(() => {});
    expect(await site.client({ respectRobots: true, timeoutMs: 100 }).fetch(site.base)).toMatchObject({ status: 'fetch_error', errorCode: 'robots_unavailable' });
    const challenge = await fixture((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<html>Challenge</html>'); });
    expect(await challenge.client({ respectRobots: true }).fetch(challenge.base)).toMatchObject({ status: 'fetch_error', errorCode: 'robots_unavailable' });
  });
  it('checks robots before a redirect destination is fetched', async () => {
    const seen: string[] = []; const site = await fixture((req, res) => {
      seen.push(req.url!);
      if (req.url === '/robots.txt') res.end('User-agent: *\nDisallow: /private');
      else if (req.url === '/a') { res.writeHead(302, { location: '/private' }); res.end(); } else res.end('must not read');
    });
    const result = await site.client({ respectRobots: true }).fetch(site.base + '/a');
    expect(result.status).toBe('skipped_robots'); expect(result.redirectChain).toHaveLength(1); expect(seen).toEqual(['/robots.txt', '/a']);
  });
  it('follows safe robots redirects, applying its returned rules to the original origin', async () => {
    const site = await fixture((req, res) => {
      if (req.url === '/robots.txt') { res.writeHead(301, { location: '/robots-rules.txt' }); res.end(); }
      else res.end('User-agent: *\nDisallow: /private');
    });
    expect((await site.client({ respectRobots: true }).fetch(site.base + '/private')).status).toBe('skipped_robots');
  });
  it('does not allow robots redirects to private destinations', async () => {
    const site = await fixture((_req, res) => { res.writeHead(301, { location: 'http://127.0.0.1/robots.txt' }); res.end(); });
    expect((await site.client({ respectRobots: true }).fetch(site.base + '/a')).status).toBe('fetch_error'); expect(site.pins).toHaveLength(1);
  });
  it('can explicitly disable robots without impersonating Googlebot', async () => {
    const seen: string[] = []; const site = await fixture((req, res) => { seen.push(req.url!); expect(req.headers['user-agent']).toContain('HeadlessSEOInspector'); res.end('ok'); });
    expect((await site.client({ respectRobots: false }).fetch(site.base + '/private')).status).toBe('fetched'); expect(seen).toEqual(['/private']);
  });
});
