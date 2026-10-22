import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ session: null as { token: string; server: string; expiresAt: number | null } | null,
    fetch: vi.fn(), saveIdentity: vi.fn(), cancel: vi.fn(), listener: null as ((state: string) => void) | null, remove: vi.fn() }));
vi.mock('react-native', () => ({ AppState: { addEventListener: (_name: string, listener: (state: string) => void) => { fixture.listener = listener; return { remove: fixture.remove }; } } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://happy.example.test' }));
vi.mock('expo/fetch', () => ({ fetch: fixture.fetch }));
vi.mock('./login.native', () => ({ cancelNativeLogin: fixture.cancel, invalidateNativeLogin: vi.fn() }));
vi.mock('./nativeLoginStorage', () => ({ nativeLoginStorage: { session: async () => fixture.session, saveIdentity: fixture.saveIdentity } }));
import { watchTokenHubSession, preserveTokenHubIdentity, clearTokenHubLocalSession } from './sessionLifecycle.native';
const credentials = { token: 'signed-happy-session', secret: 'encryption-identity' };
let dispose = () => {};
beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
    fixture.session = { token: credentials.token, server: 'https://happy.example.test', expiresAt: Date.now() + 60000 };
    fixture.fetch.mockReset(); fixture.saveIdentity.mockReset(); fixture.cancel.mockReset(); fixture.remove.mockReset();
    fixture.fetch.mockResolvedValue(new Response('{"active":true}', { status: 200 }));
});
afterEach(() => { dispose(); vi.useRealTimers(); });
it('retains encryption identity separately while clearing login/session state', async () => {
    await preserveTokenHubIdentity(credentials); await clearTokenHubLocalSession();
    expect(fixture.saveIdentity).toHaveBeenCalledWith('encryption-identity'); expect(fixture.cancel).toHaveBeenCalledOnce();
});
it('expires on the server-issued deadline rather than fabricating a refresh', async () => {
    const expired = vi.fn(async () => {}); dispose = watchTokenHubSession(credentials, expired);
    await vi.advanceTimersByTimeAsync(0); expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000); expect(expired).toHaveBeenCalledOnce();
    expect(fixture.fetch.mock.calls.every(call => String(call[0]).endsWith('/native/session'))).toBe(true);
});
it('clears an already expired session without sending it to the server', async () => {
    fixture.session!.expiresAt = Date.now() - 1; const expired = vi.fn(async () => {}); dispose = watchTokenHubSession(credentials, expired);
    await vi.advanceTimersByTimeAsync(0); expect(expired).toHaveBeenCalledOnce(); expect(fixture.fetch).not.toHaveBeenCalled();
});
it('checks revocation when the app returns to the foreground', async () => {
    const expired = vi.fn(async () => {}); dispose = watchTokenHubSession(credentials, expired); await vi.advanceTimersByTimeAsync(0);
    fixture.fetch.mockResolvedValue(new Response('{}', { status: 401 })); fixture.listener!('active'); await vi.advanceTimersByTimeAsync(0);
    expect(expired).toHaveBeenCalledOnce();
});
it('network failure does not silently extend the last verified expiry', async () => {
    fixture.fetch.mockRejectedValue(new Error('offline')); const expired = vi.fn(async () => {}); dispose = watchTokenHubSession(credentials, expired);
    await vi.advanceTimersByTimeAsync(0); expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000); expect(expired).toHaveBeenCalledOnce();
});
it('ignores metadata belonging to a different active credential and cleans up on unmount', async () => {
    fixture.session!.token = 'older-session'; const expired = vi.fn(async () => {}); dispose = watchTokenHubSession(credentials, expired);
    await vi.advanceTimersByTimeAsync(0); expect(fixture.fetch).not.toHaveBeenCalled(); dispose();
    await vi.advanceTimersByTimeAsync(60000); expect(expired).not.toHaveBeenCalled(); expect(fixture.remove).toHaveBeenCalled();
});

it('keeps invalidation pending after cleanup fails, even if the next server response would be 200', async () => {
    fixture.fetch.mockResolvedValue(new Response('{}', { status: 401 }));
    const expired = vi.fn().mockRejectedValueOnce(new Error('SecureStore locked')).mockResolvedValue(undefined);
    dispose = watchTokenHubSession(credentials, expired); await vi.advanceTimersByTimeAsync(0);
    expect(expired).toHaveBeenCalledOnce();
    fixture.fetch.mockResolvedValue(new Response('{}', { status: 200 }));
    fixture.listener!('active'); await vi.advanceTimersByTimeAsync(0);
    expect(expired).toHaveBeenCalledTimes(2); expect(fixture.fetch).toHaveBeenCalledOnce();
});
