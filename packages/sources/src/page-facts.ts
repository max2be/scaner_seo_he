import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';
import { HtmlFactsSchema, httpUrl, type HtmlFacts, type ProductFacts } from '@hsi/contracts';
/** This deliberately persists structural facts, never arbitrary page/script/input content. */
export function redactText(input: string, maximum = 4096): string {
  return input.replace(/https?:\/\/[^\s<>"']+/gi, value => {
    try { const url = new URL(value); url.username = ''; url.password = ''; url.hash = ''; for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]'); return url.href; } catch { return '[url]'; }
  }).replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(?:Bearer\s+\S+|(?:token|password|secret|api[_-]?key|cookie)\s*[:=]\s*[^\s,;<>]+)/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, '[redacted]').slice(0, maximum);
}
const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const hasType = (value: unknown, type: string) => (Array.isArray(value) ? value : [value]).some(v => typeof v === 'string' && (v === type || v === 'https://schema.org/' + type || v === 'http://schema.org/' + type));
export function availability(value: unknown): NonNullable<ProductFacts['offers'][number]['availability']> {
  if (typeof value !== 'string') return 'unknown';
  const token = value.replace(/^https?:\/\/schema\.org\//i, '').toLowerCase().replace(/[_\s-]/g, '');
  if (token === 'instock' || token === 'limitedavailability') return 'in_stock';
  if (token === 'outofstock' || token === 'soldout') return 'out_of_stock';
  if (token === 'preorder' || token === 'presale') return 'preorder';
  if (token === 'backorder') return 'backorder';
  if (token === 'discontinued') return 'discontinued'; return 'unknown';
}
function number(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())) { const parsed = Number(value); if (Number.isFinite(parsed)) return parsed; }
  return undefined;
}
function publicUrl(value: string, base: string) {
  try { const url = new URL(value, base); url.hash = ''; return httpUrl.safeParse(url.href).success ? url.href : undefined; } catch { return undefined; }
}
export function robotsDirectives(values: readonly string[], userAgent: string) {
  const agent = userAgent.split(/[\s/]/)[0]!.toLowerCase(); let noindex = false; let nofollow = false;
  for (const value of values) {
    let scope = '*';
    for (const part of value.toLowerCase().split(',')) {
      let text = part.trim(); const prefix = /^([a-z0-9_-]+):\s*(.*)$/.exec(text);
      if (prefix) { scope = prefix[1]!; text = prefix[2]!; }
      if (scope !== '*' && scope !== agent) continue;
      const tokens = text.split(/\s+/);
      noindex ||= tokens.includes('noindex') || tokens.includes('none'); nofollow ||= tokens.includes('nofollow') || tokens.includes('none');
    }
  }
  return { noindex, nofollow };
}
export interface PageParseOptions { userAgent: string; contentType?: string; xRobotsTag?: readonly string[]; notFoundMarker?: string }
export function parsePageFacts(body: Uint8Array, responseUrl: string, options: PageParseOptions): HtmlFacts {
  const directives = robotsDirectives(options.xRobotsTag ?? [], options.userAgent);
  const facts: HtmlFacts = { schemaVersion: '1.0', titlePresent: false, descriptionPresent: false, h1Count: 0,
    ...directives, noindexSources: directives.noindex ? ['http'] : [], canonicalInvalid: 0, canonicals: [], duplicateIdCount: 0, manifestCount: 0,
    anchorWithoutHrefCount: 0, buttonNavCount: 0, imageMissingAltCount: 0, imageMissingSizeCount: 0,
    contentCharacters: 0, soft404Signal: false, markerMatched: false, jsonLdParseErrors: 0, products: [], truncated: false };
  const ids = new Set<string>(); let title = ''; let heading = ''; let titleDepth = 0; let h1Depth = 0;
  let script = ''; let scriptType = ''; let inScript = false; let scriptOverflow = false; let scriptCount = 0; let ignored = 0;
  let base = responseUrl; let baseSeen = false; let bodyStarted = false; let textTail = '';
  const hidden = new Set(['style', 'template', 'nav', 'footer', 'svg']);
  const marker = options.notFoundMarker ? clean(options.notFoundMarker) : undefined;
  function pushProduct(node: Record<string, unknown>, path: string) {
    if (facts.products.length >= 100) { facts.truncated = true; return; }
    const product: ProductFacts = { path, namePresent: typeof node.name === 'string' && Boolean(node.name.trim()), offers: [] };
    if (typeof node.sku === 'string' && node.sku.length <= 200) product.sku = redactText(node.sku, 200);
    const rawUrl = typeof node.url === 'string' ? node.url : typeof node['@id'] === 'string' ? node['@id'] : undefined;
    const url = rawUrl ? publicUrl(rawUrl, base) : undefined; if (url) product.url = url;
    const rating = object(node.aggregateRating);
    if (rating) {
      const count = rating.ratingCount ?? rating.reviewCount;
      const validCount = [rating.ratingCount, rating.reviewCount].some(v => { const n = number(v); return n !== undefined && Number.isInteger(n) && n > 0; });
      const value = number(rating.ratingValue);
      product.rating = { hasValue: rating.ratingValue !== undefined, ...(value !== undefined ? { value } : {}),
        countState: validCount ? 'valid' : count === undefined ? 'missing' : 'invalid' };
    }
    const offers = Array.isArray(node.offers) ? node.offers : node.offers ? [node.offers] : [];
    if (offers.length > 100) facts.truncated = true;
    for (let i = 0; i < Math.min(offers.length, 100); i++) {
      const offer = object(offers[i]); if (!offer || (!hasType(offer['@type'], 'Offer') && !hasType(offer['@type'], 'AggregateOffer'))) continue;
      const price = number(offer.price); const currency = typeof offer.priceCurrency === 'string' && /^[A-Za-z]{3}$/.test(offer.priceCurrency) ? offer.priceCurrency.toUpperCase() : undefined;
      product.offers.push({ path: path + '.offers' + (Array.isArray(node.offers) ? '[' + i + ']' : ''),
        kind: hasType(offer['@type'], 'AggregateOffer') ? 'AggregateOffer' : 'Offer',
        ...(price !== undefined ? { price } : {}), ...(currency ? { currency } : {}),
        ...(offer.availability !== undefined ? { availability: availability(offer.availability) } : {}) });
    }
    facts.products.push(product);
  }
  function jsonLd() {
    if (scriptOverflow || ++scriptCount > 64) { facts.truncated = true; return; }
    let root: unknown; try { root = JSON.parse(script); } catch { facts.jsonLdParseErrors++; return; }
    const stack: { value: unknown; path: string; depth: number }[] = [{ value: root, path: '$', depth: 0 }]; let nodes = 0;
    while (stack.length) {
      if (++nodes > 10000) { facts.truncated = true; break; }
      const entry = stack.pop()!; if (entry.depth > 32 || entry.path.length > 900) { facts.truncated = true; continue; }
      if (Array.isArray(entry.value)) {
        if (entry.value.length > 10000) facts.truncated = true;
        const available = Math.max(0, 10000 - stack.length); if (entry.value.length > available) facts.truncated = true;
        for (let i = Math.min(entry.value.length, available) - 1; i >= 0; i--) stack.push({ value: entry.value[i], path: entry.path + '[' + i + ']', depth: entry.depth + 1 });
      } else {
        const node = object(entry.value); if (!node) continue;
        if (hasType(node['@type'], 'Product')) pushProduct(node, entry.path);
        for (const key of ['@graph', 'mainEntity', 'itemListElement', 'item', 'hasPart']) if (node[key] !== undefined)
          stack.push({ value: node[key], path: entry.path + '.' + key, depth: entry.depth + 1 });
      }
    }
  }
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === 'body') bodyStarted = true;
      if (hidden.has(name)) ignored++;
      if (attrs.id) {
        if (attrs.id.length > 200 || ids.size >= 20000) facts.truncated = true;
        else if (ids.has(attrs.id)) facts.duplicateIdCount++; else ids.add(attrs.id);
      }
      if (name === 'script') { inScript = true; scriptType = (attrs.type ?? '').toLowerCase().split(';')[0]!.trim(); script = ''; scriptOverflow = false; return; }
      if (name === 'base' && !baseSeen && attrs.href && !bodyStarted) { baseSeen = true; base = publicUrl(attrs.href, responseUrl) ?? responseUrl; }
      if (name === 'title' && !bodyStarted) titleDepth++;
      if (name === 'h1' && !ignored) { facts.h1Count++; h1Depth++; }
      if (name === 'meta' && !bodyStarted) {
        const metaName = (attrs.name ?? '').toLowerCase();
        if (metaName === 'description' && attrs.content?.trim()) facts.descriptionPresent = true;
        if (metaName === 'robots' || metaName === options.userAgent.split(/[\s/]/)[0]!.toLowerCase()) {
          const rules = robotsDirectives([attrs.content ?? ''], options.userAgent); facts.noindex ||= rules.noindex; facts.nofollow ||= rules.nofollow;
          if (rules.noindex && !facts.noindexSources.includes('meta')) facts.noindexSources.push('meta');
        }
      }
      if (name === 'link' && !bodyStarted) {
        const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
        if (rel.includes('manifest')) facts.manifestCount++;
        if (rel.includes('canonical')) {
          const raw = attrs.href?.trim(); const url = raw ? publicUrl(raw, base) : undefined;
          if (!url) facts.canonicalInvalid++;
          else if (facts.canonicals.length < 16) facts.canonicals.push({ url, absolute: /^https?:\/\//i.test(raw!), fragment: raw!.includes('#') });
          else facts.truncated = true;
        }
      }
      if (name === 'a' && !attrs.href?.trim()) facts.anchorWithoutHrefCount++;
      if (name === 'button' && (attrs['data-href'] || /(?:location(?:\.href)?\s*=|location\.(?:assign|replace)\s*\(|window\.open\s*\()/i.test(attrs.onclick ?? ''))) facts.buttonNavCount++;
      if (name === 'img') { if (attrs.alt === undefined) facts.imageMissingAltCount++; if (!attrs.width || !attrs.height) facts.imageMissingSizeCount++; }
    },
    ontext(text) {
      if (inScript) {
        if (scriptType === 'application/ld+json') { if (script.length + text.length > 256000) scriptOverflow = true; else if (!scriptOverflow) script += text; }
        return;
      }
      if (ignored) return;
      if (titleDepth) { if (title.length + text.length > 8192) facts.truncated = true; title = (title + text).slice(0, 8192); return; }
      if (h1Depth) heading = (heading + text).slice(0, 8192);
      const visible = clean(text); facts.contentCharacters += visible.length;
      if (marker) { const combined = clean(textTail + text); facts.markerMatched ||= combined.includes(marker); textTail = combined.slice(-2000); }
    },
    onclosetag(name) {
      if (name === 'script') { if (scriptType === 'application/ld+json') jsonLd(); scriptType = ''; script = ''; inScript = false; }
      if (hidden.has(name)) ignored = Math.max(0, ignored - 1);
      if (name === 'title') titleDepth = Math.max(0, titleDepth - 1);
      if (name === 'h1') h1Depth = Math.max(0, h1Depth - 1);
    },
  }, { decodeEntities: true });
  try {
    const charset = /;\s*charset\s*=\s*["']?([^;"'\s]+)/i.exec(options.contentType ?? '')?.[1] ?? 'utf-8';
    const decoder = new TextDecoder(charset, { fatal: true });
    for (let offset = 0; offset < body.length; offset += 16384) parser.write(decoder.decode(body.subarray(offset, offset + 16384), { stream: true }));
    parser.end(decoder.decode());
  } catch { facts.truncated = true; }
  title = clean(title); facts.titlePresent = Boolean(title);
  if (title) facts.titleHash = createHash('sha256').update(title.normalize('NFKC').toLocaleLowerCase('en')).digest('hex');
  facts.soft404Signal = /^(?:404\b|page\s+not\s+found|not\s+found\b|страниц[аы].{0,30}не\s+найден)/i.test(title) || /^(?:404\b|page\s+not\s+found|страниц[аы].{0,30}не\s+найден)/i.test(clean(heading));
  return HtmlFactsSchema.parse(facts);
}
