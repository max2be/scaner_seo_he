import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { SaxesParser } from 'saxes';
import { SourceFailure } from './errors.js';
export interface SitemapEntry { kind: 'url' | 'sitemap'; url: string }
const namespace = 'http://www.sitemaps.org/schemas/sitemap/0.9';
async function* inflate(input: AsyncIterable<Uint8Array>) {
  const iterator = input[Symbol.asyncIterator]();
  let prefix = Buffer.alloc(0);
  while (prefix.length < 2) { const item = await iterator.next(); if (item.done) break; prefix = Buffer.concat([prefix, item.value]); }
  async function* rest() { try { yield prefix; while (true) { const next = await iterator.next(); if (next.done) break; yield next.value; } }
    finally { await iterator.return?.(); } }
  if (prefix[0] !== 0x1f || prefix[1] !== 0x8b) { yield* rest(); return; }
  const source = Readable.from(rest()); const gzip = createGunzip();
  source.on('error', error => gzip.destroy(error)); source.pipe(gzip);
  try { for await (const chunk of gzip) yield chunk as Buffer; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('Z_')) throw new SourceFailure('sitemap_gzip_invalid');
    throw error;
  }
  finally { source.destroy(); gzip.destroy(); }
}
/** Streaming SAX parser: no DOM, DTD, external entities, or project-global 50k cap. */
export async function parseSitemap(input: AsyncIterable<Uint8Array>, emit: (entry: SitemapEntry) => Promise<void>,
  limits: { maxEntries?: number; maxBytes?: number } = {}): Promise<void> {
  const maxEntries = Math.min(limits.maxEntries ?? 50000, 50000);
  const maxBytes = Math.min(limits.maxBytes ?? 50000000, 50000000);
  const parser = new SaxesParser({ xmlns: true });
  const stack: { local: string; uri: string }[] = []; const batch: SitemapEntry[] = [];
  let root = ''; let uri = ''; let entries = 0; let loc = ''; let locCount = 0; let capture = false;
  parser.on('doctype', () => { throw new SourceFailure('sitemap_doctype_forbidden'); });
  parser.on('xmldecl', declaration => { if (declaration.encoding && !/^utf-?8$/i.test(declaration.encoding)) throw new SourceFailure('sitemap_encoding_unsupported'); });
  parser.on('opentag', tag => {
    stack.push({ local: tag.local, uri: tag.uri });
    if (stack.length > 64) throw new SourceFailure('sitemap_depth_limit');
    if (stack.length === 1) {
      root = tag.local; uri = tag.uri;
      if (!['urlset', 'sitemapindex'].includes(root) || (uri && uri !== namespace)) throw new SourceFailure('sitemap_root_invalid');
    }
    if (stack.length > 3 && stack[2]?.local === 'loc') throw new SourceFailure('sitemap_loc_invalid');
    if (stack.length === 2) {
      if (tag.uri !== uri || tag.local !== (root === 'urlset' ? 'url' : 'sitemap')) throw new SourceFailure('sitemap_entry_invalid');
      if (++entries > maxEntries) throw new SourceFailure('sitemap_entry_limit');
      locCount = 0;
    }
    capture = stack.length === 3 && tag.uri === uri && tag.local === 'loc';
    if (capture) { loc = ''; if (++locCount > 1) throw new SourceFailure('sitemap_duplicate_loc'); }
  });
  const text = (value: string) => { if (capture) { loc += value; if (loc.length > 8192) throw new SourceFailure('sitemap_loc_limit'); } };
  parser.on('text', text); parser.on('cdata', text);
  parser.on('closetag', tag => {
    if (stack.length === 3 && capture && tag.local === 'loc') {
      let url: URL; try { url = new URL(loc.trim()); } catch { throw new SourceFailure('sitemap_loc_invalid'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new SourceFailure('sitemap_loc_invalid');
      batch.push({ kind: root === 'urlset' ? 'url' : 'sitemap', url: url.href });
    }
    if (stack.length === 2 && tag.uri === uri && locCount !== 1) throw new SourceFailure('sitemap_loc_missing');
    stack.pop(); capture = false;
  });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0; let token = 0;
  const decode = (chunk?: Uint8Array, stream = false) => {
    try { return decoder.decode(chunk, { stream }); } catch { throw new SourceFailure('sitemap_encoding_invalid'); }
  };
  const write = (value: string, finish = false) => {
    try { parser.write(value); if (finish) parser.close(); }
    catch (error) { if (error instanceof SourceFailure) throw error; throw new SourceFailure('sitemap_xml_invalid'); }
  };
  for await (const chunk of inflate(input)) {
    bytes += chunk.byteLength; if (bytes > maxBytes) throw new SourceFailure('sitemap_byte_limit');
    const value = decode(chunk, true);
    // Bound SAX lexical buffers as well as document size, including giant ignored text/comments.
    for (const char of value) { token = char === '<' || char === '>' ? 0 : token + 1; if (token > 65536) throw new SourceFailure('sitemap_token_limit'); }
    write(value);
    for (const entry of batch.splice(0)) await emit(entry);
  }
  write(decode(), true);
  if (!root) throw new SourceFailure('sitemap_empty');
  for (const entry of batch.splice(0)) await emit(entry);
}
