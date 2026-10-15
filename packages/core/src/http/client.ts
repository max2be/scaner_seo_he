import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import robotsParser from 'robots-parser';
import { ProjectConfigSchema, HttpFetchResultSchema, type HttpFetchMetadata, type HttpAttempt, type ProjectConfig } from '@hsi/contracts';
import { HttpFailure, errorCode } from './errors.js';
import { evidenceUrl, resolveTarget, systemResolver, validateTarget, type Resolver } from './policy.js';
import { createNodeTransport, type Transport, type TransportResponse, type BodySinkFactory } from './transport.js';
import { RequestScheduler } from './scheduler.js';

type Chain = Extract<HttpFetchMetadata, { status: 'fetched' }>['redirectChain'];
type FetchOptions = { signal?: AbortSignal; confirmExpectedMissing?: boolean };
export type HttpFetchResult =
  | (Extract<HttpFetchMetadata, { status: 'fetched' }> & { readonly body: Buffer })
  | (Exclude<HttpFetchMetadata, { status: 'fetched' }> & { readonly body?: never });
interface Dependencies { resolver?: Resolver; transport?: Transport; random?: () => number }
interface RobotsTrace { attempts: HttpAttempt[]; origins: Set<string> }
interface Circuit { failures: number; until: number }
interface Page { url: URL; response: TransportResponse; timestamp: string; chain: Chain }
interface RobotsRules { isAllowed(url: string, userAgent: string): boolean | undefined }
// Upstream CJS declaration is not callable under NodeNext; narrow its runtime default export.
const parseRobots = robotsParser as unknown as (url: string, content: string) => RobotsRules;
const transient = new Set([429, 500, 502, 503, 504]);
const redirect = new Set([301, 302, 303, 307, 308]);
const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex');
export function retryDelay(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : Math.max(0, parsed - now);
}

/** Public-site GET client. Create one instance per project/run, shared by all scan requests. */
export class SafeHttpClient {
  private readonly project: ProjectConfig;
  private readonly resolver: Resolver;
  private readonly transport: Transport;
  private readonly random: () => number;
  private readonly scheduler: RequestScheduler;
  private originLock?: string;
  private authorization?: string;
  private readonly circuits = new Map<string, Circuit>();
  private readonly robots = new Map<string, { expires: number; attempts: HttpAttempt[]; pending: Promise<RobotsRules | 'allow' | 'deny'> }>();
  constructor(project: ProjectConfig, dependencies: Dependencies = {}) {
    this.project = ProjectConfigSchema.parse(project);
    this.resolver = dependencies.resolver ?? systemResolver;
    this.transport = dependencies.transport ?? createNodeTransport();
    this.random = dependencies.random ?? Math.random;
    if (!Number.isFinite(1000 / this.project.http.requestsPerSecondPerHost)) throw new HttpFailure('unsupported_rate_interval');
    this.scheduler = new RequestScheduler(this.project.http.concurrency, 1000 / this.project.http.requestsPerSecondPerHost);
  }
  static forBackend(projectInput: ProjectConfig, readToken: (name: string) => string | undefined = name => process.env[name], dependencies: Dependencies = {}): SafeHttpClient {
    const project = ProjectConfigSchema.parse(projectInput); const backend = project.sources.backend;
    if (!backend?.enabled) throw new HttpFailure('backend_disabled');
    const origin = new URL(backend.endpoint).origin;
    let authorization: string | undefined;
    if (backend.auth?.type === 'bearer') {
      const token = readToken(backend.auth.tokenEnv);
      if (!token || token.length > 8192 || /[\r\n]/.test(token)) throw new HttpFailure('backend_credential_unavailable');
      authorization = `Bearer ${token}`;
    }
    const client = new SafeHttpClient({ ...project, baseUrl: backend.endpoint, allowedHosts: backend.allowedHosts,
      discovery: { ...project.discovery, sitemapUrls: [], seedUrls: [] },
      canonicalPolicy: { ...project.canonicalPolicy, preferredHost: new URL(backend.endpoint).hostname },
      http: { ...project.http, respectRobots: false }, sources: {} }, dependencies);
    client.originLock = origin;
    if (authorization) client.authorization = authorization;
    return client;
  }
  private circuit(host: string): Circuit {
    const circuit = this.circuits.get(host) ?? { failures: 0, until: 0 };
    this.circuits.set(host, circuit); return circuit;
  }
  private recordFailure(host: string, failed: boolean) {
    const state = this.circuit(host);
    state.failures = failed ? state.failures + 1 : 0;
    if (state.failures >= 5) state.until = Date.now() + 60000;
  }
  private async one(url: URL, attempts: HttpAttempt[], maxBytes: number, external?: AbortSignal, sink?: BodySinkFactory): Promise<TransportResponse> {
    if (this.originLock && (url.origin !== this.originLock || url.protocol !== 'https:')) throw new HttpFailure('backend_origin_changed');
    return this.scheduler.run(url.hostname, async () => {
      const circuit = this.circuit(url.hostname);
      if (circuit.until > Date.now()) throw new HttpFailure('circuit_open');
      if (circuit.until) { circuit.until = 0; circuit.failures = 0; }
      const started = performance.now(); const timestamp = new Date().toISOString();
      const controller = new AbortController();
      const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
      const timer = setTimeout(() => controller.abort(new HttpFailure('timeout')), this.project.http.timeoutMs);
      let abortListener: () => void = () => {};
      let pendingTransport: Promise<TransportResponse> | undefined;
      try {
        const aborted = new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(signal.reason);
          signal.addEventListener('abort', abortListener, { once: true });
        });
        signal.throwIfAborted();
        const response = await Promise.race([aborted, (async () => {
          const target = await resolveTarget(url, this.resolver, signal);
          signal.throwIfAborted();
          const dnsMs = performance.now() - started;
          pendingTransport = this.transport(target, { userAgent: this.project.http.userAgent, maxBytes, timeoutMs: this.project.http.timeoutMs, ...(this.authorization ? { authorization: this.authorization } : {}), ...(sink ? { sink } : {}) }, signal);
          const received = await pendingTransport;
          return { ...received, ttfbMs: received.ttfbMs + dnsMs, totalMs: received.totalMs + dnsMs };
        })()]);
        attempts.push({ url: evidenceUrl(url), timestamp, httpStatus: response.status, ttfbMs: response.ttfbMs,
          totalMs: performance.now() - started, bodySha256: response.bodySha256 ?? hash(response.body) });
        this.recordFailure(url.hostname, transient.has(response.status));
        if (transient.has(response.status)) {
          const wait = retryDelay(response.retryAfter);
          if (wait !== undefined) {
            if (wait > 60000) this.circuit(url.hostname).until = Date.now() + wait;
            else this.scheduler.defer(url.hostname, wait);
          }
        }
        return response;
      } catch (error) {
        if (signal.aborted && pendingTransport) await pendingTransport.catch(() => {});
        const code = signal.aborted ? external?.aborted ? 'canceled' : 'timeout' : errorCode(error);
        attempts.push({ url: evidenceUrl(url), timestamp, errorCode: code, totalMs: performance.now() - started });
        if (['network_error', 'timeout'].includes(code)) this.recordFailure(url.hostname, true);
        throw new HttpFailure(code);
      } finally { clearTimeout(timer); signal.removeEventListener('abort', abortListener); }
    }, external);
  }
  private async request(url: URL, attempts: HttpAttempt[], maxBytes: number, signal?: AbortSignal, sink?: BodySinkFactory): Promise<TransportResponse> {
    const retries = Math.min(this.project.http.maxRetries, 2);
    for (let index = 0; ; index++) {
      const response = await this.one(url, attempts, maxBytes, signal, sink);
      if (!transient.has(response.status) || index >= retries) return response;
      const retryAfter = retryDelay(response.retryAfter);
      if (retryAfter !== undefined && retryAfter > 60000) throw new HttpFailure('retry_after_exceeds_budget');
      const backoff = 250 * 2 ** index + Math.floor(Math.max(0, Math.min(1, this.random())) * 100);
      await delay(Math.max(retryAfter ?? 0, backoff), undefined, { signal });
    }
  }
  private async robotsAllowed(url: URL, trace: RobotsTrace | undefined, signal?: AbortSignal): Promise<boolean> {
    if (!this.project.http.respectRobots) return true;
    const cached = this.robots.get(url.origin);
    let entry = cached && cached.expires > Date.now() ? cached : undefined;
    if (!entry) {
      const attempts: HttpAttempt[] = [];
      const pending = (async () => {
        const page = await this.follow(new URL('/robots.txt', url), attempts, [], true, signal);
        if (page.response.status === 404 || page.response.status === 410) return 'allow' as const;
        if (page.response.status === 401 || page.response.status === 403) return 'deny' as const;
        if (page.response.status < 200 || page.response.status >= 300) throw new HttpFailure('robots_unavailable');
        const body = page.response.body.toString('utf8');
        if (page.response.contentType.includes('text/html') || /^\s*<(?:!doctype|html)/i.test(body)) throw new HttpFailure('robots_unavailable');
        return parseRobots(new URL('/robots.txt', url).href, body);
      })();
      entry = { expires: Date.now() + 3600000, attempts, pending };
      this.robots.set(url.origin, entry);
    }
    try {
      const parser = await entry.pending;
      signal?.throwIfAborted();
      return parser === 'allow' || (parser !== 'deny' && parser.isAllowed(url.href, this.project.http.userAgent) !== false);
    } catch (error) {
      this.robots.delete(url.origin);
      if (signal?.aborted) throw new HttpFailure('canceled');
      // Preserve safety/circuit errors; failure to obtain robots is never an SEO finding.
      if (error instanceof HttpFailure && ['circuit_open', 'dns_address_blocked', 'host_not_allowed', 'unsafe_url', 'https_downgrade'].includes(error.code)) throw error;
      throw new HttpFailure('robots_unavailable');
    } finally {
      if (trace && !trace.origins.has(url.origin)) {
        trace.origins.add(url.origin); trace.attempts.push(...entry.attempts);
      }
    }
  }
  private async follow(initial: URL, attempts: HttpAttempt[], chain: Chain, robotsRequest: boolean, signal?: AbortSignal, trace?: RobotsTrace, sink?: BodySinkFactory): Promise<Page> {
    let url = initial; const seen = new Set<string>();
    while (true) {
      signal?.throwIfAborted();
      if (seen.has(url.href)) throw new HttpFailure('redirect_loop');
      seen.add(url.href);
      if (!robotsRequest && !await this.robotsAllowed(url, trace, signal)) throw new HttpFailure('robots_disallowed');
      const timestamp = new Date().toISOString();
      const response = await this.request(url, attempts, robotsRequest ? Math.min(512000, this.project.http.maxResponseBytes) : this.project.http.maxResponseBytes, signal, robotsRequest ? undefined : sink);
      if (!redirect.has(response.status)) return { url, response, timestamp, chain };
      if (!response.location) throw new HttpFailure('redirect_location_missing');
      let target: URL;
      try { target = validateTarget(new URL(response.location, url).href, this.project.allowedHosts); }
      catch (error) { throw error instanceof HttpFailure ? error : new HttpFailure('redirect_location_invalid'); }
      if (this.originLock && target.origin !== this.originLock) throw new HttpFailure('backend_origin_changed');
      if (url.protocol === 'https:' && target.protocol !== 'https:') throw new HttpFailure('https_downgrade');
      if (chain.length >= this.project.http.maxRedirects) throw new HttpFailure('max_redirects');
      chain.push({ url: evidenceUrl(url), status: response.status, location: evidenceUrl(target) });
      url = target;
    }
  }
  async fetch(input: string, options: FetchOptions = {}): Promise<HttpFetchResult> { return this.execute(input, options); }
  async fetchToSink(input: string, sink: BodySinkFactory, options: FetchOptions = {}): Promise<HttpFetchMetadata> {
    return HttpFetchResultSchema.parse(await this.execute(input, options, sink));
  }
  private async execute(input: string, options: FetchOptions, sink?: BodySinkFactory): Promise<HttpFetchResult> {
    const robotsTrace: RobotsTrace = { attempts: [], origins: new Set() };
    const attempts: HttpAttempt[] = []; let chain: Chain = []; let initial: URL | undefined;
    try {
      initial = validateTarget(input, this.project.allowedHosts);
      let page = await this.follow(initial, attempts, chain, false, options.signal, robotsTrace, sink);
      if (options.confirmExpectedMissing && [404, 410].includes(page.response.status)) {
        chain = [];
        page = await this.follow(initial, attempts, chain, false, options.signal, robotsTrace, sink);
      }
      const response = page.response;
      const metadata = HttpFetchResultSchema.options[0].parse({ status: 'fetched', robotsAttempts: robotsTrace.attempts, attempts, redirectChain: chain,
        evidence: { requestedUrl: evidenceUrl(initial), responseUrl: evidenceUrl(page.url), timestamp: page.timestamp,
          method: 'GET', httpStatus: response.status, redirectChain: chain, contentType: response.contentType,
          responseBytes: response.bodyBytes ?? response.body.length, ttfbMs: response.ttfbMs, totalMs: response.totalMs,
          requestProfile: 'default', bodySha256: response.bodySha256 ?? hash(response.body) } });
      if (metadata.status !== 'fetched') throw new HttpFailure('invalid_result');
      // Parser input must not accidentally enter JSON logs/artifacts.
      return Object.defineProperty(metadata, 'body', { value: response.body, enumerable: false }) as HttpFetchResult;
    } catch (error) {
      const code = options.signal?.aborted ? 'canceled' : errorCode(error);
      if (code === 'robots_disallowed' && initial) return HttpFetchResultSchema.options[1].parse({ status: 'skipped_robots',
        requestedUrl: evidenceUrl(initial), reason: 'robots_disallowed', robotsAttempts: robotsTrace.attempts, attempts, redirectChain: chain });
      return HttpFetchResultSchema.options[2].parse({ status: 'fetch_error', ...(initial ? { requestedUrl: evidenceUrl(initial) } : {}),
        errorCode: code, robotsAttempts: robotsTrace.attempts, attempts, redirectChain: chain });
    }
  }
}
