import { z } from 'zod';
import ipaddr from 'ipaddr.js';
export const schemaVersion = z.literal('1.0');
export const safeId = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const timestamp = z.string().datetime({ offset: true });
export const nonnegative = z.number().int().nonnegative().safe();
export const hostName = z.string().max(253).refine(value => {
  if (value !== value.toLowerCase() || value.endsWith('.')) return false;
  const host = value.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host)) return ipaddr.parse(host).range() === 'unicast';
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
    && !/(^|\.)(localhost|local|internal|invalid|test)$/.test(host);
}, 'Expected a public hostname or public IP');
export const httpUrl = z.string().max(8192).superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || !hostName.safeParse(url.hostname).success) throw new Error();
    if ([...url.searchParams.keys()].some(key => /^(token|access_token|api[_-]?key|password|secret|authorization|signature)$/i.test(key))) throw new Error();
  } catch { ctx.addIssue({ code: 'custom', message: 'Expected an HTTP(S) URL without credentials or private destinations' }); }
});
export const severity = z.enum(['P0', 'P1', 'P2', 'INFO']);
export const confidence = z.enum(['high', 'medium', 'low']);
export const entityType = z.enum(['product', 'category', 'page']);
