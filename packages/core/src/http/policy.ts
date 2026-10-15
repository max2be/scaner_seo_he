import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { httpUrl } from '@hsi/contracts';
import { HttpFailure } from './errors.js';
export interface Address { address: string; family: number }
export type Resolver = (host: string) => Promise<Address[]>;
export const systemResolver: Resolver = host => lookup(host, { all: true, verbatim: true });
export interface PinnedTarget { url: URL; address: string; family: 4 | 6 }
export function publicAddress(value: string): boolean {
  if (value.includes('%') || !ipaddr.isValid(value)) return false;
  return ipaddr.parse(value).range() === 'unicast';
}
export function sameAddress(a: string, b: string): boolean {
  try { return ipaddr.process(a).toNormalizedString() === ipaddr.process(b).toNormalizedString(); }
  catch { return false; }
}
export function validateTarget(input: string, allowedHosts: readonly string[]): URL {
  if (!httpUrl.safeParse(input).success || Array.from(input).some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) throw new HttpFailure('unsafe_url');
  const url = new URL(input); url.hash = '';
  if (!allowedHosts.includes(url.hostname)) throw new HttpFailure('host_not_allowed');
  return url;
}
export async function resolveTarget(url: URL, resolver: Resolver, signal: AbortSignal): Promise<PinnedTarget> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(hostname);
  const records = literal ? [{ address: hostname, family: literal }] : await resolver(hostname);
  signal.throwIfAborted();
  if (records.length === 0 || records.some(record => !publicAddress(record.address)
    || ![4, 6].includes(record.family) || isIP(record.address) !== record.family)) throw new HttpFailure('dns_address_blocked');
  const first = records[0]!;
  return { url, address: first.address, family: first.family as 4 | 6 };
}
export function evidenceUrl(url: URL): string {
  const safe = new URL(url); safe.hash = '';
  for (const key of new Set(safe.searchParams.keys())) safe.searchParams.set(key, 'REDACTED');
  return safe.href;
}
