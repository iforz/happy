import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ restartRequired: false, store: new Map<string, string>(), getCredentials: vi.fn(), fetch: vi.fn(), browser: vi.fn() }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
    getItemAsync: vi.fn(async (key: string) => fixture.store.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { fixture.store.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { fixture.store.delete(key); }),
}));
vi.mock('./runtimeRestart.native', () => ({ requiresRuntimeRestart: () => fixture.restartRequired, RUNTIME_RESTART_MESSAGE: '请完全关闭并重新打开 App 后继续。' }));
vi.mock('expo/fetch', () => ({ fetch: fixture.fetch }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: fixture.browser }));
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: async () => new Uint8Array(32).fill(7) }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: fixture.getCredentials } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://happy.example.test' }));
vi.mock('@/encryption/libsodium.lib', () => ({ default: { crypto_sign_seed_keypair: () => ({ publicKey: new Uint8Array(32).fill(1), privateKey: new Uint8Array(64).fill(2) }), crypto_sign_detached: () => new Uint8Array(64).fill(3) } }));
import { beginTokenHubLogin, completeTokenHubLogin, saveTokenHubLogin, cancelNativeLogin, NATIVE_CALLBACK } from './login.native';
import { nativeLoginStorage } from './nativeLoginStorage';
import * as SecureStore from 'expo-secure-store';
const secret = Buffer.alloc(32, 9).toString('base64url'), state = 's'.repeat(43), binding = 'b'.repeat(43);
const url = `${NATIVE_CALLBACK}?state=${state}&code=one-time-code`;
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }
function startData() { return { state, binding, proof: 'device-public-key-bound-proof', expiresAt: Date.now() + 240000, tokenHubOrigin: 'https://accounts.example.test',
    authorizeUrl: `https://accounts.example.test/happy/authorize?state=${state}&client_id=happy-native&native_binding_hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&code_challenge_method=S256` }; }
function success() { return { token: 'new-signed-session', expiresAt: Date.now() + 60000, refresh: 'reauthenticate' }; }
beforeEach(async () => {
    fixture.restartRequired = false; fixture.store.clear(); fixture.fetch.mockReset(); fixture.browser.mockReset(); fixture.getCredentials.mockReset();
    await cancelNativeLogin();
    fixture.getCredentials.mockResolvedValue({ secret, token: 'old-session' });
    fixture.browser.mockResolvedValue({ type: 'success', url });
    fixture.fetch.mockImplementation(async (input: string, init: RequestInit) => {
        if (input.endsWith('/start')) return response(startData());
        if (JSON.parse(String(init.body)).error) return response({ error: 'cancelled' }, 400);
        return response(success());
    });
    // Browser globals must not be touched by the native implementation.
    vi.stubGlobal('localStorage', undefined); vi.stubGlobal('sessionStorage', undefined); vi.stubGlobal('window', undefined);
});
afterEach(() => vi.unstubAllGlobals());

it('reuses the existing encryption identity, secure device storage and system browser', async () => {
    const result = await beginTokenHubLogin(); expect(result).toEqual({ token: 'new-signed-session', secret });
    expect(fixture.browser).toHaveBeenCalledWith(startData().authorizeUrl, NATIVE_CALLBACK, { preferEphemeralSession: true });
    expect(await nativeLoginStorage.identity()).toBe(secret); expect(await nativeLoginStorage.flow()).toBeNull();
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('happy.tokenhub.native.flow.v1', expect.stringContaining(binding), { keychainAccessible: 'device-only' });
    const request = fixture.fetch.mock.calls.find(call => String(call[0]).endsWith('/complete'))!;
    expect(JSON.parse(request[1].body)).toMatchObject({ state, binding, code: 'one-time-code', signature: expect.any(String) });
    expect(request[1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(JSON.stringify(fixture.fetch.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(fixture.browser.mock.calls)).not.toContain(binding);
});
it('resumes a cold-start callback from SecureStore and coalesces duplicate completions', async () => {
    await nativeLoginStorage.saveFlow({ server: 'https://happy.example.test', state, binding, secret, proof: 'bound-proof', expiresAt: Date.now() + 20000 });
    const [first, second] = await Promise.all([completeTokenHubLogin(url), completeTokenHubLogin(url)]);
    expect(first).toEqual(second); expect(fixture.fetch).toHaveBeenCalledTimes(1);
    const login = vi.fn(async () => {}); await Promise.all([saveTokenHubLogin(first, login), saveTokenHubLogin(second, login)]);
    expect(login).toHaveBeenCalledTimes(1);
});
it('keeps the saved identity after cancellation and never saves an active session', async () => {
    fixture.browser.mockResolvedValue({ type: 'cancel' });
    await expect(beginTokenHubLogin()).rejects.toThrow('取消');
    expect(await nativeLoginStorage.identity()).toBe(secret); expect(await nativeLoginStorage.flow()).toBeNull(); expect(await nativeLoginStorage.session()).toBeNull();
});
it('a stale callback cannot delete a newer login transaction', async () => {
    const flow = { server: 'https://happy.example.test', state, binding, secret, proof: 'bound-proof', expiresAt: Date.now() + 20000 };
    await nativeLoginStorage.saveFlow(flow);
    await expect(completeTokenHubLogin(url.replace(state, 'x'.repeat(43)))).rejects.toThrow('当前登录');
    expect(await nativeLoginStorage.flow()).toEqual(flow); expect(fixture.fetch).not.toHaveBeenCalled();
});
it.each(['evil://tokenhub/callback', 'happy://attacker/callback', 'happy://tokenhub/other'])('rejects callback destination %s before exchange', async destination => {
    await expect(completeTokenHubLogin(`${destination}?state=${state}&code=one-time-code`)).rejects.toThrow('回调无效'); expect(fixture.fetch).not.toHaveBeenCalled();
});
it('rejects expired flow and changed identity without replacing it', async () => {
    const flow = { server: 'https://happy.example.test', state, binding, secret, proof: 'bound-proof', expiresAt: Date.now() - 1 };
    await nativeLoginStorage.saveFlow(flow); await expect(completeTokenHubLogin(url)).rejects.toThrow('过期'); expect(fixture.fetch).not.toHaveBeenCalled();
    await nativeLoginStorage.saveFlow({ ...flow, expiresAt: Date.now() + 20000 });
    fixture.getCredentials.mockResolvedValue({ secret: 'different-secret', token: 'different-session' });
    await expect(completeTokenHubLogin(url)).rejects.toThrow('身份已变化');
    expect(JSON.parse(fixture.fetch.mock.calls[0][1].body)).toEqual({ state, binding, error: 'access_denied' });
});
it('reuses the preserved identity when an expired session has been cleared', async () => {
    fixture.getCredentials.mockResolvedValue(null); await nativeLoginStorage.saveIdentity(secret);
    expect((await beginTokenHubLogin()).secret).toBe(secret);
});
it('logout invalidates a browser result arriving after local cancellation', async () => {
    let release!: (value: unknown) => void;
    fixture.browser.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = beginTokenHubLogin();
    await vi.waitFor(() => expect(fixture.browser).toHaveBeenCalled());
    await cancelNativeLogin(); release({ type: 'success', url });
    await expect(pending).rejects.toThrow('取消'); expect(await nativeLoginStorage.session()).toBeNull();
});

it('refuses new authorization and duplicate callbacks before any network call when this runtime needs restart', async () => {
    fixture.restartRequired = true;
    await expect(beginTokenHubLogin()).rejects.toThrow('完全关闭并重新打开');
    await expect(completeTokenHubLogin(url)).rejects.toThrow('完全关闭并重新打开');
    expect(fixture.fetch).not.toHaveBeenCalled(); expect(fixture.browser).not.toHaveBeenCalled();
});
