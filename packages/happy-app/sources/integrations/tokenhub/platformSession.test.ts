import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ server: 'https://work.example.test', fetch: vi.fn(), assign: vi.fn(), replace: vi.fn() }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => f.server }));
// A new Work user has no Happy credential, seed, signing key, or legacy login fallback.
vi.mock('@/auth/tokenStorage', () => { throw new Error('Platform auth imported legacy TokenStorage'); });
vi.mock('@/auth/AuthContext', () => { throw new Error('Platform auth imported legacy AuthContext'); });
vi.mock('@/encryption/libsodium.lib', () => { throw new Error('Platform auth imported legacy signing keys'); });
vi.mock('./login', () => { throw new Error('Platform auth imported legacy login'); });
vi.mock('./sessionLifecycle', () => { throw new Error('Platform auth imported legacy identity lifecycle'); });
import {
    beginPlatformLogin, completePlatformLogin, endPlatformSession, hasPlatformLogin,
    parsePlatformSession, platformSessionEnabled, readPlatformSession, type PlatformSession,
} from './platformSession';
import { createWorkMockClient } from './workMockClient';
import { isPlatformRoute } from './platformRouting';

const origin = 'https://work.example.test';
const authority = 'https://accounts.example.test';
const state = 's'.repeat(43);
const flowKey = 'tokenhub-platform-flow:v1:' + origin;
const now = 1_800_000_000_000;
const session = (): PlatformSession => ({ authority, issuer: 'synthetic-core', subject: '42', sessionId: 'synthetic-session', expiresAt: now + 60_000, csrf: 'c'.repeat(43) });
function storage() {
    const values = new Map<string, string>();
    return { values, getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
        removeItem: vi.fn((key: string) => { values.delete(key); }) };
}
let tab: ReturnType<typeof storage>, local: ReturnType<typeof storage>;
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function authorization(nextState = state) {
    const target = new URL(authority + '/happy/authorize');
    target.search = new URLSearchParams({ client_id: 'happy-web', state: nextState, redirect_uri: origin + '/tokenhub/callback', code_challenge_method: 'S256', code_challenge: 'p'.repeat(43) }).toString();
    return { authorizeUrl: target.toString(), tokenHubOrigin: authority, state: nextState };
}
function callback(query = 'state=' + state + '&code=synthetic-code', path = '/work/tokenhub/callback') { return origin + path + '?' + query; }
function flow(nextState = state, at = now) { tab.setItem(flowKey, JSON.stringify({ state: nextState, at })); }
async function begin() { f.fetch.mockResolvedValueOnce(json(authorization())); await beginPlatformLogin(); }
function expectCookieOnly(init: RequestInit) {
    expect(init).toMatchObject({ credentials: 'include', redirect: 'error', cache: 'no-store' });
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
}
beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    f.server = origin; f.fetch.mockReset(); f.assign.mockReset(); f.replace.mockReset();
    tab = storage(); local = storage();
    vi.stubGlobal('sessionStorage', tab); vi.stubGlobal('localStorage', local); vi.stubGlobal('fetch', f.fetch);
    vi.stubGlobal('window', { location: { origin, pathname: '/work/', assign: f.assign }, history: { replaceState: f.replace } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('seedless Work platform authentication', () => {
    it('is explicit opt-in and distinguishes normal Work from deliberate device routes', () => {
        vi.stubEnv('EXPO_PUBLIC_TOKENHUB_PLATFORM_AUTH', '1'); expect(platformSessionEnabled()).toBe(true);
        vi.stubEnv('EXPO_PUBLIC_TOKENHUB_PLATFORM_AUTH', '0'); expect(platformSessionEnabled()).toBe(false);
        expect(isPlatformRoute('/')).toBe(true); expect(isPlatformRoute('/new')).toBe(true);
        expect(isPlatformRoute('/tokenhub/callback')).toBe(true);
        expect(isPlatformRoute('/new', 'device')).toBe(false); expect(isPlatformRoute('/device-agents')).toBe(false);
    });
    it('starts with no Happy identity and stores only one-time navigation state', async () => {
        await begin();
        expect(f.fetch).toHaveBeenCalledOnce();
        const [url, init] = f.fetch.mock.calls[0];
        expect(url).toBe(origin + '/v1/tokenhub/platform/start'); expect(init.method).toBe('POST');
        expectCookieOnly(init); expect(JSON.parse(init.body)).toEqual({});
        expect([...tab.values]).toEqual([[flowKey, JSON.stringify({ state, at: now })]]);
        expect(local.getItem).not.toHaveBeenCalled(); expect(local.setItem).not.toHaveBeenCalled();
        expect(f.assign).toHaveBeenCalledWith(authorization().authorizeUrl);
        // The Core allowlisted callback is root-based, even while the app runs under /work/.
        expect(new URL(f.assign.mock.calls[0][0]).searchParams.get('redirect_uri')).toBe(origin + '/tokenhub/callback');
    });
    it('completes the /work/ UI callback with a cookie exchange and no client credential persistence', async () => {
        await begin(); f.fetch.mockResolvedValueOnce(json({ ...session(), token: 'must-not-keep', secret: 'must-not-keep' }));
        await expect(completePlatformLogin(callback())).resolves.toEqual(session());
        expect(f.replace).toHaveBeenCalledWith(null, '', '/work/tokenhub/callback');
        const [url, init] = f.fetch.mock.calls[1]; expect(url).toBe(origin + '/v1/tokenhub/platform/complete');
        expectCookieOnly(init); expect(JSON.parse(init.body)).toEqual({ state, code: 'synthetic-code' });
        expect(tab.values.size).toBe(0); expect(local.values.size).toBe(0);
        expect(local.setItem).not.toHaveBeenCalled();
        expect(JSON.stringify(tab.setItem.mock.calls)).not.toMatch(/must-not-keep|csrf|sessionId|secret|token"/);
    });
    it('reads the HttpOnly-cookie session after reload or in a fresh tab without needing callback state', async () => {
        f.fetch.mockImplementation(async () => json(session()));
        await expect(readPlatformSession()).resolves.toEqual(session());
        tab = storage(); vi.stubGlobal('sessionStorage', tab);
        await expect(readPlatformSession()).resolves.toEqual(session());
        expect(f.fetch).toHaveBeenCalledTimes(2);
        for (const [url, init] of f.fetch.mock.calls) { expect(url).toBe(origin + '/v1/tokenhub/platform/session'); expect(init.method).toBe('GET'); expect(init.body).toBeUndefined(); expectCookieOnly(init); }
        expect(tab.getItem).not.toHaveBeenCalled(); expect(local.getItem).not.toHaveBeenCalled();
    });
    it('returns signed-out only for 401 and posts logout with CSRF, never bearer', async () => {
        f.fetch.mockResolvedValueOnce(new Response('', { status: 401 })); await expect(readPlatformSession()).resolves.toBeNull();
        f.fetch.mockResolvedValueOnce(new Response('', { status: 401 })); await expect(endPlatformSession(session())).resolves.toBeUndefined();
        const [url, init] = f.fetch.mock.calls[1]; expect(url).toBe(origin + '/v1/tokenhub/platform/logout'); expectCookieOnly(init);
        expect(new Headers(init.headers).get('x-tokenhub-csrf')).toBe(session().csrf); expect(JSON.parse(init.body)).toEqual({});
    });
    it('propagates abort to the session request rather than trying a legacy credential', async () => {
        const controller = new AbortController();
        f.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('cancelled')))));
        const pending = readPlatformSession(controller.signal); controller.abort();
        await expect(pending).rejects.toThrow('cancelled'); expect(f.fetch.mock.calls[0][1].signal).toBe(controller.signal); expect(f.fetch).toHaveBeenCalledOnce();
    });
    it.each([403, 409, 500, 503])('fails closed on HTTP %s without trying another endpoint', async status => {
        f.fetch.mockResolvedValueOnce(json({ error: 'synthetic-private-response' }, status));
        await expect(readPlatformSession()).rejects.toThrow('unavailable');
        expect(f.fetch).toHaveBeenCalledOnce(); expect(local.values.size).toBe(0); expect(tab.values.size).toBe(0);
    });
    it.each([null, {}, { ...session(), expiresAt: now }, { ...session(), authority: 'http://accounts.example.test' },
        { ...session(), authority: authority + '/path' }, { ...session(), authority: 'https://user:password@accounts.example.test' },
        { ...session(), issuer: '' }, { ...session(), subject: '0' }, { ...session(), subject: '01' },
        { ...session(), sessionId: '' }, { ...session(), csrf: 'bad' }, { ...session(), expiresAt: 'later' },
    ])('rejects malformed or expired session response %#', value => { expect(() => parsePlatformSession(value)).toThrow('could not be verified'); });
    it('rejects a non-JSON session and invalid JSON without changing local identity', async () => {
        f.fetch.mockResolvedValueOnce(new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }));
        await expect(readPlatformSession()).rejects.toThrow();
        f.fetch.mockResolvedValueOnce(new Response('{invalid', { headers: { 'content-type': 'application/json' } }));
        await expect(readPlatformSession()).rejects.toThrow(); expect(local.setItem).not.toHaveBeenCalled();
    });
    it.each(['https://other.example.test', origin + '?x=1', origin + '#fragment', 'https://user:pass@work.example.test'])('refuses an unsafe or cross-origin configured server %s before sending anything', async server => {
        f.server = server; await expect(readPlatformSession()).rejects.toThrow('same-origin'); expect(f.fetch).not.toHaveBeenCalled();
    });
    it.each([
        ['redirect_uri', origin + '/work/tokenhub/callback'], ['redirect_uri', 'https://evil.example.test/tokenhub/callback'],
        ['client_id', 'other'], ['state', 'wrong'], ['code_challenge_method', 'plain'],
    ])('rejects an authorization URL with invalid %s', async (key, value) => {
        const data = authorization(); const url = new URL(data.authorizeUrl); url.searchParams.set(key, value); data.authorizeUrl = url.toString();
        f.fetch.mockResolvedValueOnce(json(data)); await expect(beginPlatformLogin()).rejects.toThrow('invalid');
        expect(f.assign).not.toHaveBeenCalled(); expect(tab.values.size).toBe(0);
    });
    it('rejects an authorization redirect to another origin', async () => {
        f.fetch.mockResolvedValueOnce(json({ ...authorization(), authorizeUrl: authorization().authorizeUrl.replace(authority, 'https://evil.example.test') }));
        await expect(beginPlatformLogin()).rejects.toThrow('invalid'); expect(f.assign).not.toHaveBeenCalled();
    });
});

describe('one-use callback and navigation isolation', () => {
    it('matches only this tab’s current flow', () => { expect(hasPlatformLogin(callback())).toBe(false); flow(); expect(hasPlatformLogin(callback())).toBe(true); expect(hasPlatformLogin(callback('state=old'))).toBe(false); });
    it('cancels the matching server flow even when cancellation response fails', async () => {
        flow(); f.fetch.mockResolvedValueOnce(json({}, 503));
        await expect(completePlatformLogin(callback('state=' + state + '&error=access_denied'))).rejects.toThrow('cancelled');
        expect(JSON.parse(f.fetch.mock.calls[0][1].body)).toEqual({ state, error: 'access_denied' });
        expect(tab.getItem(flowKey)).toBeNull(); expect(f.replace).toHaveBeenCalledWith(null, '', '/work/tokenhub/callback');
    });
    it('a stale callback does not exchange or erase newer state', async () => {
        flow('n'.repeat(43)); const before = tab.getItem(flowKey);
        await expect(completePlatformLogin(callback())).rejects.toThrow('not the current');
        expect(tab.getItem(flowKey)).toBe(before); expect(f.fetch).not.toHaveBeenCalled();
    });
    it.each([now - 300_001, now + 1])('rejects expired or future navigation state %s', async at => {
        flow(state, at); await expect(completePlatformLogin(callback())).rejects.toThrow('expired'); expect(f.fetch).not.toHaveBeenCalled();
    });
    it.each(['state=' + state + '&state=' + state + '&code=x', 'state=' + state + '&code=x&code=y', 'state=' + state + '&error=x&error=y'])('rejects duplicate callback parameters without exchange', async query => {
        flow(); await expect(completePlatformLogin(callback(query))).rejects.toThrow('not the current'); expect(f.fetch).not.toHaveBeenCalled();
    });
    it('rejects callbacks from another origin or a non-callback path', async () => {
        flow(); await expect(completePlatformLogin(callback().replace(origin, 'https://evil.example.test'))).rejects.toThrow('invalid');
        await expect(completePlatformLogin(callback(undefined, '/work/other'))).rejects.toThrow('invalid'); expect(f.fetch).not.toHaveBeenCalled();
    });
    it.each([json({}, 503), json({ ...session(), expiresAt: now })])('consumes a matching attempted exchange even on an unusable server response %#', async response => {
        flow(); f.fetch.mockResolvedValueOnce(response); await expect(completePlatformLogin(callback())).rejects.toThrow();
        expect(tab.getItem(flowKey)).toBeNull(); await expect(completePlatformLogin(callback())).rejects.toThrow('expired'); expect(f.fetch).toHaveBeenCalledOnce();
    });
    it('does not erase a newer login while a previous exchange is resolving', async () => {
        flow(); let finish!: (response: Response) => void;
        f.fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
        const pending = completePlatformLogin(callback()); flow('n'.repeat(43)); finish(json(session()));
        await pending; expect(JSON.parse(tab.getItem(flowKey)!).state).toBe('n'.repeat(43));
    });
    it('does not exchange a consumed callback twice', async () => {
        flow(); f.fetch.mockResolvedValueOnce(json(session())); await completePlatformLogin(callback());
        await expect(completePlatformLogin(callback())).rejects.toThrow(); expect(f.fetch).toHaveBeenCalledOnce();
    });
    it('claims a callback before awaiting the exchange so repeated concurrent invocations are one-use', async () => {
        flow(); const finishers: Array<(response: Response) => void> = [];
        f.fetch.mockImplementation(() => new Promise<Response>(resolve => { finishers.push(resolve); }));
        const first = completePlatformLogin(callback());
        const second = completePlatformLogin(callback());
        // Resolve all transports even on a broken implementation; do not leave open promises.
        const count = f.fetch.mock.calls.length;
        finishers.forEach(finish => finish(json(session())));
        const results = await Promise.allSettled([first, second]);
        expect(count).toBe(1); expect(results[0].status).toBe('fulfilled'); expect(results[1].status).toBe('rejected');
    });
});

describe('platform Work gateway transport', () => {
    it('uses only the same-origin BFF cookie and CSRF for both catalog and model calls', async () => {
        const tokenProvider = vi.fn(() => { throw new Error('Legacy credentials must not be requested'); });
        const transport = vi.fn(async (url: string, init: RequestInit) => {
            if (url.endsWith('/models')) return json({ mode: 'real', billable: true, models: [{ id: 'synthetic-model', name: 'Synthetic Model' }] });
            const input = JSON.parse(init.body as string);
            return new Response([{ type: 'delta', text: 'synthetic answer' }, { type: 'usage', model: input.model, requestId: input.requestId, inputTokens: 1, outputTokens: 2, mock: false, billable: true, accounting: 'core' }, { type: 'done' }].map(value => JSON.stringify(value)).join('\n'), { headers: { 'content-type': 'application/x-ndjson' } });
        });
        const client = createWorkMockClient({ baseUrl: origin, platformSession: { origin, csrf: session().csrf }, tokenProvider, fetch: transport, requireRealCatalog: true });
        await client.getCatalog(); const onDelta = vi.fn();
        await client.stream({ model: 'synthetic-model', messages: [{ role: 'user', content: 'synthetic prompt' }], requestId: '00000000-0000-4000-8000-000000000001' }, onDelta);
        expect(tokenProvider).not.toHaveBeenCalled(); expect(onDelta).toHaveBeenCalledWith('synthetic answer');
        expect(transport.mock.calls.map(([url]) => url)).toEqual([origin + '/v1/tokenhub/platform/models', origin + '/v1/tokenhub/platform/stream']);
        for (const [, init] of transport.mock.calls) { expectCookieOnly(init); expect(new Headers(init.headers).get('x-tokenhub-csrf')).toBe(session().csrf); }
        expect(local.values.size).toBe(0); expect(tab.values.size).toBe(0);
    });
    it('refuses cross-origin platform credentials before any request', () => {
        expect(() => createWorkMockClient({ baseUrl: 'https://other.example.test', platformSession: { origin, csrf: session().csrf }, tokenProvider: async () => null })).toThrow('configuration');
        expect(f.fetch).not.toHaveBeenCalled();
    });
});
