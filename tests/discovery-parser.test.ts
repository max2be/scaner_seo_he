import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { parseSitemap, parseLinks, normalizeUrl, type SitemapEntry } from '@hsi/sources';
import { ProjectConfigSchema } from '@hsi/contracts';
import { readFileSync } from 'node:fs';
function project() { return ProjectConfigSchema.parse(JSON.parse(readFileSync(new URL('../docs/examples/project.example.json', import.meta.url), 'utf8'))); }
async function* chunks(value: string | Buffer, size = 37) { const body = Buffer.from(value); for (let at = 0; at < body.length; at += size) yield body.subarray(at, at + size); }
async function entries(xml: string | Buffer) { const found: SitemapEntry[] = []; await parseSitemap(chunks(xml), async entry => { found.push(entry); }); return found; }
describe('Sitemap stream validation / AC-05', () => {
  it('handles UTF-8 boundaries, namespaces, entities and both root kinds', async () => {
    const xml = '<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc>https://shop.example.com/обувь?a=1&amp;b=2</sm:loc></sm:url></sm:urlset>';
    expect(await entries(xml)).toEqual([{ kind: 'url', url: 'https://shop.example.com/%D0%BE%D0%B1%D1%83%D0%B2%D1%8C?a=1&b=2' }]);
    expect(await entries('<sitemapindex><sitemap><loc>https://shop.example.com/one.xml</loc></sitemap></sitemapindex>')).toEqual([{ kind: 'sitemap', url: 'https://shop.example.com/one.xml' }]);
  });
  it('detects gzip by magic, including a split magic header', async () => {
    const xml = '<urlset><url><loc>https://shop.example.com/a</loc></url></urlset>';
    const found: SitemapEntry[] = []; await parseSitemap(chunks(gzipSync(xml), 1), async e => { found.push(e); }); expect(found).toHaveLength(1);
  });
  it.each([
    '<!DOCTYPE urlset [<!ENTITY data SYSTEM "http://127.0.0.1/secret">]><urlset><url><loc>&data;</loc></url></urlset>',
    '<urlset><url><loc>https://shop.example.com/a</url></urlset>',
    '<html><body>challenge</body></html>',
    '<urlset><url/></urlset>',
    '<urlset><url><loc>/relative</loc></url></urlset>',
    '<urlset><url><loc>https://shop.example.com/a</loc><loc>https://shop.example.com/b</loc></url></urlset>',
    '<urlset><url><loc>https://shop.example.com/<nested/></loc></url></urlset>',
    '<?xml version="1.0" encoding="ISO-8859-1"?><urlset/>',
    '<urlset xmlns="https://wrong.example.org"/>',
  ])('rejects malformed/unsafe XML without external fetching', async xml => { await expect(entries(xml)).rejects.toThrow(); });
  it('enforces decoded byte/entry limits instead of silently truncating', async () => {
    const xml = '<urlset>' + '<url><loc>https://shop.example.com/a</loc></url>'.repeat(3) + '</urlset>';
    await expect(parseSitemap(chunks(xml), async () => {}, { maxEntries: 2 })).rejects.toMatchObject({ code: 'sitemap_entry_limit' });
    await expect(parseSitemap(chunks(gzipSync(xml)), async () => {}, { maxBytes: 50 })).rejects.toMatchObject({ code: 'sitemap_byte_limit' });
    await expect(entries('<urlset><!--' + 'x'.repeat(65540) + '--></urlset>')).rejects.toMatchObject({ code: 'sitemap_token_limit' });
  });
  it('applies 50,000 per file, allowing over 50,000 across separate maps', async () => {
    async function* generated(total: number) {
      yield Buffer.from('<urlset>');
      for (let i = 0; i < total; i += 512) yield Buffer.from(Array.from({ length: Math.min(512, total - i) }, (_, n) => `<url><loc>https://shop.example.com/p${i + n}</loc></url>`).join(''));
      yield Buffer.from('</urlset>');
    }
    let total = 0;
    for (let file = 0; file < 2; file++) await parseSitemap(generated(30000), async () => { total++; });
    expect(total).toBe(60000);
    await expect(parseSitemap(generated(50001), async () => {})).rejects.toMatchObject({ code: 'sitemap_entry_limit' });
  });
  it('does not misclassify a storage/sink failure as malformed source XML', async () => {
    const failure = new Error('storage_failure');
    await expect(parseSitemap(chunks('<urlset><url><loc>https://shop.example.com/a</loc></url></urlset>'), async () => { throw failure; })).rejects.toBe(failure);
  });
  it('rejects truncated gzip and invalid UTF-8', async () => {
    await expect(entries(gzipSync('<urlset/>').subarray(0, 10))).rejects.toThrow();
    await expect(entries(Buffer.from([0xff, 0xfe]))).rejects.toThrow();
  });
});
describe('HTML and URL policy', () => {
  it('tokenizes only real anchors, handles base, entities and nofollow without JS execution', () => {
    const parsed = parseLinks(Buffer.from('<a href="before">A</a><base href="/catalog/"><script>throw Error("executed"); "<a href=evil>"</script><a href="shoe?a=1&amp;b=2" rel="NOFOLLOW">B</a><button onclick="fetch(1)">C</button>'), 'https://shop.example.com/start');
    expect(parsed.base).toBe('https://shop.example.com/catalog/');
    expect([...parsed.links]).toEqual([{ href: 'before', nofollow: false }, { href: 'shoe?a=1&b=2', nofollow: true }]);
  });
  it('drops tracking keys, sorts allowed parameters and preserves unknown trailing slash', () => {
    expect(normalizeUrl('/a/?utm_source=x&page=2#top', 'https://shop.example.com', project())).toEqual({ kind: 'include', url: 'https://shop.example.com/a/?page=2' });
    expect(normalizeUrl('/a?sort=price', 'https://shop.example.com', project()).kind).toBe('exclude');
  });
  it.each(['#top', 'mailto:a@example.com', 'tel:123', 'javascript:alert(1)', 'https://evil.example.org', 'http://127.0.0.1', 'https://u:p@shop.example.com', '/a?token=secret'])('excludes unsafe or out-of-scope link %s', href => {
    expect(normalizeUrl(href, 'https://shop.example.com', project()).kind).toBe('exclude');
  });
  it('uses configured slash and drop-query behavior without guessing from preferred scheme', () => {
    const p = project(); p.canonicalPolicy.trailingSlash = 'without';
    expect(normalizeUrl('/a/', p.baseUrl, p)).toEqual({ kind: 'include', url: 'https://shop.example.com/a' });
    p.canonicalPolicy.trailingSlash = 'with'; p.discovery.queryPolicy.mode = 'drop';
    expect(normalizeUrl('/a?filter=red', p.baseUrl, p)).toEqual({ kind: 'include', url: 'https://shop.example.com/a/' });
  });
});
