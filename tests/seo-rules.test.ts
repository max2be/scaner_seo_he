import { describe, expect, it } from 'vitest';
import { RuleEngine, seoRules, findingId, validateRuleProfile, type RuleContext, type Rule } from '@hsi/core';
import { defaultRuleProfile, FindingSchema } from '@hsi/contracts';
import { context, target, healthy, product } from './seo-fixture.js';
async function detect(id: string, ctx: RuleContext) { const rule = seoRules.find(r => r.id === id)!; return rule.detect(ctx); }
function confirm(ctx: RuleContext) {
  const result = ctx.analysis!.observation.result;
  if (result.status === 'fetched') result.attempts.push({ ...result.attempts[0]! }); return ctx;
}
describe('SEO facts, confidence and stable findings / AC-09…18', () => {
  it('published expected-indexable entity with two HTTP404 GETs produces P0 with entity and evidence', async () => {
    const result = await detect('EXPECTED_PAGE_NOT_200', confirm(context('', 404)));
    expect(result).toMatchObject({ verdict: 'finding', finding: { severity: 'P0', confidence: 'high', entity: { id: 'sku-one' }, evidence: { httpStatus: 404, source: 'backend' } } });
    if ('finding' in result) expect(FindingSchema.safeParse(result.finding).success).toBe(true);
  });
  it.each([200, 301, 308, 401, 403, 429, 500, 503])('HTTP%s never produces an unconfirmed P0', async status => {
    const result = await detect('EXPECTED_PAGE_NOT_200', context('', status));
    expect('finding' in result && result.finding.severity === 'P0').toBe(false);
  });
  it('requires both confirmation responses to agree, not one 404 after a redirect', async () => {
    const ctx = context('', 404); const r = ctx.analysis!.observation.result; if (r.status === 'fetched') r.attempts.unshift({ url: target + '/old', timestamp: '2026-10-15T00:00:00Z', httpStatus: 301, totalMs: 1 });
    expect(await detect('EXPECTED_PAGE_NOT_200', ctx)).toMatchObject({ verdict: 'needs_review', finding: { severity: 'P1' } });
  });
  it.each(['deleted', 'unpublished', 'unknown'] as const)('%s entity and HTTP404 do not create EXPECTED_PAGE_NOT_200', async publicationState => {
    const ctx = confirm(context('', 404)); ctx.entity!.publicationState = publicationState;
    expect(await detect('EXPECTED_PAGE_NOT_200', ctx)).toEqual({ verdict: 'not_applicable' });
  });
  it.each(['incomplete', 'changed', 'unknown', 'not-indexable', 'not-expected200'] as const)('does not infer an expected-indexable P0 from %s context', async mode => {
    const ctx = confirm(context('', 404));
    if (mode === 'incomplete') ctx.analysis!.coverage.backendComplete = false;
    if (mode === 'changed') ctx.analysis!.coverage.snapshotConsistency = 'changed';
    if (mode === 'unknown') ctx.analysis!.coverage.snapshotConsistency = 'unknown';
    if (mode === 'not-indexable') ctx.entity!.expectedIndexable = false;
    if (mode === 'not-expected200') ctx.entity!.expectedStatus = 404;
    if (mode === 'unknown') expect(await detect('EXPECTED_PAGE_NOT_200', ctx)).toMatchObject({ verdict: 'needs_review', finding: { severity: 'P1' } });
    else expect(await detect('EXPECTED_PAGE_NOT_200', ctx)).toEqual({ verdict: 'not_applicable' });
  });
  it('robots disallow is P1 for an expected page but is neither HTTP404 nor noindex', async () => {
    const ctx = context(); ctx.analysis!.observation.result = { status: 'skipped_robots', requestedUrl: target, reason: 'robots_disallowed', attempts: [], robotsAttempts: [], redirectChain: [] }; delete ctx.analysis!.observation.facts;
    expect(await detect('ROBOTS_DISALLOWED_EXPECTED', ctx)).toMatchObject({ verdict: 'finding', finding: { severity: 'P1', evidence: { source: 'robots' } } });
    expect(await detect('NOINDEX_EXPECTED_PAGE', ctx)).toEqual({ verdict: 'not_applicable' });
    expect(await detect('EXPECTED_PAGE_NOT_200', ctx)).toEqual({ verdict: 'not_applicable' });
  });
  it('respects noindex and does not diagnose missing canonical/title as an indexability defect', async () => {
    const ctx = context('<meta name="robots" content="noindex"><body><h1>Content</h1></body>');
    expect(await detect('NOINDEX_EXPECTED_PAGE', ctx)).toMatchObject({ verdict: 'finding', finding: { severity: 'P1' } });
    expect(await detect('CANONICAL_MISSING', ctx)).toEqual({ verdict: 'not_applicable' });
    expect(await detect('TITLE_MISSING', ctx)).toEqual({ verdict: 'not_applicable' });
  });
  it('unknown/preserve slash does not make a valid slash redirect or alternate canonical a policy defect', async () => {
    for (const trailingSlash of ['unknown', 'preserve'] as const) {
      const ctx = context(healthy.replace(target + '"', target + '/"')); ctx.project.canonicalPolicy.trailingSlash = trailingSlash;
      expect(await detect('TRAILING_SLASH_CONFLICT', ctx)).toEqual({ verdict: 'not_applicable' });
      expect(await detect('CANONICAL_CONFLICT', ctx)).toEqual({ verdict: 'pass' });
    }
  });
  it('explicit canonical policy conflict fails; a matching without-slash canonical passes', async () => {
    const ctx = context(healthy); ctx.project.canonicalPolicy.trailingSlash = 'without';
    expect(await detect('CANONICAL_CONFLICT', ctx)).toEqual({ verdict: 'pass' });
    ctx.analysis!.observation.facts!.canonicals[0]!.url += '/';
    expect(await detect('CANONICAL_CONFLICT', ctx)).toMatchObject({ verdict: 'finding' });
  });
  it('does not require universal self-canonical unless explicitly configured', async () => {
    const ctx = context(healthy.replace(target + '"', target + '/master"'), 200, false);
    expect(await detect('CANONICAL_CONFLICT', ctx)).toEqual({ verdict: 'pass' }); ctx.project.canonicalPolicy.checkSelfCanonical = true;
    expect(await detect('CANONICAL_CONFLICT', ctx)).toMatchObject({ verdict: 'finding' });
  });
  it('multiple conflicting/relative/fragment canonical tags are findings but identical canonical tags are not a conflict', async () => {
    for (const tags of ['<link rel="canonical" href="/a">', '<link rel="canonical" href="' + target + '#x">', '<link rel="canonical" href="https://shop.example.com/other">']) {
      const ctx = context(healthy.replace('</head>', tags + '</head>')); expect(await detect('CANONICAL_CONFLICT', ctx)).toMatchObject({ verdict: 'finding' });
    }
    expect(await detect('CANONICAL_CONFLICT', context(healthy.replace('</head>', '<link rel="canonical" href="' + target + '"></head>')))).toEqual({ verdict: 'pass' });
  });
  it('sitemap absence requires complete agreed maps and trusted expected entities', async () => {
    const ctx = context(); expect(await detect('EXPECTED_URL_MISSING_FROM_SITEMAP', ctx)).toMatchObject({ verdict: 'finding' });
    ctx.analysis!.coverage.sitemapComplete = false; expect(await detect('EXPECTED_URL_MISSING_FROM_SITEMAP', ctx)).toEqual({ verdict: 'not_applicable' });
    ctx.analysis!.coverage.sitemapComplete = true; ctx.url.sourceSet.push('sitemap'); expect(await detect('EXPECTED_URL_MISSING_FROM_SITEMAP', ctx)).toEqual({ verdict: 'pass' });
  });
  it('broken internal link needs sourcePage and actual HTTP404/410', async () => {
    const ctx = context('', 404, false); ctx.analysis!.provenance = { schemaVersion: '1.0', targetUrl: target, source: 'link', sourceUrl: 'https://shop.example.com/source', href: target };
    expect(await detect('BROKEN_INTERNAL_LINK', ctx)).toMatchObject({ verdict: 'finding', finding: { severity: 'P2', evidence: { sourcePage: 'https://shop.example.com/source' } } });
    delete ctx.analysis!.provenance; expect(await detect('BROKEN_INTERNAL_LINK', ctx)).toEqual({ verdict: 'not_applicable' });
  });
  it('ratingValue without count has an exact JSON path and bounded numeric excerpt; absence of rating passes', async () => {
    const ctx = context(product({ '@type': 'Product', aggregateRating: { ratingValue: 5 } }));
    expect(await detect('PRODUCT_RATING_COUNT_MISSING', ctx)).toMatchObject({ verdict: 'finding', finding: { severity: 'P1', evidence: { jsonPath: '$.aggregateRating', excerpt: '{"aggregateRating":{"ratingValue":5}}' } } });
    expect(await detect('PRODUCT_RATING_COUNT_MISSING', context(product({ '@type': 'Product' })))).toEqual({ verdict: 'pass' });
    expect(await detect('PRODUCT_RATING_COUNT_MISSING', context(product({ '@type': 'Product', aggregateRating: { ratingValue: 5, reviewCount: 1 } })))).toEqual({ verdict: 'pass' });
  });
  it('matches Product/Offer to backend by SKU and compares only comparable values', async () => {
    const json = { '@type': 'Product', sku: 'sku-one', offers: { '@type': 'Offer', price: '120', priceCurrency: 'USD', availability: 'https://schema.org/InStock' } };
    expect(await detect('PRODUCT_DATA_CONFLICT', context(product(json)))).toMatchObject({ verdict: 'finding', finding: { severity: 'P1', evidence: { jsonPath: '$.offers' } } });
    json.offers.price = '100'; expect(await detect('PRODUCT_DATA_CONFLICT', context(product(json)))).toEqual({ verdict: 'pass' });
    json.sku = 'unmatched'; json.offers.price = '120'; expect(await detect('PRODUCT_DATA_CONFLICT', context(product(json)))).toMatchObject({ verdict: 'needs_review' });
    const ctx = context(product(json)); ctx.analysis!.coverage.backendComplete = false; expect(await detect('PRODUCT_DATA_CONFLICT', ctx)).toEqual({ verdict: 'not_applicable' });
  });
  it('JS button, shell and soft404 phrases are review hints, never proof of a broken route', async () => {
    const ctx = context('<title>Page not found</title><button onclick="location.href=\'/a\'">go</button><div id="app"></div>');
    for (const id of ['BUTTON_NAV_SUSPECTED', 'SSR_CONTENT_MISSING', 'SOFT_404_SUSPECTED']) expect(await detect(id, ctx)).toMatchObject({ verdict: 'needs_review' });
    expect(await detect('BROKEN_INTERNAL_LINK', ctx)).toEqual({ verdict: 'not_applicable' });
  });
  it('unknown-route probes require explicit scope and an exact configured marker for a finding', async () => {
    const ctx = context('<p>Known absent</p>'); ctx.analysis!.profile.unknownRouteProbes = [{ url: target }];
    expect(await detect('UNKNOWN_ROUTE_RETURNS_200', ctx)).toMatchObject({ verdict: 'needs_review' });
    ctx.analysis!.profile.unknownRouteProbes[0]!.notFoundMarker = 'Known absent'; ctx.analysis!.observation.facts!.markerMatched = true;
    expect(await detect('UNKNOWN_ROUTE_RETURNS_200', ctx)).toMatchObject({ verdict: 'finding', finding: { severity: 'P1' } });
  });
  it('findings are stable across scans but distinct across projects/entities and respect query normalization', () => {
    const ctx = context(); const first = findingId(ctx, 'TITLE_MISSING'); ctx.url.scanId = 'scan-two'; expect(findingId(ctx, 'TITLE_MISSING')).toBe(first);
    ctx.entity!.id = 'different'; expect(findingId(ctx, 'TITLE_MISSING')).not.toBe(first);
    ctx.entity!.id = 'sku-one'; ctx.project.id = 'other-project'; expect(findingId(ctx, 'TITLE_MISSING')).not.toBe(first);
  });
  it('severity overrides retain facts but cannot promote quality or a review heuristic to P0', async () => {
    const ctx = context('<button data-href="/a">go</button>'); ctx.analysis!.profile.severityOverrides = { BUTTON_NAV_SUSPECTED: 'P0', TITLE_MISSING: 'INFO' };
    expect(await detect('BUTTON_NAV_SUSPECTED', ctx)).toMatchObject({ verdict: 'needs_review', finding: { severity: 'P1' } });
    expect(await detect('TITLE_MISSING', ctx)).toMatchObject({ verdict: 'finding', finding: { severity: 'INFO' } });
    expect(() => validateRuleProfile({ ...defaultRuleProfile(), severityOverrides: { TYPO: 'P1' } })).toThrow('unknown_rule_override');
  });
  it('isolates rule exceptions and records fetch errors separately from SEO findings', async () => {
    const ctx = context(); ctx.analysis!.observation.result = { status: 'fetch_error', errorCode: 'timeout', attempts: [], robotsAttempts: [], redirectChain: [] }; delete ctx.analysis!.observation.facts;
    const throwing: Rule = { id: 'TEST_THROW', version: '1.0.0', severityDefault: 'P0', recommendationKey: 'test', appliesTo: () => true, detect: async () => { throw new Error('sensitive input'); } };
    const result = await new RuleEngine([throwing]).evaluate(ctx);
    expect(result.errors.map(e => e.code)).toEqual(['page_fetch_unavailable', 'rule_execution_failed']); expect(JSON.stringify(result)).not.toContain('sensitive input');
    ctx.url.sourceSet.push('sitemap');
    const regular = await new RuleEngine().evaluate(ctx); expect(regular.evaluations.some(e => e.result.verdict === 'finding')).toBe(false);
  });
});

describe('Positive/negative matrix for every remaining rule', () => {
  const cases: [string, (ctx: RuleContext) => void][] = [
    ['HTTP_SERVER_ERROR', ctx => { const r = ctx.analysis!.observation.result; if (r.status === 'fetched') r.evidence.httpStatus = 503; }],
    ['REDIRECT_LOOP', ctx => { ctx.analysis!.observation.result = { status: 'fetch_error', errorCode: 'redirect_loop', attempts: [], robotsAttempts: [], redirectChain: [] }; }],
    ['REDIRECT_CHAIN_LONG', ctx => { ctx.analysis!.profile.maxRedirectHops = 0; ctx.analysis!.observation.result.redirectChain = [{ url: target, status: 301, location: target + '/new' }]; }],
    ['CANONICAL_MISSING', ctx => { ctx.analysis!.observation.facts!.canonicals = []; }],
    ['CANONICAL_TARGET_BROKEN', ctx => { const r = structuredClone(ctx.analysis!.observation.result); if (r.status === 'fetched') r.evidence.httpStatus = 404; ctx.analysis!.observation.checks.push({ kind: 'canonical', target: target + '/master', result: r }); }],
    ['TRAILING_SLASH_CONFLICT', ctx => { ctx.project.canonicalPolicy.trailingSlash = 'with'; }],
    ['SITEMAP_URL_NOT_INDEXABLE', ctx => { ctx.analysis!.observation.facts!.noindex = true; }],
    ['TITLE_MISSING', ctx => { ctx.analysis!.observation.facts!.titlePresent = false; }],
    ['DESCRIPTION_MISSING', ctx => { ctx.analysis!.observation.facts!.descriptionPresent = false; }],
    ['H1_MISSING', ctx => { ctx.analysis!.observation.facts!.h1Count = 0; }],
    ['DUPLICATE_TITLE', ctx => { ctx.analysis!.titleGroup = { schemaVersion: '1.0', titleHash: ctx.analysis!.observation.facts!.titleHash!, count: 2, anchorUrl: target, otherUrl: target + '/other' }; }],
    ['JSONLD_PARSE_ERROR', ctx => { ctx.analysis!.observation.facts!.jsonLdParseErrors = 1; }],
    ['PRODUCT_RATING_COUNT_INVALID', ctx => { ctx.analysis!.observation.facts!.products = [{ path: '$', namePresent: true, rating: { hasValue: true, value: 5, countState: 'invalid' }, offers: [] }]; }],
    ['DUPLICATE_DOM_ID', ctx => { ctx.analysis!.observation.facts!.duplicateIdCount = 1; }],
    ['DUPLICATE_MANIFEST', ctx => { ctx.analysis!.observation.facts!.manifestCount = 2; }],
    ['ANCHOR_HREF_MISSING', ctx => { ctx.analysis!.observation.facts!.anchorWithoutHrefCount = 1; }],
    ['RESPONSE_CONTENT_TYPE_INVALID', ctx => { const r = ctx.analysis!.observation.result; if (r.status === 'fetched') r.evidence.contentType = 'application/json'; delete ctx.analysis!.observation.facts; }],
    ['IMAGE_ALT_MISSING', ctx => { ctx.analysis!.observation.facts!.imageMissingAltCount = 1; }],
    ['IMAGE_DIMENSIONS_MISSING', ctx => { ctx.analysis!.observation.facts!.imageMissingSizeCount = 1; }],
  ];
  it.each(cases)('%s reports a positive fixture and passes a healthy fixture', async (id, mutate) => {
    const good = context(); good.url.sourceSet.push('sitemap'); const bad = structuredClone(good); mutate(bad);
    expect(['pass', 'not_applicable']).toContain((await detect(id, good)).verdict);
    expect(['finding', 'needs_review']).toContain((await detect(id, bad)).verdict);
  });
  it('has no negative missing-field finding when the HTML parser hit a limit', async () => {
    const ctx = context('<html></html>'); ctx.analysis!.observation.facts!.truncated = true;
    const result = await new RuleEngine().evaluate(ctx); expect(result.errors).toContainEqual({ schemaVersion: '1.0', code: 'html_analysis_limit_or_encoding', url: target });
    for (const id of ['TITLE_MISSING', 'DESCRIPTION_MISSING', 'H1_MISSING', 'CANONICAL_MISSING']) expect(result.evaluations.find(e => e.ruleId === id)?.result.verdict).toBe('not_applicable');
  });
});
