import { z } from 'zod';
import { hostName, httpUrl, safeId, schemaVersion } from './common.js';
const hosts = z.array(hostName).min(1).max(100).refine(v => new Set(v).size === v.length, 'Duplicate hosts');
const auth = z.discriminatedUnion('type', [z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('bearer'), tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }).strict()]);
const backend = z.discriminatedUnion('enabled', [z.object({ enabled: z.literal(false) }).strict(),
  z.object({ enabled: z.literal(true), type: z.literal('entity-feed-v1'), endpoint: httpUrl,
    allowedHosts: hosts, auth: auth.optional(), pageSize: z.number().int().min(1).max(10000) }).strict()]);
export const ProjectConfigSchema = z.object({
  schemaVersion, id: safeId, name: z.string().trim().min(1).max(200), baseUrl: httpUrl, allowedHosts: hosts,
  discovery: z.object({ sitemapUrls: z.array(httpUrl).max(1000), seedUrls: z.array(httpUrl).max(10000),
    crawlLinks: z.boolean(), maxDepth: z.number().int().min(0).max(100),
    queryPolicy: z.object({ mode: z.enum(['allowlist', 'drop']), allowedKeys: z.array(z.string().min(1)),
      dropTrackingKeys: z.array(z.string().min(1)) }).strict(), maxUrls: z.number().int().min(1).max(10000000) }).strict(),
  canonicalPolicy: z.object({ trailingSlash: z.enum(['with', 'without', 'preserve', 'unknown']),
    expectedScheme: z.enum(['http', 'https']), preferredHost: hostName, checkSelfCanonical: z.boolean() }).strict(),
  http: z.object({ userAgent: z.string().min(1).max(300).regex(/^[^\r\n]+$/), respectRobots: z.boolean(),
    requestsPerSecondPerHost: z.number().positive().max(100), concurrency: z.number().int().min(1).max(100),
    timeoutMs: z.number().int().min(100).max(300000), maxResponseBytes: z.number().int().min(1).max(50000000),
    maxRedirects: z.number().int().min(0).max(20), maxRetries: z.number().int().min(0).max(5) }).strict(),
  sources: z.object({ backend: backend.optional() }).strict(),
  reports: z.object({ keepLastRuns: z.number().int().min(1).max(10000), htmlEnabled: z.boolean() }).strict(),
  scanSchedule: z.object({ cron: z.string().min(1).max(100), timezone: z.string().refine(v => {
    try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; }
  }) }).strict().optional(),
}).strict().superRefine((config, ctx) => {
  const check = (url: string, allowed: string[], path: (string | number)[]) => {
    try { if (!allowed.includes(new URL(url).hostname)) ctx.addIssue({ code: 'custom', path, message: 'Destination not in allowedHosts' }); } catch { /* httpUrl reports invalid syntax */ }
  };
  check(config.baseUrl, config.allowedHosts, ['baseUrl']);
  config.discovery.seedUrls.forEach((url, i) => check(url, config.allowedHosts, ['discovery', 'seedUrls', i]));
  config.discovery.sitemapUrls.forEach((url, i) => check(url, config.allowedHosts, ['discovery', 'sitemapUrls', i]));
  if (!config.allowedHosts.includes(config.canonicalPolicy.preferredHost)) ctx.addIssue({ code: 'custom', path: ['canonicalPolicy', 'preferredHost'], message: 'Preferred host not allowed' });
  const feed = config.sources.backend;
  if (feed?.enabled) {
    check(feed.endpoint, feed.allowedHosts, ['sources', 'backend', 'endpoint']);
    if (!feed.endpoint.startsWith('https://')) ctx.addIssue({ code: 'custom', path: ['sources', 'backend', 'endpoint'], message: 'Backend requires HTTPS' });
  }
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
