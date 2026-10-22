import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ credentials: null as { token: string; secret: string } | null, removeOk: true,
    restartRequired: false, reload: vi.fn(), sync: vi.fn(), disconnect: vi.fn(), preserve: vi.fn(), clearNative: vi.fn(), notice: vi.fn(), fetch: vi.fn(),
    expire: null as (() => Promise<void>) | null }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: {
    getCredentials: async () => fixture.credentials,
    setCredentials: async (value: { token: string; secret: string }) => { fixture.credentials = value; return true; },
    removeCredentials: async () => { if (!fixture.removeOk) return false; fixture.credentials = null; return true; },
} }));
vi.mock('@/sync/sync', () => ({ syncCreate: fixture.sync }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { disconnect: fixture.disconnect } }));
vi.mock('@/sync/persistence', () => ({ clearPersistence: vi.fn(), loadRegisteredPushToken: () => 'synthetic-push-token' }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://happy.example.test' }));
vi.mock('expo', () => ({ reloadAppAsync: fixture.reload }));
vi.mock('@/integrations/tokenhub/runtimeRestart', () => ({ requiresRuntimeRestart: () => fixture.restartRequired, markRuntimeRestartRequired: () => { fixture.restartRequired = true; }, RUNTIME_RESTART_MESSAGE: '本机授权已清除，请完全关闭并重新打开 App 后继续。' }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@/track', () => ({ trackLogout: vi.fn() }));
vi.mock('@/integrations/tokenhub/sessionLifecycle', () => ({ preserveTokenHubIdentity: fixture.preserve, clearTokenHubLocalSession: fixture.clearNative, invalidateTokenHubLogin: vi.fn(),
    watchTokenHubSession: (_credentials: unknown, expire: () => Promise<void>) => { fixture.expire = expire; return () => {}; } }));
vi.mock('@/integrations/tokenhub/logoutNotice', () => ({ saveSessionNotice: fixture.notice, clearSessionNotice: vi.fn(async () => {}) }));
import { AuthProvider, useAuth } from '@/auth/AuthContext';
const unifiedToken = 'synthetic-header.' + Buffer.from(JSON.stringify({ iss: 'handy', extras: { tokenhub: { authority: 'https://accounts.example.test', issuer: 'tokenapi', subject: '42', publicKey: 'ab'.repeat(32), authorizationToken: 'work-grant' } } })).toString('base64url') + '.synthetic-signature';
let renderer: ReturnType<typeof create>, auth: ReturnType<typeof useAuth>;
function Consumer() { auth = useAuth(); return React.createElement('status', { authenticated: auth.isAuthenticated }); }
beforeEach(async () => {
    fixture.credentials = { token: unifiedToken, secret: 'old-identity' }; fixture.removeOk = true; fixture.restartRequired = false; fixture.reload.mockReset(); fixture.reload.mockResolvedValue(undefined);
    fixture.sync.mockReset(); fixture.sync.mockResolvedValue(undefined); fixture.disconnect.mockClear(); fixture.preserve.mockClear(); fixture.clearNative.mockClear(); fixture.notice.mockClear();
    fixture.fetch.mockReset(); fixture.fetch.mockResolvedValue(new Response('{"revoked":true}'));
    vi.stubGlobal('fetch', fixture.fetch); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    await act(async () => { renderer = create(React.createElement(AuthProvider, { initialCredentials: fixture.credentials, children: React.createElement(Consumer) })); });
});
afterEach(async () => { await act(async () => { renderer.unmount(); }); vi.unstubAllGlobals(); });
it('confirms remote revocation, clears local auth and disconnects without erasing the encryption identity', async () => {
    await act(async () => { await auth.logout(); });
    expect(auth.isAuthenticated).toBe(false); expect(fixture.credentials).toBeNull(); expect(fixture.disconnect).toHaveBeenCalledOnce();
    expect(fixture.preserve).toHaveBeenCalledWith({ token: unifiedToken, secret: 'old-identity' }); expect(fixture.clearNative).toHaveBeenCalled();
    expect(fixture.notice).toHaveBeenCalledWith('已退出，并已确认撤销当前 TokenHub 会话。');
    expect(fixture.fetch.mock.calls.filter(call => String(call[0]).endsWith('/logout'))).toHaveLength(1);
});
it('still signs out locally when the remote authority is unavailable, explicitly preserving uncertainty', async () => {
    fixture.fetch.mockImplementation(async () => new Response('{}', { status: 503 }));
    await act(async () => { await auth.logout(); }); expect(auth.isAuthenticated).toBe(false); expect(fixture.credentials).toBeNull();
    expect(fixture.notice).toHaveBeenCalledWith(expect.stringContaining('远端撤销未确认'));
});
it('does not falsely report local logout when secure credential removal fails', async () => {
    fixture.removeOk = false;
    await act(async () => { await expect(auth.logout()).rejects.toThrow('remove local credentials'); });
    expect(auth.isAuthenticated).toBe(false); expect(auth.credentials).toBeNull(); expect(auth.cleanupRequired).toBe(true);
    expect(fixture.credentials).not.toBeNull(); expect(fixture.notice).not.toHaveBeenCalled(); expect(fixture.clearNative).not.toHaveBeenCalled();
    expect(fixture.restartRequired).toBe(true); expect(fixture.reload).not.toHaveBeenCalled();
    await expect(auth.login('new-grant', 'old-identity')).rejects.toThrow('完全关闭');
    fixture.removeOk = true;
    await act(async () => { await Promise.all([auth.logout(), auth.logout()]); });
    expect(fixture.credentials).toBeNull(); expect(auth.cleanupRequired).toBe(false); expect(fixture.reload).toHaveBeenCalledOnce();
    expect(fixture.fetch.mock.calls.filter(call => String(call[0]).endsWith('/logout'))).toHaveLength(1);
});
it('an authoritative expiry clears the session and prompts reauthentication without a refresh request', async () => {
    await act(async () => { await fixture.expire!(); });
    expect(auth.isAuthenticated).toBe(false); expect(fixture.credentials).toBeNull(); expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.notice).toHaveBeenCalledWith(expect.stringContaining('请重新统一登录'));
});
it('a login finishing after logout cannot resurrect the cancelled session', async () => {
    let finish!: () => void;
    fixture.sync.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = auth.login('new-session', 'old-identity'); });
    const rejected = expect(pending).rejects.toThrow('取消');
    await act(async () => { await auth.logout(); finish(); await rejected; });
    expect(auth.isAuthenticated).toBe(false); expect(fixture.credentials).toBeNull();
});

it('keeps legacy Happy logout local and does not claim a Core family revocation', async () => {
    await act(async () => { await auth.login('legacy-happy-session', 'old-identity'); });
    await act(async () => { await auth.logout(); });
    expect(auth.isAuthenticated).toBe(false); expect(fixture.credentials).toBeNull();
    expect(fixture.fetch.mock.calls.filter(call => String(call[0]).endsWith('/logout'))).toHaveLength(0);
    expect(fixture.notice).not.toHaveBeenCalled();
});

it('requests native runtime reload after expiry and blocks any second login in the cleared runtime', async () => {
    await act(async () => { await fixture.expire!(); });
    expect(fixture.reload).toHaveBeenCalledOnce(); expect(auth.restartRequired).toBe(true);
    await expect(auth.login('new-grant', 'old-identity')).rejects.toThrow('完全关闭并重新打开');
    expect(fixture.sync).not.toHaveBeenCalled();
});
it('keeps a visible restart-required state and blocks login if native reload is disabled', async () => {
    fixture.reload.mockRejectedValue(new Error('Native reload unavailable'));
    await act(async () => { await auth.logout(); });
    expect(auth.isAuthenticated).toBe(false); expect(auth.restartRequired).toBe(true);
    await expect(auth.login('new-grant', 'old-identity')).rejects.toThrow('完全关闭并重新打开');
    expect(fixture.sync).not.toHaveBeenCalled();
});
