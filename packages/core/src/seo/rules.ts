import { createHash } from 'node:crypto';
import { FindingSchema, type Finding, type HtmlFacts, type ProductFacts, type HttpFetchMetadata } from '@hsi/contracts';
import type { Rule, RuleContext, RuleResult } from '../index.js';
type Signal = { expected: string; actual: string; source?: Finding['evidence']['source'];
  jsonPath?: string; excerpt?: string; sourcePage?: string; severity?: Finding['severity'];
  review?: boolean; p0Eligible?: boolean };
export function normalizedTarget(value: string, policy?: RuleContext['project']['canonicalPolicy']) {
  const url = new URL(value); url.hash = '';
  if (policy?.trailingSlash === 'without' && url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  if (policy?.trailingSlash === 'with' && !url.pathname.endsWith('/')) url.pathname += '/';
  url.searchParams.sort(); return url.href;
}
export function findingId(context: RuleContext, ruleId: string) {
  return 'sha256:' + createHash('sha256').update(JSON.stringify([context.project.id, ruleId,
    normalizedTarget(context.url.normalizedUrl, context.project.canonicalPolicy), context.entity?.type ?? null, context.entity?.id ?? null])).digest('hex');
}
const pass = (): RuleResult => ({ verdict: 'pass' });
const na = (): RuleResult => ({ verdict: 'not_applicable' });
function facts(ctx: RuleContext) { return ctx.analysis?.observation.facts; }
function http(ctx: RuleContext) { const result = ctx.analysis?.observation.result; return result?.status === 'fetched' ? result : undefined; }
function status(ctx: RuleContext) { return http(ctx)?.evidence.httpStatus; }
export function trustedEntity(ctx: RuleContext) {
  return Boolean(ctx.entity && ctx.analysis?.coverage.backendComplete && ctx.analysis.coverage.snapshotConsistency === 'consistent');
}
function candidateEntity(ctx: RuleContext) { return Boolean(ctx.entity && ctx.analysis?.coverage.backendComplete && ctx.analysis.coverage.snapshotConsistency !== 'changed'); }
function candidateIndexable(ctx: RuleContext) { return Boolean(candidateEntity(ctx) && ctx.entity?.publicationState === 'published' && ctx.entity.expectedIndexable === true && (ctx.entity.expectedStatus ?? 200) === 200); }
export function expectedIndexable(ctx: RuleContext) {
  return Boolean(trustedEntity(ctx) && ctx.entity?.publicationState === 'published' && ctx.entity.expectedIndexable === true && (ctx.entity.expectedStatus ?? 200) === 200);
}
function expectedPage(ctx: RuleContext) { return ctx.url.sourceSet.includes('seed') || ctx.url.sourceSet.includes('sitemap') || (ctx.url.sourceSet.includes('backend') && ctx.analysis?.coverage.backendComplete && ctx.analysis.indexableExpected !== false) || (candidateEntity(ctx) && ctx.entity?.publicationState === 'published'); }
function html(ctx: RuleContext) { return status(ctx) === 200 && Boolean(facts(ctx)) && !ctx.analysis?.profile.unknownRouteProbes.some(p => p.url === ctx.url.url); }
function indexable(ctx: RuleContext) { return html(ctx) && ctx.analysis?.indexableExpected !== false && !facts(ctx)?.noindex && ctx.entity?.expectedIndexable !== false && (!ctx.entity || ctx.entity.publicationState === 'published'); }
function completeHtml(ctx: RuleContext) { return indexable(ctx) && !facts(ctx)?.truncated; }
function missingConfirmed(ctx: RuleContext) {
  const result = http(ctx); if (!result || ![404, 410].includes(result.evidence.httpStatus)) return false;
  const terminal = result.attempts.filter(a => a.url === result.evidence.responseUrl && a.httpStatus === result.evidence.httpStatus);
  return terminal.length >= 2;
}
export function p0Allowed(ctx: RuleContext, ruleId: string) {
  return expectedIndexable(ctx) && ((ruleId === 'EXPECTED_PAGE_NOT_200' && missingConfirmed(ctx)) || (ruleId === 'NOINDEX_EXPECTED_PAGE' && status(ctx) === 200 && facts(ctx)?.noindex === true));
}
function safeEvidenceUrl(value: string) {
  const url = new URL(value); url.hash = ''; for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]'); return url.href;
}
function emit(ctx: RuleContext, rule: Rule, signal: Signal): RuleResult {
  let severity = ctx.analysis?.profile.severityOverrides[rule.id] ?? signal.severity ?? rule.severityDefault;
  if (severity === 'P0' && (!signal.p0Eligible || signal.review)) severity = 'P1';
  const timestamp = http(ctx)?.evidence.timestamp ?? ctx.analysis?.observation.result.attempts.at(-1)?.timestamp ?? '1970-01-01T00:00:00.000Z';
  const finding = FindingSchema.parse({ schemaVersion: '1.0', id: findingId(ctx, rule.id), scanId: ctx.url.scanId,
    projectId: ctx.project.id, ruleId: rule.id, ruleVersion: rule.version, severity,
    verdict: signal.review ? 'needs_review' : 'finding', confidence: signal.review ? 'medium' : 'high', url: safeEvidenceUrl(ctx.url.normalizedUrl),
    ...(ctx.entity ? { entity: { type: ctx.entity.type, id: ctx.entity.id } } : {}),
    expected: signal.expected, actual: signal.actual,
    evidence: { source: signal.source ?? 'server_html', ...(status(ctx) ? { httpStatus: status(ctx) } : {}),
      ...(signal.jsonPath ? { jsonPath: signal.jsonPath } : {}), ...(signal.excerpt ? { excerpt: signal.excerpt } : {}),
      ...(signal.sourcePage ? { sourcePage: safeEvidenceUrl(signal.sourcePage) } : {}) },
    suggestionKey: rule.recommendationKey, firstSeenAt: timestamp, lastSeenAt: timestamp });
  return finding.verdict === 'needs_review' ? { verdict: 'needs_review', finding: finding as Finding & { verdict: 'needs_review' } } : { verdict: 'finding', finding: finding as Finding & { verdict: 'finding' } };
}
function rule(id: string, severityDefault: Finding['severity'], applies: (ctx: RuleContext) => boolean,
  detect: (ctx: RuleContext) => Signal | undefined): Rule {
  const value: Rule = { id, version: '1.0.0', severityDefault, recommendationKey: id.toLowerCase().replaceAll('_', '-'),
    appliesTo: ctx => Boolean(ctx.analysis) && applies(ctx), async detect(ctx) {
      if (!value.appliesTo(ctx)) return na(); const signal = detect(ctx); return signal ? emit(ctx, value, signal) : pass();
    } }; return value;
}
const count = (predicate: (f: HtmlFacts) => number, expected: string) => (ctx: RuleContext): Signal | undefined => {
  const n = predicate(facts(ctx)!); return n ? { expected, actual: 'observed_count=' + n } : undefined;
};
const missing = (predicate: (f: HtmlFacts) => boolean, expected: string) => (ctx: RuleContext): Signal | undefined => predicate(facts(ctx)!) ? undefined : { expected, actual: 'missing_or_empty' };
function canonicalConflict(ctx: RuleContext): Signal | undefined {
  const f = facts(ctx)!; const policy = ctx.project.canonicalPolicy;
  if (f.canonicalInvalid || f.canonicals.some(c => !c.absolute || c.fragment)) return { expected: 'One valid absolute canonical URL without a fragment', actual: 'invalid_canonical', severity: 'P1' };
  const targets = [...new Set(f.canonicals.map(c => normalizedTarget(c.url)))];
  if (targets.length > 1) return { expected: 'A single consistent canonical target', actual: 'conflicting_canonical_targets=' + targets.length, severity: 'P1' };
  const target = targets[0]; if (!target) return;
  const parsed = new URL(target);
  if (parsed.protocol !== policy.expectedScheme + ':' || parsed.hostname !== policy.preferredHost ||
    (policy.trailingSlash === 'without' && parsed.pathname !== '/' && parsed.pathname.endsWith('/')) ||
    (policy.trailingSlash === 'with' && !parsed.pathname.endsWith('/')))
    return { expected: 'Canonical agrees with configured scheme/host/trailingSlash', actual: 'canonical_policy_mismatch' };
  const expected = trustedEntity(ctx) ? ctx.entity?.canonicalUrl : undefined;
  const current = http(ctx)!.evidence.responseUrl;
  const selfMatches = ctx.analysis!.observation.responseIdentity
    ? createHash('sha256').update(normalizedTarget(target)).digest('hex') === ctx.analysis!.observation.responseIdentity
    : normalizedTarget(target) === normalizedTarget(current);
  if ((expected && normalizedTarget(target) !== normalizedTarget(expected)) || (policy.checkSelfCanonical && !selfMatches))
    return { expected: 'Canonical agrees with explicit entity/self-canonical policy', actual: 'canonical_target_mismatch' };
}
function broken(result: HttpFetchMetadata) { return result.status === 'fetched' ? [404, 410].includes(result.evidence.httpStatus) || result.evidence.httpStatus >= 500 : result.status === 'fetch_error' && result.errorCode === 'redirect_loop'; }
function productData(ctx: RuleContext): Signal | undefined {
  const data = ctx.entity?.data; if (!data || ctx.entity?.type !== 'product') return;
  const products = facts(ctx)!.products;
  const identity = (p: ProductFacts) => (data.sku && p.sku === data.sku) || (p.url && normalizedTarget(p.url, ctx.project.canonicalPolicy) === normalizedTarget(ctx.entity!.url, ctx.project.canonicalPolicy));
  const matches = products.filter(identity); const product = matches.length === 1 ? matches[0] : products.length === 1 ? products[0] : undefined;
  if (!product) return;
  const offers = product.offers.filter(o => o.kind === 'Offer');
  if (!offers.length) return;
  const offer = offers[0]!; const differences: string[] = [];
  if (data.currency && offer.currency && data.currency !== offer.currency) differences.push('currency');
  if (data.price !== undefined && offer.price !== undefined && data.price !== offer.price) differences.push('price');
  const expectedAvailability = normalizeAvailability(data.availability);
  if (expectedAvailability !== 'unknown' && offer.availability && offer.availability !== 'unknown' && expectedAvailability !== offer.availability) differences.push('availability');
  if (!differences.length) return;
  const comparable = matches.length === 1 && offers.length === 1 && product.offers.length === 1 &&
    (!differences.includes('price') || (data.currency !== undefined && offer.currency === data.currency));
  return { expected: 'Backend ' + JSON.stringify({ price: data.price, currency: data.currency, availability: expectedAvailability }) + '; mismatches=' + differences.join(','), actual: 'Product/Offer ' + JSON.stringify({ price: offer.price, currency: offer.currency, availability: offer.availability }),
    source: 'backend', jsonPath: offer.path, review: !comparable || !trustedEntity(ctx) };
}
function normalizeAvailability(value: unknown) {
  if (typeof value !== 'string') return 'unknown'; const token = value.replace(/^https?:\/\/schema\.org\//i, '').toLowerCase().replace(/[_\s-]/g, '');
  if (['instock', 'limitedavailability'].includes(token)) return 'in_stock';
  if (['outofstock', 'soldout'].includes(token)) return 'out_of_stock';
  if (['preorder', 'presale'].includes(token)) return 'preorder';
  if (token === 'backorder') return 'backorder'; if (token === 'discontinued') return 'discontinued'; return 'unknown';
}
export const seoRules: readonly Rule[] = [
  rule('EXPECTED_PAGE_NOT_200', 'P1', ctx => candidateIndexable(ctx) && status(ctx) !== undefined,
    ctx => status(ctx) === 200 ? undefined : { expected: 'Published expected-indexable entity returns HTTP 200', actual: 'http_status=' + status(ctx), source: 'backend',
      severity: expectedIndexable(ctx) && missingConfirmed(ctx) ? 'P0' : 'P1', p0Eligible: expectedIndexable(ctx) && missingConfirmed(ctx), review: !trustedEntity(ctx) || (!missingConfirmed(ctx) && [404, 410].includes(status(ctx)!)) }),
  rule('HTTP_SERVER_ERROR', 'P1', ctx => expectedPage(ctx) && status(ctx) !== undefined, ctx => status(ctx)! >= 500 ? { expected: 'Expected page does not return 5xx', actual: 'http_status=' + status(ctx), source: 'http' } : undefined),
  rule('REDIRECT_LOOP', 'P1', ctx => ctx.analysis?.observation.result.status === 'fetch_error', ctx => ctx.analysis!.observation.result.status === 'fetch_error' && ctx.analysis!.observation.result.errorCode === 'redirect_loop' ? { expected: 'Redirect chain terminates', actual: 'redirect_loop_observed', source: 'http' } : undefined),
  rule('REDIRECT_CHAIN_LONG', 'P2', ctx => expectedPage(ctx), ctx => ctx.analysis!.observation.result.redirectChain.length > ctx.analysis!.profile.maxRedirectHops ? { expected: 'Redirect chain within configured hop threshold', actual: 'redirect_hops=' + ctx.analysis!.observation.result.redirectChain.length, source: 'http' } : undefined),
  rule('UNKNOWN_ROUTE_RETURNS_200', 'P1', ctx => status(ctx) === 200 && ctx.analysis!.profile.unknownRouteProbes.some(p => p.url === ctx.url.url), ctx => {
    const probe = ctx.analysis!.profile.unknownRouteProbes.find(p => p.url === ctx.url.url)!;
    return { expected: 'Explicit control route reports a missing resource', actual: facts(ctx)?.markerMatched ? 'http_200_with_configured_missing_marker' : 'http_200_without_confirmed_missing_marker', review: !probe.notFoundMarker || !facts(ctx)?.markerMatched, source: 'http' };
  }),
  rule('SOFT_404_SUSPECTED', 'P2', ctx => status(ctx) === 200 && Boolean(facts(ctx)), ctx => facts(ctx)!.soft404Signal && !ctx.analysis!.profile.unknownRouteProbes.some(p => p.url === ctx.url.url) ? { expected: 'HTTP status agrees with page meaning', actual: 'not_found_signal_in_title_or_h1', review: true } : undefined),
  rule('CANONICAL_MISSING', 'P2', completeHtml, ctx => facts(ctx)!.canonicals.length || facts(ctx)!.canonicalInvalid ? undefined : { expected: 'Canonical link when required by project', actual: 'canonical_missing', severity: ctx.project.canonicalPolicy.checkSelfCanonical ? 'P2' : 'INFO' }),
  rule('CANONICAL_CONFLICT', 'P2', indexable, canonicalConflict),
  rule('CANONICAL_TARGET_BROKEN', 'P1', indexable, ctx => { const check = ctx.analysis!.observation.checks.find(c => c.kind === 'canonical'); return check && broken(check.result) ? { expected: 'Canonical target is accessible', actual: check.result.status === 'fetched' ? 'canonical_http_status=' + check.result.evidence.httpStatus : 'canonical_redirect_loop', source: 'http' } : undefined; }),
  rule('TRAILING_SLASH_CONFLICT', 'P2', ctx => indexable(ctx) && ['with', 'without'].includes(ctx.project.canonicalPolicy.trailingSlash), ctx => {
    const current = new URL(http(ctx)!.evidence.responseUrl).pathname; const wantSlash = ctx.project.canonicalPolicy.trailingSlash === 'with';
    const wrong = current !== '/' && current.endsWith('/') !== wantSlash;
    const variant = ctx.analysis!.observation.checks.find(c => c.kind === 'trailing_slash');
    const alias = variant?.result.status === 'fetched' && variant.result.evidence.httpStatus === 200 && variant.result.redirectChain.length === 0;
    const misplaced = variant?.result.status === 'fetched' && variant.result.evidence.httpStatus === 200 && variant.result.redirectChain.length > 0 && normalizedTarget(variant.result.evidence.responseUrl, ctx.project.canonicalPolicy) !== normalizedTarget(http(ctx)!.evidence.responseUrl, ctx.project.canonicalPolicy);
    return wrong || alias || misplaced ? { expected: 'HTTP routing agrees with explicit trailingSlash policy', actual: wrong ? 'nonpreferred_page_form_returns_200' : misplaced ? 'slash_variant_redirects_to_other_target' : 'both_slash_forms_return_200', source: 'http' } : undefined;
  }),
  rule('SITEMAP_URL_NOT_INDEXABLE', 'P1', ctx => ctx.url.sourceSet.includes('sitemap') && status(ctx) !== undefined, ctx => {
    if ([404, 410].includes(status(ctx)!) || status(ctx)! >= 500 || facts(ctx)?.noindex) return { expected: 'Sitemap URL is accessible and not noindex', actual: facts(ctx)?.noindex ? 'sitemap_page_noindex' : 'sitemap_http_status=' + status(ctx), source: 'sitemap' };
    const canonical = facts(ctx)?.canonicals[0]?.url;
    if (http(ctx)!.redirectChain.length && canonical && (ctx.analysis!.observation.responseIdentity ? createHash('sha256').update(normalizedTarget(canonical)).digest('hex') !== ctx.analysis!.observation.responseIdentity : normalizedTarget(canonical) !== normalizedTarget(http(ctx)!.evidence.responseUrl))) return { expected: 'Sitemap redirect terminates at canonical', actual: 'redirect_canonical_mismatch', source: 'sitemap', severity: 'P2' };
  }),
  rule('EXPECTED_URL_MISSING_FROM_SITEMAP', 'P2', ctx => candidateIndexable(ctx) && ctx.project.discovery.sitemapUrls.length > 0 && ctx.analysis!.coverage.sitemapComplete, ctx => ctx.url.sourceSet.includes('sitemap') ? undefined : { expected: 'Expected entity URL appears in agreed complete sitemaps', actual: 'expected_url_not_in_sitemap', source: 'sitemap', review: !trustedEntity(ctx) }),
  rule('BROKEN_INTERNAL_LINK', 'P2', ctx => Boolean(ctx.analysis!.provenance?.source === 'link' && ctx.analysis!.provenance.sourceUrl) && [404, 410].includes(status(ctx) ?? 0), ctx => ({ expected: 'Discovered internal HTTP link resolves', actual: 'linked_http_status=' + status(ctx), source: 'http', sourcePage: ctx.analysis!.provenance!.sourceUrl! })),
  rule('ROBOTS_DISALLOWED_EXPECTED', 'P1', candidateIndexable, ctx => ctx.analysis!.observation.result.status === 'skipped_robots' ? { expected: 'Expected-indexable URL is allowed for this request profile', actual: 'robots_disallowed_for_scanner_profile', source: 'robots', review: !trustedEntity(ctx) } : undefined),
  rule('NOINDEX_EXPECTED_PAGE', 'P1', ctx => candidateIndexable(ctx) && html(ctx), ctx => facts(ctx)!.noindex ? { expected: 'Expected-indexable page has no applicable noindex directive', actual: 'applicable_noindex:' + facts(ctx)!.noindexSources.join(','), source: facts(ctx)!.noindexSources.includes('http') ? 'http' : 'server_html', p0Eligible: trustedEntity(ctx), review: !trustedEntity(ctx) } : undefined),
  rule('TITLE_MISSING', 'P2', completeHtml, missing(f => f.titlePresent, 'Nonempty title on HTML landing page')),
  rule('DESCRIPTION_MISSING', 'P2', completeHtml, missing(f => f.descriptionPresent, 'Nonempty meta description')),
  rule('H1_MISSING', 'P2', completeHtml, missing(f => f.h1Count > 0, 'At least one H1; multiple H1 are permitted')),
  rule('DUPLICATE_TITLE', 'P2', completeHtml, ctx => {
    const group = ctx.analysis!.titleGroup;
    return group && group.count > 1 && group.anchorUrl === ctx.url.normalizedUrl ? { expected: 'Distinct titles across distinct indexable landing URLs', actual: 'same_title_url_count=' + group.count, ...(group.otherUrl ? { sourcePage: group.otherUrl } : {}) } : undefined;
  }),
  rule('JSONLD_PARSE_ERROR', 'P2', html, count(f => f.jsonLdParseErrors, 'Valid application/ld+json JSON')),
  rule('PRODUCT_RATING_COUNT_MISSING', 'P1', html, ctx => {
    const product = facts(ctx)!.products.find(p => p.rating?.hasValue && p.rating.countState === 'missing');
    return product ? { expected: 'aggregateRating includes ratingCount or reviewCount', actual: 'rating_value=' + (product.rating?.value ?? 'non_numeric') + ';count_missing', jsonPath: product.path + '.aggregateRating', excerpt: JSON.stringify({ aggregateRating: { ratingValue: product.rating?.value ?? 'non_numeric' } }) } : undefined;
  }),
  rule('PRODUCT_RATING_COUNT_INVALID', 'P1', html, ctx => {
    const product = facts(ctx)!.products.find(p => p.rating?.hasValue && p.rating.countState === 'invalid');
    return product ? { expected: 'Positive integral ratingCount or reviewCount', actual: 'rating_count_invalid', jsonPath: product.path + '.aggregateRating' } : undefined;
  }),
  rule('PRODUCT_DATA_CONFLICT', 'P1', ctx => html(ctx) && candidateEntity(ctx) && ctx.entity?.publicationState === 'published', productData),
  rule('DUPLICATE_DOM_ID', 'P2', html, count(f => f.duplicateIdCount, 'Unique DOM id attributes within source HTML')),
  rule('DUPLICATE_MANIFEST', 'INFO', html, ctx => facts(ctx)!.manifestCount > 1 ? { expected: 'At most one manifest link', actual: 'manifest_count=' + facts(ctx)!.manifestCount } : undefined),
  rule('BUTTON_NAV_SUSPECTED', 'P2', html, ctx => facts(ctx)!.buttonNavCount ? { expected: 'Review navigation semantics with rendered application', actual: 'source_button_navigation_hint_count=' + facts(ctx)!.buttonNavCount, review: true } : undefined),
  rule('ANCHOR_HREF_MISSING', 'INFO', html, ctx => facts(ctx)!.anchorWithoutHrefCount ? { expected: 'Review anchors without href; named anchors/actions may be intentional', actual: 'anchor_without_href_count=' + facts(ctx)!.anchorWithoutHrefCount, review: true } : undefined),
  rule('SSR_CONTENT_MISSING', 'P2', ctx => candidateIndexable(ctx) && html(ctx), ctx => facts(ctx)!.contentCharacters < 80 && facts(ctx)!.products.length === 0 ? { expected: 'Review whether expected content is available in server HTML', actual: 'limited_server_html_content', review: true } : undefined),
  rule('RESPONSE_CONTENT_TYPE_INVALID', 'P2', ctx => expectedPage(ctx) && status(ctx) === 200 && !/\.(?:pdf|xml|json|jpe?g|png|webp|svg|gif|zip|css|js)$/i.test(new URL(ctx.url.url).pathname), ctx => /^text\/html(?:;|$)|^application\/xhtml\+xml(?:;|$)/i.test(http(ctx)!.evidence.contentType) ? undefined : { expected: 'HTML content type for a landing page', actual: 'unexpected_response_content_type', source: 'http' }),
  rule('IMAGE_ALT_MISSING', 'P2', html, count(f => f.imageMissingAltCount, 'alt attribute exists; empty decorative alt is allowed')),
  rule('IMAGE_DIMENSIONS_MISSING', 'INFO', html, count(f => f.imageMissingSizeCount, 'Review explicit image dimensions; no browser layout claim')),
];
