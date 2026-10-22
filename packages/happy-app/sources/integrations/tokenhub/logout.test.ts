import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://happy.example.test' }));
import { revokeTokenHubSession, unregisterPushForLogout } from './logout';
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => { fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('sends only the Happy bearer and strict empty body, requiring confirmed remote revocation', async () => {
    fetcher.mockResolvedValue(new Response('{"revoked":true}')); expect(await revokeTokenHubSession('signed-happy-token')).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('https://happy.example.test/v1/tokenhub/logout', expect.objectContaining({ method: 'POST', body: '{}', credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer signed-happy-token', 'Content-Type': 'application/json' } }));
});
it.each([401, 503])('does not claim remote revocation for %i', async status => {
    fetcher.mockResolvedValue(new Response('{}', { status })); expect(await revokeTokenHubSession('token')).toBe(false);
});
it('bounds even a nonconforming stalled transport so local logout can proceed', async () => {
    vi.useFakeTimers(); fetcher.mockImplementation(() => new Promise(() => {})); const pending = revokeTokenHubSession('token');
    await vi.advanceTimersByTimeAsync(2200); expect(await pending).toBe(false); expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
});
it('push-token cleanup is single-attempt and bounded, not indefinite retry after grant revocation', async () => {
    vi.useFakeTimers(); fetcher.mockImplementation(() => new Promise(() => {}));
    const pending = unregisterPushForLogout('token', 'push/device'); await vi.advanceTimersByTimeAsync(1200); await pending;
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][0]).toBe('https://happy.example.test/v1/push-tokens/push%2Fdevice');
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
});
