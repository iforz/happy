import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformSession } from './platformSession';

const f = vi.hoisted(() => ({ server: 'https://work.example.test', local: new Map<string, string>(), history: new Map<string, string>(),
    random: 0, id: 0, draft: '', keyFail: false, historyReadFail: false, historyWrite: vi.fn(), getRandomBytes: vi.fn(), fetch: vi.fn(),
    tab: new Map<string, string>(), cloud: new Map<string, Map<string, any>>(), logoutFails: false, reload: vi.fn(), configRefresh: vi.fn(),
    mount: vi.fn(), unmount: vi.fn(), session: null as PlatformSession | null,
}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray', groupped: { background: 'white' } } } }) }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { if (f.historyReadFail) throw new Error('Synthetic history read failure'); return f.history.get(key); }
    set(key: string, value: string) { f.historyWrite(key, value); f.history.set(key, value); }
} }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => f.getRandomBytes(length), randomUUID: () => `00000000-0000-4000-8000-${String(++f.id).padStart(12, '0')}` }));
vi.mock('expo-router', async () => { const R = await import('react'); return { useRouter: () => ({ push: vi.fn() }), useLocalSearchParams: () => ({}), useFocusEffect: (callback: () => void) => R.useEffect(callback, [callback]) }; });
// The legacy context is intentionally empty. Importing or calling identity helpers fails the suite.
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: null, isAuthenticated: false }) }));
vi.mock('@/auth/tokenStorage', () => { throw new Error('Platform history must not load legacy credentials'); });
vi.mock('@/encryption/libsodium.lib', () => { throw new Error('Platform history must not derive a Happy signing identity'); });
vi.mock('./login', () => { throw new Error('Platform history must not invoke legacy login'); });
vi.mock('./transport', () => ({ tokenHubFetch: (url: string, init: RequestInit) => f.fetch(url, init) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => f.server }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en' }));
vi.mock('@/components/RoundButton', () => ({ RoundButton: 'RoundButton' }));
vi.mock('./usePageConfig', () => ({ usePageConfig: () => ({ config: { ssoReady: true, showLogin: true }, offline: false, refresh: f.configRefresh, reload: f.configRefresh }) }));
// Test encryption envelope binds ciphertext to its data key; no cryptographic primitive is being tested here.
vi.mock('@/encryption/libsodium', () => ({
    encryptSecretBox: (value: unknown, key: Uint8Array) => new TextEncoder().encode(JSON.stringify({ key: Buffer.from(key).toString('hex'), value })),
    decryptSecretBox: (value: Uint8Array, key: Uint8Array) => { const data = JSON.parse(new TextDecoder().decode(value)); if (data.key !== Buffer.from(key).toString('hex')) throw new Error('Synthetic wrong data key'); return data.value; },
}));
vi.mock('@/components/AgentInput', async () => {
    const R = await import('react');
    return { AgentInput: R.forwardRef((props: any, ref: any) => {
        R.useEffect(() => { f.mount(); return () => f.unmount(); }, []);
        R.useImperativeHandle(ref, () => ({ getText: () => f.draft, setTextAndSelection: (text: string) => { f.draft = text; } }));
        return R.createElement('AgentInput', props);
    }) };
});
import { platformHistoryKey, readPlatformHistoryKey } from './platformHistory';
import { platformAccountScope } from './platformSession';
import { PlatformHomeConversation } from './TokenHubConversation';
import { PlatformSessionProvider, usePlatformSession } from './PlatformSessionProvider';
import { PlatformWelcome } from './PlatformWelcome';

const origin = 'https://work.example.test', now = 1_800_000_000_000;
const account = (change: Partial<PlatformSession> = {}): PlatformSession => ({ authority: 'https://accounts.example.test', issuer: 'synthetic-core', subject: '42', sessionId: 'synthetic-session', expiresAt: now + 3_600_000, csrf: 'c'.repeat(43), ...change });
const keyName = (scope: string) => 'tokenhub-platform-history-key:v1:' + scope;
function storage() { return { getItem: vi.fn((key: string) => f.local.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { if (f.keyFail) throw new Error('Synthetic data key storage unavailable'); f.local.set(key, value); }), removeItem: vi.fn((key: string) => { f.local.delete(key); }) }; }
let local: ReturnType<typeof storage>, renderer: ReturnType<typeof create> | undefined;
let browser: EventTarget & { location: { origin: string; href: string; pathname: string; search: string; reload: ReturnType<typeof vi.fn> }; history: { replaceState: ReturnType<typeof vi.fn> } }, page: EventTarget & { visibilityState: string };
let context: ReturnType<typeof usePlatformSession>;
function CookieWorkspace({ welcome = false }: { welcome?: boolean }) { context = usePlatformSession(); return context.status === 'ready' && context.session ? React.createElement(PlatformHomeConversation, { session: context.session }) : welcome ? React.createElement(PlatformWelcome) : React.createElement('SignedOut', { status: context.status }); }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
async function render(session = account(), provider = false, welcome = false) { if (!provider) f.session = session; await act(async () => { renderer = create(provider ? React.createElement(PlatformSessionProvider, { children: React.createElement(CookieWorkspace, { welcome }) }) : React.createElement(PlatformHomeConversation, { session })); }); }
const composer = () => renderer!.root.findByType('AgentInput');
async function send(text: string) { f.draft = text; await act(async () => { composer().props.onChangeText(text); }); await act(async () => { composer().props.onSend(); await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function close() { if (renderer) await act(async () => { renderer.unmount(); }); renderer = undefined; }
function seedHistory(value = account()) {
    const scope = platformAccountScope(value), key = platformHistoryKey(scope)!;
    const data = [{ id: 'synthetic-old-conversation', model: 'synthetic-model', turns: [{ user: 'private old conversation', assistant: 'old answer', status: 'complete' }] }];
    const ciphertext = Buffer.from(JSON.stringify({ key: Buffer.from(key, 'base64url').toString('hex'), value: data })).toString('base64');
    f.history.set(scope, ciphertext); return { scope, key, ciphertext };
}
beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubEnv('EXPO_PUBLIC_TOKENHUB_PLATFORM_AUTH', '1');
    f.server = origin; f.local.clear(); f.tab.clear(); f.history.clear(); f.cloud.clear(); f.logoutFails = false; f.reload.mockReset(); f.configRefresh.mockReset(); f.random = 0; f.id = 0; f.draft = ''; f.keyFail = false; f.historyReadFail = false;
    f.historyWrite.mockReset(); f.mount.mockClear(); f.unmount.mockClear(); f.getRandomBytes.mockReset(); f.getRandomBytes.mockImplementation((length: number) => new Uint8Array(length).fill(++f.random));
    f.session = account(); local = storage(); browser = Object.assign(new EventTarget(), { location: { origin, href: origin + '/work/', pathname: '/work/', search: '', reload: f.reload }, history: { replaceState: vi.fn((_state: unknown, _title: string, value: string) => { const url = new URL(value, browser.location.href); Object.assign(browser.location, { href: url.href, pathname: url.pathname, search: url.search }); }) } }); page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', browser); vi.stubGlobal('document', page); vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => f.tab.get(key) ?? null, setItem: (key: string, value: string) => { f.tab.set(key, value); }, removeItem: (key: string) => { f.tab.delete(key); } });
    f.fetch.mockReset(); f.fetch.mockImplementation(async (url: string, init: RequestInit) => {
        if (url.endsWith('/session')) return f.session ? json(f.session) : new Response('', { status: 401 });
        if (url.endsWith('/complete')) return json(f.session);
        if (url.endsWith('/logout')) { if (f.logoutFails) return new Response('', { status: 503 }); f.session = null; return json({ ok: true }); }
        if (!f.session || new Headers(init.headers).get('x-tokenhub-csrf') !== f.session.csrf) return new Response('', { status: 403 });
        const scope = platformAccountScope(f.session, new URL(url).origin);
        const records = f.cloud.get(scope) ?? new Map<string, any>(); f.cloud.set(scope, records);
        if (url.endsWith('/conversations')) return json({ conversations: [...records.values()].map(item => ({ id: item.id, model: item.model, title: item.turns[0]?.user || '', updatedAt: item.updatedAt, lastStatus: item.turns.at(-1)?.status })) });
        if (url.includes('/conversations/')) { const record = records.get(url.split('/').at(-1)!); return record ? json(record) : new Response('', { status: 404 }); }
        if (url.endsWith('/models')) return json({ mode: 'real', billable: true, models: [{ id: 'synthetic-model', name: 'Synthetic Model' }] });
        const input = JSON.parse(init.body as string);
        records.set(input.conversationId, { id: input.conversationId, model: input.model, updatedAt: now, turns: [...(records.get(input.conversationId)?.turns || []), { id: input.requestId, user: input.messages.at(-1).content, assistant: 'synthetic answer', status: 'complete' }] });
        return new Response([{ type: 'delta', text: 'synthetic answer' }, { type: 'usage', model: input.model, requestId: input.requestId, inputTokens: 1, outputTokens: 2, mock: false, billable: true, accounting: 'core' }, { type: 'done' }].map(value => JSON.stringify(value)).join('\n'), { headers: { 'content-type': 'application/x-ndjson' } });
    });
    vi.stubGlobal('fetch', f.fetch);
});
afterEach(async () => { await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('local-only platform history key', () => {
    it('reads existing legacy keys without creating or replacing a missing key', () => {
        const scope = platformAccountScope(account()); expect(readPlatformHistoryKey(scope)).toBeNull();
        expect(local.setItem).not.toHaveBeenCalled(); expect(f.getRandomBytes).not.toHaveBeenCalled();
        const key = platformHistoryKey(scope); local.setItem.mockClear();
        expect(readPlatformHistoryKey(scope)).toBe(key); expect(local.setItem).not.toHaveBeenCalled();
    });
    it('namespaces data independently by server, authority, issuer and subject', () => {
        const scopes = [platformAccountScope(account()), platformAccountScope(account(), 'https://other-work.example.test'),
            platformAccountScope(account({ authority: 'https://other-accounts.example.test' })), platformAccountScope(account({ issuer: 'other-core' })), platformAccountScope(account({ subject: '99' }))];
        expect(new Set(scopes).size).toBe(5); expect(JSON.parse(scopes[0])).toEqual(['tokenhub-platform-v1', origin, account().authority, account().issuer, account().subject]);
        const keys = scopes.map(scope => platformHistoryKey(scope)); expect(new Set(keys).size).toBe(5);
        expect([...f.local.keys()]).toEqual(scopes.map(keyName));
    });
    it('does not bind history to the short-lived session, expiry or CSRF token', () => {
        const first = platformAccountScope(account()), second = platformAccountScope(account({ sessionId: 'rotated', csrf: 'd'.repeat(43), expiresAt: now + 9_000_000 }));
        expect(first).toBe(second); const key = platformHistoryKey(first); expect(platformHistoryKey(second)).toBe(key); expect(f.getRandomBytes).toHaveBeenCalledOnce();
    });
    it('creates and reuses a 32-byte local data key, not a login credential', () => {
        const scope = platformAccountScope(account()), key = platformHistoryKey(scope)!;
        expect(Buffer.from(key, 'base64url')).toHaveLength(32); expect(platformHistoryKey(scope)).toBe(key);
        expect(f.getRandomBytes).toHaveBeenCalledWith(32); expect(local.setItem).toHaveBeenCalledOnce(); expect(f.fetch).not.toHaveBeenCalled();
        expect([...f.local.keys()]).toEqual([keyName(scope)]); expect(key).not.toBe(account().csrf);
    });
    it.each(['not-base64!', '', Buffer.alloc(31).toString('base64url'), Buffer.alloc(33).toString('base64url')])('does not replace an existing malformed data key %#', invalid => {
        const scope = platformAccountScope(account()); f.local.set(keyName(scope), invalid);
        expect(platformHistoryKey(scope)).toBeNull(); expect(f.local.get(keyName(scope))).toBe(invalid); expect(local.setItem).not.toHaveBeenCalled(); expect(f.getRandomBytes).not.toHaveBeenCalled();
    });
    it('returns unavailable on storage read, write, or nonpersistent-store failure', () => {
        expect(platformHistoryKey('read-failure', { getItem: () => { throw new Error('unavailable'); }, setItem: vi.fn() })).toBeNull();
        expect(platformHistoryKey('write-failure', { getItem: () => null, setItem: () => { throw new Error('quota'); } })).toBeNull();
        expect(platformHistoryKey('silent-failure', { getItem: () => null, setItem: vi.fn() })).toBeNull();
    });
    it('returns unavailable when acquiring localStorage itself throws SecurityError', () => {
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Synthetic storage blocked', 'SecurityError'); } });
        expect(() => platformHistoryKey('blocked-storage')).not.toThrow();
        expect(platformHistoryKey('blocked-storage')).toBeNull();
    });
    it('returns unavailable when local randomness fails rather than using a legacy identity', () => {
        f.getRandomBytes.mockImplementation(() => { throw new Error('randomness unavailable'); }); expect(platformHistoryKey('scope')).toBeNull(); expect(f.fetch).not.toHaveBeenCalled();
    });
});

describe('platform conversation history integration', () => {
    it('works for a fresh seedless account and sends neither data key nor bearer to the gateway', async () => {
        await render(); await send('synthetic first message');
        expect(f.local.has(keyName(platformAccountScope(account())))).toBe(false);
        expect(f.fetch.mock.calls.filter(([url]) => url.endsWith('/stream'))).toHaveLength(1);
        expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/conversations'))).toBe(true);
        for (const [, init] of f.fetch.mock.calls) { expect(init.credentials).toBe('include'); expect(new Headers(init.headers).has('Authorization')).toBe(false); expect(new Headers(init.headers).get('x-tokenhub-csrf')).toBe(account().csrf); }
        expect(JSON.stringify(f.fetch.mock.calls)).not.toMatch(/"secret"|"publicKey"|"signature"/);
        expect(f.historyWrite).not.toHaveBeenCalled(); expect(f.cloud.get(platformAccountScope(account()))?.size).toBe(1);
    });
    it('restores only the same account and server after reload', async () => {
        await render(); await send('account A saved message'); await close(); await render();
        expect(JSON.stringify(renderer!.toJSON())).toContain('account A saved message'); await close();
        await render(account({ subject: '99' })); expect(JSON.stringify(renderer!.toJSON())).not.toContain('account A saved message'); await close();
        f.server = 'https://other-work.example.test'; browser.location.origin = f.server;
        await render(); expect(JSON.stringify(renderer!.toJSON())).not.toContain('account A saved message');
    });
    it.each(['corrupt-key', 'missing-key', 'corrupt-ciphertext', 'history-read-failure', 'key-write-failure'])('never overwrites old ciphertext after %s', async failure => {
        const saved = seedHistory();
        if (failure === 'corrupt-key') f.local.set(keyName(saved.scope), 'broken-key');
        if (failure === 'missing-key') f.local.delete(keyName(saved.scope));
        if (failure === 'corrupt-ciphertext') f.history.set(saved.scope, 'unreadable-ciphertext');
        if (failure === 'history-read-failure') f.historyReadFail = true;
        if (failure === 'key-write-failure') { f.local.delete(keyName(saved.scope)); f.keyFail = true; }
        const original = f.history.get(saved.scope); await render(); await send('new ephemeral message'); await close();
        expect(f.history.get(saved.scope)).toBe(original); expect(f.historyWrite).not.toHaveBeenCalled();
        expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/platform/stream'))).toBe(true);
    });
    it.each([
        { unexpected: 'format' },
        [{ id: 'malformed-conversation', model: 'synthetic-model', turns: 'not-an-array' }],
        [{ id: 'malformed-conversation', model: 'synthetic-model', turns: [{ user: 123, assistant: 'answer', status: 'complete' }] }],
    ])('preserves ciphertext with an unsupported decrypted history shape %#', async value => {
        const saved = seedHistory();
        const ciphertext = Buffer.from(JSON.stringify({ key: Buffer.from(saved.key, 'base64url').toString('hex'), value })).toString('base64');
        f.history.set(saved.scope, ciphertext); await render(); await close();
        expect(f.history.get(saved.scope)).toBe(ciphertext); expect(f.historyWrite).not.toHaveBeenCalled();
    });
    it('unmounts the actual conversation immediately on explicit logout without deleting its local data', async () => {
        const { scope, key, ciphertext } = seedHistory();
        await render(account(), true); await send('new account history');
        await act(async () => { await context.logout(); });
        expect(renderer!.root.findAllByType('AgentInput')).toHaveLength(0); expect(context.session).toBeNull();
        expect(f.local.get(keyName(scope))).toBe(key); expect(f.history.get(scope)).toBe(ciphertext); expect(f.historyWrite).not.toHaveBeenCalled();
        expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/platform/logout'))).toBe(true);
    });
    it('browser data-key write failure does not block cloud history or trigger legacy login', async () => {
        f.keyFail = true; await render(account(), true);
        expect(context.status).toBe('ready'); expect(context.session).toEqual(account()); expect(composer().props.blockSend).toBe(false);
        await send('ephemeral authorized message'); expect(context.session).toEqual(account()); expect(f.historyWrite).not.toHaveBeenCalled();
        expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/platform/stream'))).toBe(true);
        expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/start') || url.endsWith('/complete'))).toBe(false);
        expect(renderer!.root.findAllByType('SignedOut')).toHaveLength(0);
    });
    it('still renders authenticated chat when the browser localStorage getter is blocked', async () => {
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Synthetic storage blocked', 'SecurityError'); } });
        await render(account(), true); expect(context.status).toBe('ready'); expect(context.session).toEqual(account());
        expect(composer().props.blockSend).toBe(false); await send('authorized ephemeral message');
        expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/platform/stream'))).toBe(true); expect(f.historyWrite).not.toHaveBeenCalled();
    });
    it('keeps the actual conversation mounted on same-session foreground verification', async () => {
        await render(account(), true); await send('keep my conversation'); const mounts = f.mount.mock.calls.length;
        await act(async () => { browser.dispatchEvent(new Event('focus')); });
        expect(f.mount.mock.calls.length).toBe(mounts); expect(f.unmount).not.toHaveBeenCalled(); expect(JSON.stringify(renderer!.toJSON())).toContain('keep my conversation');
        expect(f.fetch.mock.calls.filter(([url]) => url.endsWith('/models'))).toHaveLength(2);
    });
    it('replaces the actual conversation on account switch without showing the previous history', async () => {
        await render(account(), true); await send('account A only'); f.session = account({ subject: '99', sessionId: 'account-b', csrf: 'd'.repeat(43) });
        await act(async () => { browser.dispatchEvent(new Event('focus')); });
        expect(context.session?.subject).toBe('99'); expect(JSON.stringify(renderer!.toJSON())).not.toContain('account A only'); expect(f.unmount).toHaveBeenCalledOnce();
        expect(f.historyWrite).not.toHaveBeenCalled(); expect(f.cloud.get(platformAccountScope(account()))?.size).toBe(1);
    });
    it('drops the actual conversation immediately on confirmed cookie expiry', async () => {
        await render(account(), true); await send('no stale signed-out content'); f.session = null;
        await act(async () => { browser.dispatchEvent(new Event('focus')); });
        expect(renderer!.root.findAllByType('AgentInput')).toHaveLength(0); expect(JSON.stringify(renderer!.toJSON())).not.toContain('no stale signed-out content');
        expect(f.unmount).toHaveBeenCalledOnce();
    });
});


describe('sign-out intent across real frontend remounts', () => {
    async function failedLogout() {
        await render(account(), true); f.logoutFails = true;
        await act(async () => { await expect(context.logout()).rejects.toThrow(); });
        expect(context.session).toBeNull(); expect(renderer!.root.findAllByType('AgentInput')).toHaveLength(0);
    }
    it('persists only public session identity metadata before a failed logout, never CSRF or credentials', async () => {
        const transport = f.fetch.getMockImplementation()!; let metadataWasSavedBeforeRequest = false;
        f.fetch.mockImplementation(async (url: string, init: RequestInit) => {
            if (url.endsWith('/logout')) metadataWasSavedBeforeRequest = [...f.local.entries(), ...f.tab.entries()].some(([key, value]) => !key.startsWith('tokenhub-platform-history-key:') && value.includes(account().sessionId));
            return transport(url, init);
        });
        await failedLogout(); expect(metadataWasSavedBeforeRequest).toBe(true);
        const records = [...f.local.entries(), ...f.tab.entries()].filter(([key]) => !key.startsWith('tokenhub-platform-history-key:'));
        expect(records.length).toBeGreaterThan(0);
        const serialized = JSON.stringify(records); expect(serialized).toContain(account().sessionId);
        expect(serialized).toContain(account().subject); expect(serialized).not.toContain(account().csrf);
        for (const [, value] of records) {
            const fields = Object.keys(JSON.parse(value));
            for (const forbidden of ['csrf', 'grant', 'token', 'secret', 'privateKey', 'publicKey', 'key']) expect(fields).not.toContain(forbidden);
        }
    });
    it('does not resurrect the cookie session on reload after failed explicit logout', async () => {
        await failedLogout(); await close(); f.mount.mockClear(); f.unmount.mockClear(); f.fetch.mockClear();
        await render(account(), true);
        expect(context.session).toBeNull(); expect(f.mount).not.toHaveBeenCalled(); expect(renderer!.root.findAllByType('AgentInput')).toHaveLength(0);
        expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/platform/logout'))).toBe(true);
        expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/platform/models'))).toBe(false);
    });
    it('does not logout another account whose cookie replaced the failed sign-out session', async () => {
        await failedLogout(); await close();
        f.session = account({ subject: '99', sessionId: 'account-b', csrf: 'd'.repeat(43) }); f.logoutFails = false; f.fetch.mockClear();
        await render(account(), true); await act(async () => { browser.dispatchEvent(new Event('focus')); });
        expect(context.session).toBeNull(); expect(renderer!.root.findAllByType('AgentInput')).toHaveLength(0);
        expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/platform/logout'))).toBe(false); expect(f.session.subject).toBe('99');
        expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/platform/models'))).toBe(false);
    });
    it('does not logout a rotated public BFF session instance even when the Core account is unchanged', async () => {
        await failedLogout(); await close();
        // Authority, issuer, subject and expiry remain identical; only the BFF instance rotates.
        f.session = account({ sessionId: 'same-account-new-session', csrf: 'd'.repeat(43) }); f.logoutFails = false; f.fetch.mockClear();
        await render(account(), true);
        expect(context.session).toBeNull(); expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/platform/logout'))).toBe(false);
        expect(f.session.sessionId).toBe('same-account-new-session');
    });
    it('retries only the original session after reload and clears the marker on confirmed logout', async () => {
        await failedLogout(); await close(); f.logoutFails = false; f.fetch.mockClear();
        await render(account(), true); expect(context.session).toBeNull(); expect(f.session).toBeNull();
        const calls = f.fetch.mock.calls.filter(([url]) => url.endsWith('/platform/logout')); expect(calls).toHaveLength(1);
        expect(new Headers(calls[0][1].headers).get('x-tokenhub-csrf')).toBe(account().csrf);
        expect([...f.local.entries(), ...f.tab.entries()].filter(([key]) => !key.startsWith('tokenhub-platform-history-key:'))).toEqual([]);
    });
    it('keeps a confirmed signed-out page stopped on focus and reload when another tab logs in', async () => {
        await render(account(), true); await act(async () => { await context.logout(); });
        expect(context.session).toBeNull();
        expect(new URL(browser.location.href).searchParams.get('work_signed_out')).toBe('1');
        expect([...f.local.entries(), ...f.tab.entries()].filter(([key]) => !key.startsWith('tokenhub-platform-history-key:'))).toEqual([]);
        const next = account({ subject: '99', sessionId: 'other-tab-login', csrf: 'd'.repeat(43) }); f.session = next; f.fetch.mockClear();
        await act(async () => { browser.dispatchEvent(new Event('focus')); });
        expect(context.session).toBeNull(); expect(f.session).toEqual(next); expect(renderer!.root.findAllByType('AgentInput')).toHaveLength(0);
        await close(); f.mount.mockClear(); await render(account(), true);
        expect(context.session).toBeNull(); expect(f.mount).not.toHaveBeenCalled(); expect(f.session).toEqual(next);
        expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/platform/logout') || url.endsWith('/platform/models'))).toBe(false);
    });
    it('explicit successful callback clears old sign-out intent before the next foreground check', async () => {
        await failedLogout(); const state = 's'.repeat(43);
        f.tab.set('tokenhub-platform-flow:v1:' + origin, JSON.stringify({ state, at: now }));
        const next = account({ subject: '99', sessionId: 'explicit-new-session', csrf: 'd'.repeat(43) }); f.session = next;
        await act(async () => { await context.complete(origin + '/work/tokenhub/callback?state=' + state + '&code=synthetic-code'); });
        expect(context.session).toEqual(next); f.fetch.mockClear();
        await act(async () => { browser.dispatchEvent(new Event('focus')); });
        expect(context.session).toEqual(next); expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/platform/logout'))).toBe(false);
        expect([...f.local.entries(), ...f.tab.entries()].filter(([key]) => !key.startsWith('tokenhub-platform-history-key:'))).toEqual([]);
    });
    it('Retry in the actual welcome UI cannot reload away an unconfirmed explicit logout', async () => {
        await render(account(), true, true); f.logoutFails = true;
        await act(async () => { await expect(context.logout()).rejects.toThrow(); });
        const retry = renderer!.root.findAllByType('RoundButton').find((node: any) => typeof node.props.action === 'function');
        expect(retry).toBeDefined(); await act(async () => { await retry.props.action(); });
        expect(f.reload).not.toHaveBeenCalled(); expect(context.session).toBeNull(); expect(context.status).not.toBe('ready');
    });
    it('uses only a non-sensitive URL stop marker if local intent storage cannot persist', async () => {
        await render(account(), true); f.keyFail = true; f.logoutFails = true;
        await act(async () => { await expect(context.logout()).rejects.toThrow(); });
        expect(new URL(browser.location.href).searchParams.get('work_signed_out')).toBe('1');
        expect(browser.location.href).not.toContain(account().csrf); expect(browser.location.href).not.toContain(account().sessionId);
        await close(); f.mount.mockClear(); await render(account(), true);
        expect(context.session).toBeNull(); expect(f.mount).not.toHaveBeenCalled();
    });
});
