import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
    store: new Map<string, string>(), removeOk: false, remove: vi.fn(), blocked: false,
    listener: null as ((state: string) => void) | null,
    disconnect: vi.fn(), reload: vi.fn(), fetch: vi.fn(), ordinaryFetch: vi.fn(), notice: vi.fn(), os: 'ios',
}));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
    getItemAsync: async (key: string) => fixture.store.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { fixture.store.set(key, value); },
    deleteItemAsync: async (key: string) => {
        if (key === 'auth_credentials') { fixture.remove(); if (!fixture.removeOk) throw new Error('Synthetic transient SecureStore failure'); }
        fixture.store.delete(key);
    },
}));
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn() }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('expo/fetch', () => ({ fetch: fixture.fetch }));
vi.mock('@/encryption/libsodium.lib', () => ({ default: {} }));
vi.mock('@/sync/sync', () => ({ syncCreate: vi.fn() }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { disconnect: fixture.disconnect } }));
vi.mock('@/sync/persistence', () => ({ clearPersistence: vi.fn(), loadRegisteredPushToken: () => null }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://happy.example.test' }));
vi.mock('expo', () => ({ reloadAppAsync: fixture.reload }));
vi.mock('react-native', () => ({ Platform: { get OS() { return fixture.os; } }, AppState: {
    addEventListener: (_name: string, listener: (state: string) => void) => { fixture.listener = listener; return { remove: vi.fn() }; },
} }));
vi.mock('@/track', () => ({ trackLogout: vi.fn() }));
vi.mock('./runtimeRestart.native', () => ({ requiresRuntimeRestart: () => fixture.blocked,
    markRuntimeRestartRequired: () => { fixture.blocked = true; }, RUNTIME_RESTART_MESSAGE: 'Runtime blocked; 完全关闭并重新打开' }));
vi.mock('@/integrations/tokenhub/runtimeRestart', async () => await import('./runtimeRestart.native'));
vi.mock('@/integrations/tokenhub/logoutNotice', () => ({ saveSessionNotice: fixture.notice, clearSessionNotice: vi.fn() }));
vi.mock('@/integrations/tokenhub/sessionLifecycle', async () => await import('./sessionLifecycle.native'));
vi.mock('./transport', async () => await import('./transport.native'));
import { AuthProvider, useAuth, getCurrentAuth } from '@/auth/AuthContext';
import { TokenStorage } from '@/auth/tokenStorage';
import { nativeLoginStorage } from './nativeLoginStorage';
import { nativeFetch } from './nativeTransport';
import { nativeWorkFetch, nativeWorkSocketAllowed } from './nativeRequestContext';
import { beginTokenHubLogin, completeTokenHubLogin } from './login.native';
const server = 'https://happy.example.test';
const token = 'synthetic.' + Buffer.from(JSON.stringify({ iss: 'handy', extras: { tokenhub: { authority: 'https://accounts.example.test', issuer: 'tokenapi', subject: '42', publicKey: 'ab'.repeat(32), authorizationToken: 'work-grant' } } })).toString('base64url') + '.signature';
const credentials = { token, secret: 'retained-synthetic-identity' };
let auth: ReturnType<typeof useAuth>, renderer: ReturnType<typeof create>;
function Consumer() { auth = useAuth(); return React.createElement('status', { authenticated: auth.isAuthenticated }); }
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 10)); };
async function mount(expiresAt: number) {
    fixture.store.set('auth_credentials', JSON.stringify(credentials));
    await nativeLoginStorage.saveSession({ token, server, expiresAt });
    await act(async () => { renderer = create(React.createElement(AuthProvider, { initialCredentials: credentials, children: React.createElement(Consumer) })); await flush(); });
}
beforeEach(() => {
    fixture.store.clear(); fixture.removeOk = false; fixture.blocked = false; fixture.remove.mockClear(); fixture.disconnect.mockClear(); fixture.notice.mockClear();
    fixture.reload.mockReset(); fixture.reload.mockResolvedValue(undefined); fixture.fetch.mockReset(); fixture.ordinaryFetch.mockReset();
    fixture.fetch.mockImplementation(async (url: string) => new Response(url.endsWith('/logout') ? '{"revoked":true}' : '{}', { status: 200 }));
    fixture.ordinaryFetch.mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', nativeWorkFetch(fixture.ordinaryFetch as typeof fetch, () => server));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); vi.unstubAllGlobals(); });
it.each(['ios', 'android'])('on %s expiry stops UI/HTTP/WS immediately, retains retry metadata, then clears and reloads only after SecureStore recovers', async os => {
    fixture.os = os;
    await mount(Date.now() - 1);
    expect(fixture.remove).toHaveBeenCalledOnce(); expect(auth.isAuthenticated).toBe(false); expect(auth.credentials).toBeNull(); expect(getCurrentAuth()).toBeNull();
    expect(auth.cleanupRequired).toBe(true); expect(fixture.blocked).toBe(true); expect(fixture.disconnect).toHaveBeenCalledOnce();
    expect(await TokenStorage.getCredentials()).toEqual(credentials); expect(await nativeLoginStorage.session()).not.toBeNull();
    expect(fixture.reload).not.toHaveBeenCalled(); expect(fixture.notice).not.toHaveBeenCalled();
    await expect(fetch(server + '/v1/sessions')).rejects.toThrow('Runtime blocked');
    await expect(nativeFetch(server + '/v1/tokenhub/work-mock')).rejects.toThrow('Runtime blocked');
    expect(nativeWorkSocketAllowed(server, server)).toBe(false);
    await expect(beginTokenHubLogin()).rejects.toThrow('Runtime blocked');
    await expect(completeTokenHubLogin('happy://tokenhub/callback?state=' + 's'.repeat(43) + '&code=test')).rejects.toThrow('Runtime blocked');
    expect(fixture.fetch).not.toHaveBeenCalled(); expect(fixture.ordinaryFetch).not.toHaveBeenCalled();
    fixture.removeOk = true;
    await act(async () => { fixture.listener!('active'); await flush(); });
    expect(fixture.remove).toHaveBeenCalledTimes(2); expect(await TokenStorage.getCredentials()).toBeNull(); expect(await nativeLoginStorage.session()).toBeNull();
    expect(await nativeLoginStorage.identity()).toBe(credentials.secret); expect(auth.cleanupRequired).toBe(false); expect(auth.restartRequired).toBe(true);
    expect(fixture.reload).toHaveBeenCalledOnce();
    // A successful reload call can be a no-op in a harness: the old runtime still cannot send requests.
    await expect(fetch(server + '/v1/sessions')).rejects.toThrow('Runtime blocked');
    await fetch('https://third-party.example.test/public'); expect(fixture.ordinaryFetch).toHaveBeenCalledOnce();
});
it('revocation remains pending after deletion failure even when the next authority response would be 200', async () => {
    fixture.fetch.mockResolvedValue(new Response('{}', { status: 401 }));
    await mount(Date.now() + 60000); expect(fixture.remove).toHaveBeenCalledOnce(); expect(fixture.fetch).toHaveBeenCalledOnce();
    fixture.fetch.mockResolvedValue(new Response('{}', { status: 200 })); fixture.removeOk = true;
    await act(async () => { fixture.listener!('active'); await flush(); });
    expect(fixture.remove).toHaveBeenCalledTimes(2); expect(fixture.fetch).toHaveBeenCalledOnce(); expect(await TokenStorage.getCredentials()).toBeNull();
});
it('repeated logout retries only failed local deletion, retains the confirmed remote result and stays blocked if reload throws', async () => {
    await mount(Date.now() + 60000); fixture.fetch.mockClear(); fixture.reload.mockRejectedValue(new Error('Reload disabled'));
    await act(async () => { await expect(auth.logout()).rejects.toThrow('remove local credentials'); });
    expect(fixture.fetch.mock.calls.filter(call => String(call[0]).endsWith('/logout'))).toHaveLength(1);
    expect(await nativeLoginStorage.session()).not.toBeNull(); expect(auth.isAuthenticated).toBe(false); expect(fixture.reload).not.toHaveBeenCalled();
    fixture.removeOk = true;
    await act(async () => { await Promise.all([auth.logout(), auth.logout()]); });
    expect(fixture.remove).toHaveBeenCalledTimes(2); expect(fixture.fetch.mock.calls.filter(call => String(call[0]).endsWith('/logout'))).toHaveLength(1);
    expect(fixture.notice).toHaveBeenCalledWith('已退出，并已确认撤销当前 TokenHub 会话。');
    expect(auth.restartRequired).toBe(true); expect(await TokenStorage.getCredentials()).toBeNull();
    await expect(nativeFetch(server + '/v1/sessions')).rejects.toThrow('Runtime blocked'); expect(nativeWorkSocketAllowed(server, server)).toBe(false);
});
