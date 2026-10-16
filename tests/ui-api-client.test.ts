import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiClient, ApiError, query } from '../apps/ui/src/api.js';
const session = {
  schemaVersion: '1.0',
  role: 'admin',
  csrfToken: 'a'.repeat(64),
  expiresAt: '2099-01-01T00:00:00Z',
};
afterEach(() => vi.unstubAllGlobals());
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
describe('Browser API client safety', () => {
  it('keeps CSRF in memory, sends credentials only same-origin and validates session', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    const client = new ApiClient();
    await client.restore();
    await client.request('/api/projects', z.object({ ok: z.boolean() }), {
      method: 'POST',
      body: {},
      revision: 'revision',
    });
    expect(fetcher.mock.calls[1]![1]).toMatchObject({
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'X-CSRF-Token': session.csrfToken, 'If-Match': 'revision' },
    });
    client.clear();
    expect(client.currentSession).toBeUndefined();
    await expect(client.request('https://external.example/api', z.unknown())).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('clears authentication on 401 and CSRF rejection without echoing arbitrary server data', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response({ error: 'authentication_required' }, 401))
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response({ error: 'csrf_rejected' }, 403));
    vi.stubGlobal('fetch', fetcher);
    const client = new ApiClient(),
      expired = vi.fn();
    client.onSession = expired;
    await client.restore();
    await expect(client.request('/api/projects', z.unknown())).rejects.toMatchObject({ status: 401 });
    expect(client.currentSession).toBeUndefined();
    await client.restore();
    await expect(
      client.request('/api/projects', z.unknown(), { method: 'POST', body: {} }),
    ).rejects.toMatchObject({ status: 403 });
    expect(client.currentSession).toBeUndefined();
    expect(expired).toHaveBeenLastCalledWith();
  });
  it('handles null/empty pages, malformed payloads and stale-session responses', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const client = new ApiClient();
    const pending = client.restore();
    client.clear();
    finish(response(session));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.currentSession).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ bad: true })));
    await expect(client.restore()).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('treats schema errors, throttle and transport failures as safe actionable messages', async () => {
    const client = new ApiClient();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response({ error: 'login_throttled', retryAfter: 42 }, 429)),
    );
    await expect(client.login('synthetic-input')).rejects.toMatchObject({ retryAfter: 42 });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(response({ error: '<script>secret</script>', trace: 'private filesystem' }, 500)),
    );
    await expect(client.request('/api/me', z.unknown())).rejects.toMatchObject({ code: 'invalid_response' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private network details')));
    await expect(client.request('/api/me', z.unknown())).rejects.toMatchObject({ code: 'network_error' });
  });
  it('encodes opaque cursors and drops unset filters without treating zero as empty', () => {
    expect(query({ cursor: '+a/b=', total: 0, source: '', key: undefined })).toBe(
      '?cursor=%2Ba%2Fb%3D&total=0',
    );
  });
});
