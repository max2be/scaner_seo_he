import { Parser } from 'htmlparser2';
export interface HtmlLink { href: string; nofollow: boolean }
/** No DOM/JS/assets. Two tokenizer passes resolve the first base and bound queued links by chunk. */
export function parseLinks(body: Buffer, responseUrl: string): { base: string; links: Iterable<HtmlLink> } {
  let base = responseUrl; let foundBase = false;
  const baseParser = new Parser({ onopentag(name, attributes) {
    if (name === 'base' && attributes.href && !foundBase) {
      foundBase = true; try { base = new URL(attributes.href, responseUrl).href; } catch { /* retain response URL */ }
    }
  } }, { decodeEntities: true });
  const firstDecoder = new TextDecoder();
  for (let offset = 0; offset < body.length; offset += 16384) baseParser.write(firstDecoder.decode(body.subarray(offset, offset + 16384), { stream: true }));
  baseParser.end(firstDecoder.decode());
  function* links() {
    const batch: HtmlLink[] = [];
    const parser = new Parser({ onopentag(name, attributes) {
      if (name === 'a' && attributes.href) batch.push({ href: attributes.href,
        nofollow: (attributes.rel ?? '').toLowerCase().split(/\s+/).includes('nofollow') });
    } }, { decodeEntities: true });
    const decoder = new TextDecoder();
    for (let offset = 0; offset < body.length; offset += 16384) {
      parser.write(decoder.decode(body.subarray(offset, offset + 16384), { stream: true }));
      yield* batch.splice(0);
    }
    parser.end(decoder.decode()); yield* batch;
  }
  return { base, links: links() };
}
