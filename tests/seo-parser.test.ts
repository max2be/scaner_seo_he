import { describe, expect, it } from 'vitest';
import { parsePageFacts, robotsDirectives, redactText } from '@hsi/sources';
import { healthy, target } from './seo-fixture.js';
const parse = (html: string, extra: Partial<Parameters<typeof parsePageFacts>[2]> = {}) => parsePageFacts(Buffer.from(html), target, { userAgent: 'HeadlessSEOInspector/1.0', ...extra });
describe('Source HTML facts; no execution or raw content persistence', () => {
  it('extracts title/description/H1/canonical with decoded entities and normalized title hash', () => {
    const facts = parse(healthy); expect(facts).toMatchObject({ titlePresent: true, descriptionPresent: true, h1Count: 1, noindex: false, truncated: false });
    expect(facts.canonicals).toEqual([{ url: target, absolute: true, fragment: false }]);
    expect(parse('<title>Example&#32;product</title>').titleHash).toBe(facts.titleHash);
    expect(JSON.stringify(facts)).not.toContain('Useful product content');
  });
  it('allows multiple H1, empty decorative alt and ordinary non-navigation buttons', () => {
    const facts = parse('<h1>one</h1><h1>two</h1><img alt="" width="1" height="1"><button onclick="toggle()">Open</button>');
    expect(facts).toMatchObject({ h1Count: 2, imageMissingAltCount: 0, imageMissingSizeCount: 0, buttonNavCount: 0 });
  });
  it('extracts source-only hints for buttons, anchors, duplicate IDs and manifests', () => {
    expect(parse('<a name="named"></a><button data-href="/go">go</button><button onclick="location.assign(\'/go\')">go</button><div id="x"></div><div id="x"></div><link rel="manifest" href="/a"><link rel="manifest" href="/b">')).toMatchObject({ anchorWithoutHrefCount: 1, buttonNavCount: 2, duplicateIdCount: 1, manifestCount: 2 });
  });
  it('ignores JS/style/template text and does not execute document writes', () => {
    const facts = parse('<script>document.write("<h1>secret</h1>");fetch("https://evil.example.org")</script><style>.secret{}</style><template><h1>hidden</h1></template><div id="app"></div>');
    expect(facts).toMatchObject({ h1Count: 0, contentCharacters: 0, products: [] });
    expect(JSON.stringify(facts)).not.toContain('secret');
  });
  it('distinguishes invalid, relative, conflicting and fragment canonical declarations', () => {
    const facts = parse('<base href="https://shop.example.com/catalog/"><link rel="canonical" href="item#top"><link rel="canonical" href="http://127.0.0.1/a"><link rel="canonical"><link rel="canonical" href="https://shop.example.com/other">');
    expect(facts.canonicalInvalid).toBe(2); expect(facts.canonicals[0]).toEqual({ url: 'https://shop.example.com/catalog/item', absolute: false, fragment: true });
  });
  it.each([
    ['noindex, nofollow', true], ['none', true], ['NOINDEX', true], ['index, follow', false],
    ['googlebot: noindex', false], ['headlessseoinspector: noindex', true],
    ['googlebot: noindex, nofollow', false], ['unavailable_after: 25 Jun 2030', false],
  ])('scopes X-Robots directive %s to the actual request agent', (header, noindex) => {
    expect(robotsDirectives([header], 'HeadlessSEOInspector/1.0').noindex).toBe(noindex);
  });
  it('combines global meta/HTTP rules without converting robots.txt disallow into noindex', () => {
    expect(parse('<meta name="robots" content="index"><meta name="HEADLESSSEOINSPECTOR" content="noindex">', { xRobotsTag: ['nofollow'] })).toMatchObject({ noindex: true, nofollow: true, noindexSources: ['meta'] });
    expect(parse('<meta name="googlebot" content="noindex">', { xRobotsTag: ['noindex'] }).noindexSources).toEqual(['http']);
  });
  it('extracts graph/array Product/Offer/AggregateRating with precise paths and no arbitrary properties', () => {
    const value = { '@graph': [{ '@type': ['Product'], sku: 'one', name: 'Product', private: 'do-not-persist', aggregateRating: { ratingValue: 5 }, offers: [{ '@type': 'Offer', price: '10.25', priceCurrency: 'usd', availability: 'https://schema.org/InStock' }] }] };
    const facts = parse('<script type="application/ld+json">' + JSON.stringify(value) + '</script>');
    expect(facts.products[0]).toMatchObject({ path: '$.@graph[0]', sku: 'one', rating: { hasValue: true, value: 5, countState: 'missing' }, offers: [{ path: '$.@graph[0].offers[0]', price: 10.25, currency: 'USD', availability: 'in_stock' }] });
    expect(JSON.stringify(facts)).not.toContain('do-not-persist');
  });
  it.each([[undefined, 'missing'], [0, 'invalid'], [-1, 'invalid'], ['x', 'invalid'], [1.5, 'invalid'], ['7', 'valid'], [12, 'valid']] as const)('validates rating count %s as %s', (count, state) => {
    const facts = parse('<script type="application/ld+json">' + JSON.stringify({ '@type': 'Product', aggregateRating: { ratingValue: 5, ...(count !== undefined ? { ratingCount: count } : {}) } }) + '</script>');
    expect(facts.products[0]?.rating?.countState).toBe(state);
  });
  it('accepts reviewCount instead of ratingCount; malformed JSON produces a fact without raw text', () => {
    expect(parse('<script type="application/ld+json">{"@type":"Product","aggregateRating":{"ratingValue":5,"reviewCount":3}}</script>').products[0]?.rating?.countState).toBe('valid');
    const bad = parse('<script type="application/ld+json">{"secret":"secret-value", broken</script>'); expect(bad.jsonLdParseErrors).toBe(1); expect(JSON.stringify(bad)).not.toContain('secret-value');
  });
  it('marks limits and invalid UTF8 explicitly; never treats an incomplete parser as complete', () => {
    expect(parse('<script type="application/ld+json">' + 'x'.repeat(256001) + '</script>').truncated).toBe(true);
    expect(parsePageFacts(Uint8Array.from([0xff]), target, { userAgent: 'HeadlessSEOInspector' }).truncated).toBe(true);
    expect(parse(Array.from({ length: 17 }, () => '<link rel="canonical" href="' + target + '">').join('')).truncated).toBe(true);
  });
  it('matches an explicitly configured not-found marker across parser input chunks', () => {
    expect(parse('<p>' + 'x'.repeat(16370) + 'KNOWN_MISSING_RESOURCE</p>', { notFoundMarker: 'KNOWN_MISSING_RESOURCE' }).markerMatched).toBe(true);
  });
  it('uses a declared HTML charset and marks unsupported labels as incomplete', () => {
    const utf16 = parsePageFacts(Buffer.from(healthy, 'utf16le'), target, { userAgent: 'HeadlessSEOInspector', contentType: 'text/html; charset="utf-16le"' });
    expect(utf16).toMatchObject({ titlePresent: true, h1Count: 1, truncated: false });
    expect(parse(healthy, { contentType: 'text/html; charset=not-a-real-charset' }).truncated).toBe(true);
  });
  it('redacts sensitive prose and URL query values, with bounded output', () => {
    const safe = redactText('email person@example.com token=synthetic-secret https://shop.example.com/a?q=private Bearer synthetic-token');
    expect(safe).not.toContain('person@example.com'); expect(safe).not.toContain('synthetic-secret'); expect(safe).not.toContain('q=private'); expect(safe).not.toContain('synthetic-token');
    expect(redactText('x'.repeat(9000)).length).toBeLessThanOrEqual(4096);
  });
});
