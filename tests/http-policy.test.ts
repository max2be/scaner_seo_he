import { describe, expect, it, vi } from 'vitest';
import { publicAddress, resolveTarget, sameAddress, validateTarget } from '../packages/core/src/http/policy.js';
import { SafeHttpClient } from '@hsi/core';
import { ProjectConfigSchema } from '@hsi/contracts';
import { readFileSync } from 'node:fs';
const allowed = ['shop.example.com'];
describe('AC-21 public IP/URL gate', () => {
  it.each(['127.0.0.1', '0.0.0.0', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.51.100.1', '203.0.113.1',
    '::', '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1',
    '::ffff:192.168.1.1', '64:ff9b::7f00:1', 'fe80::1%eth0', 'not-an-ip'])('blocks %s', value => expect(publicAddress(value)).toBe(false));
  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111'])('accepts a global address %s', value => expect(publicAddress(value)).toBe(true));
  it.each(['file:///etc/passwd', 'http://localhost', 'http://127.0.0.1', 'http://2130706433', 'http://0x7f000001',
    'http://[::1]', 'https://evil.example.org', 'https://shop.example.com.evil.org',
    'https://user:password@shop.example.com', 'https://shop.example.com/?access_token=secret',
    'https://shop.example.com/\npath'])('rejects destination before DNS: %s', value => {
      expect(() => validateTarget(value, allowed)).toThrow();
  });
  it('rejects any mixed A/AAAA answer set, not only the first IP', async () => {
    await expect(resolveTarget(new URL('https://shop.example.com'), async () => [
      { address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 },
    ], new AbortController().signal)).rejects.toMatchObject({ code: 'dns_address_blocked' });
  });
  it('rejects empty/malformed/family-mismatched DNS records', async () => {
    for (const records of [[], [{ address: 'abc', family: 4 }], [{ address: '93.184.216.34', family: 6 }]])
      await expect(resolveTarget(new URL('https://shop.example.com'), async () => records, new AbortController().signal)).rejects.toThrow();
  });
  it('pins an immutable selected IP, without a second DNS resolution', async () => {
    const resolver = vi.fn().mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const pin = await resolveTarget(new URL('https://shop.example.com'), resolver, new AbortController().signal);
    expect(pin.address).toBe('93.184.216.34'); expect(resolver).toHaveBeenCalledTimes(1);
  });
  it('compares IPv4-mapped socket peers safely', () => {
    expect(sameAddress('::ffff:93.184.216.34', '93.184.216.34')).toBe(true);
    expect(sameAddress('127.0.0.1', '93.184.216.34')).toBe(false);
  });
  it('never connects after failed initial validation or private DNS answer', async () => {
    const p = ProjectConfigSchema.parse(JSON.parse(readFileSync(new URL('../docs/examples/project.example.json', import.meta.url), 'utf8')));
    p.http.respectRobots = false;
    const transport = vi.fn(); const resolver = vi.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const client = new SafeHttpClient(p, { resolver, transport });
    const invalid = await client.fetch('http://169.254.169.254/latest/meta-data'); expect(invalid.status).toBe('fetch_error');
    expect(resolver).not.toHaveBeenCalled();
    const privateResult = await client.fetch(p.baseUrl); expect(privateResult).toMatchObject({ status: 'fetch_error', errorCode: 'dns_address_blocked' });
    expect(transport).not.toHaveBeenCalled();
  });
});
