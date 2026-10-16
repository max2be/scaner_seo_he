import { httpUrl, type ProjectConfig } from '@hsi/contracts';
export type UrlDecision = { kind: 'include'; url: string } | { kind: 'exclude'; reason: string };
export function normalizeUrl(input: string, base: string, project: ProjectConfig): UrlDecision {
  if (!input.trim() || input.trim().startsWith('#')) return { kind: 'exclude', reason: 'fragment_or_empty' };
  let url: URL;
  try { url = new URL(input, base); } catch { return { kind: 'exclude', reason: 'invalid_url' }; }
  if (!httpUrl.safeParse(url.href).success) return { kind: 'exclude', reason: 'unsafe_url' };
  if (!project.allowedHosts.includes(url.hostname)) return { kind: 'exclude', reason: 'outside_hosts' };
  url.hash = '';
  const policy = project.discovery.queryPolicy;
  for (const key of new Set(url.searchParams.keys())) {
    if (policy.mode === 'drop' || policy.dropTrackingKeys.some(pattern => pattern === key || (pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1))))) url.searchParams.delete(key);
    else if (!policy.allowedKeys.includes(key)) return { kind: 'exclude', reason: 'query_policy' };
  }
  url.searchParams.sort();
  const slash = project.canonicalPolicy.trailingSlash;
  if (url.pathname !== '/' && slash === 'without') url.pathname = url.pathname.replace(/\/+$/, '');
  if (slash === 'with' && !url.pathname.endsWith('/')) url.pathname += '/';
  return { kind: 'include', url: url.href };
}
export function safeUrl(input: string): string | undefined {
  try { const url = new URL(input); if (!httpUrl.safeParse(url.href).success) return undefined;
    url.hash = ''; for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, 'REDACTED'); return url.href;
  } catch { return undefined; }
}
