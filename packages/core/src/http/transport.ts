import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { PinnedTarget } from './policy.js';
import { sameAddress } from './policy.js';
import { HttpFailure } from './errors.js';
export interface BodySink { write(chunk: Buffer): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
export type BodySinkFactory = () => Promise<BodySink>;
export interface TransportResponse { status: number; xRobotsTag?: string[]; location?: string; retryAfter?: string; contentType: string;
  body: Buffer; bodyBytes?: number; bodySha256?: string; wireBytes: number; ttfbMs: number; totalMs: number }
export type Transport = (target: PinnedTarget, settings: { userAgent: string; maxBytes: number; timeoutMs: number; authorization?: string; sink?: BodySinkFactory }, signal: AbortSignal) => Promise<TransportResponse>;
function limitStream(maximum: number, count: (bytes: number) => void) {
  let size = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length; count(chunk.length);
    callback(size > maximum ? new HttpFailure('response_too_large') : null, chunk);
  } });
}
// Internal transport seam: custom CA is used only by local TLS fixtures, not ProjectConfig.
export function createNodeTransport(ca?: string): Transport {
  return (target, settings, signal) => new Promise((resolve, reject) => {
    const started = performance.now();
    const originalHost = target.url.hostname.replace(/^\[|\]$/g, '');
    const secure = target.url.protocol === 'https:';
    const options: https.RequestOptions = {
      protocol: target.url.protocol, hostname: target.address, family: target.family,
      port: target.url.port || (secure ? 443 : 80), path: target.url.pathname + target.url.search,
      method: 'GET', agent: false, signal, maxHeaderSize: 16384,
      headers: { Host: target.url.host, 'User-Agent': settings.userAgent, Accept: '*/*', 'Accept-Encoding': 'gzip, deflate, br', Connection: 'close', ...(settings.authorization ? { Authorization: settings.authorization } : {}) },
      rejectUnauthorized: true,
      checkServerIdentity: (_hostname, cert) => checkServerIdentity(originalHost, cert),
      ...(secure && !isIP(originalHost) ? { servername: originalHost } : {}),
      ...(ca ? { ca } : {}),
    };
    const request = (secure ? https.request : http.request)(options);
    const timeout = setTimeout(() => request.destroy(new HttpFailure('timeout')), settings.timeoutMs);
    let responseStarted = false;
    request.once('error', error => { clearTimeout(timeout); if (!responseStarted) reject(error); });
    request.on('socket', socket => {
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        if (!socket.remoteAddress || !sameAddress(socket.remoteAddress, target.address)) request.destroy(new HttpFailure('peer_address_mismatch'));
      });
    });
    request.setTimeout(settings.timeoutMs, () => request.destroy(new HttpFailure('timeout')));
    request.once('response', response => {
      responseStarted = true;
      response.on('error', () => {}); // pipeline will observe failures; guard the async sink-open gap
      const ttfbMs = performance.now() - started;
      void (async () => {
        let activeSink: BodySink | undefined;
        try {
          if (!request.socket?.remoteAddress || !sameAddress(request.socket.remoteAddress, target.address)) throw new HttpFailure('peer_address_mismatch');
          const status = response.statusCode ?? 0;
          if (status < 100 || status > 599) throw new HttpFailure('invalid_http_status');
          const location = response.headers.location;
          const retryAfter = response.headers['retry-after'];
          const contentType = (response.headers['content-type'] || '').slice(0, 200);
          const rawRobots = response.headers['x-robots-tag'];
          const xRobotsTag = (Array.isArray(rawRobots) ? rawRobots : rawRobots ? [rawRobots] : []).map(v => v.slice(0, 8192));
          // Redirect bodies have no diagnostic value; never buffer them.
          if ([301, 302, 303, 307, 308].includes(status)) {
            response.destroy(); clearTimeout(timeout);
            resolve({ status, ...(location ? { location } : {}), ...(retryAfter ? { retryAfter } : {}), contentType, body: Buffer.alloc(0), wireBytes: 0, ttfbMs, totalMs: performance.now() - started }); return;
          }
          const length = Number(response.headers['content-length']);
          if (Number.isFinite(length) && length > settings.maxBytes) throw new HttpFailure('response_too_large');
          const encoding = (response.headers['content-encoding'] || 'identity').trim().toLowerCase();
          const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
          if (!decoder && encoding !== 'identity') throw new HttpFailure('unsupported_content_encoding');
          let wireBytes = 0;
          const wire = limitStream(settings.maxBytes, bytes => { wireBytes += bytes; });
          const chunks: Buffer[] = [];
          const streaming = Boolean(settings.sink);
          // Error/redirect bodies must not be passed to source parsers or contaminate retries.
          if (settings.sink && status >= 200 && status < 300) activeSink = await settings.sink();
          const digest = createHash('sha256'); let bodyBytes = 0;
          const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
            digest.update(chunk);
            if (activeSink) activeSink.write(chunk).then(() => callback(), callback);
            else { if (!streaming) chunks.push(Buffer.from(chunk)); callback(); }
          } });
          const decoded = limitStream(settings.maxBytes, bytes => { bodyBytes += bytes; });
          if (decoder) await pipeline(response, wire, decoder, decoded, sink, { signal });
          else await pipeline(response, wire, decoded, sink, { signal });
          await activeSink?.close();
          signal.throwIfAborted();
          clearTimeout(timeout);
          resolve({ status, xRobotsTag, ...(retryAfter ? { retryAfter } : {}), contentType,
            body: Buffer.concat(chunks), bodyBytes, bodySha256: digest.digest('hex'), wireBytes, ttfbMs, totalMs: performance.now() - started });
        } catch (error) { clearTimeout(timeout); response.destroy(); await activeSink?.abort().catch(() => {}); reject(error); }
      })();
    });
    request.end();
  });
}
