import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTHCENTER_TIMEOUT_MS, authcenterOrigin, createWorkAuthorization, type TokenHubSession } from './workAuthorization';

const authority = 'https://accounts.example.test';
const env = { TOKENHUB_UNIFIED_AUTH: 'true', TOKENHUB_AUTHCENTER_URL: 'http://127.0.0.1:28084', TOKENHUB_URL: authority };
const now = 1_800_000_000_000;
const grant: TokenHubSession = { authorizationToken: 'test-work-token', authority, issuer: 'tokenapi', subject: '42', publicKey: 'ab'.repeat(32) };
const active = { active: true, application: 'work', issuer: 'tokenapi', subject: '42', session_id: 'test-session', expires_at: now / 1000 + 60, permissions: ['work:access'] };
const binding = { authority, issuer: 'tokenapi', subject: '42', accountId: 'happy-a', account: { id: 'happy-a', publicKey: grant.publicKey } };
const attribution = { authority, issuer: 'tokenapi', subject: '42', sessionId: 'test-session' };

function fixture(options: { response?: unknown; status?: number; happy?: unknown; binding?: unknown; transport?: typeof fetch } = {}) {
    const transport = options.transport ?? vi.fn(async () => new Response(JSON.stringify(options.response ?? active), { status: options.status ?? 200, headers: { 'content-type': 'application/json' } }));
    const verifyHappyToken = vi.fn().mockResolvedValue('happy' in options ? options.happy : { userId: 'happy-a', extras: { tokenhub: grant } });
    const findBinding = vi.fn().mockResolvedValue('binding' in options ? options.binding : binding);
    return { transport, verifyHappyToken, findBinding, authorization: createWorkAuthorization({ env, now: () => now, transport, verifyHappyToken, findBinding }) };
}
afterEach(() => vi.useRealTimers());

describe('pinned configuration', () => {
    it('allows only a literal loopback HTTP origin', () => {
        expect(authcenterOrigin('http://127.0.0.1:28084')).toBe('http://127.0.0.1:28084');
        for (const url of ['http://localhost:28084', 'http://127.1:28084', 'http://2130706433:28084', 'http://127.0.0.1:28084/', 'http://127.0.0.1:28084/a', 'http://user@127.0.0.1:28084', 'https://127.0.0.1:28084', 'http://10.0.0.1:28084', 'http://127.0.0.1:28084?url=https://evil.test', 'http://127.0.0.1:99999']) expect(() => authcenterOrigin(url)).toThrow();
    });
    it('rejects an invalid enabled flag and never silently downgrades missing configuration', () => {
        expect(() => createWorkAuthorization({ env: { TOKENHUB_UNIFIED_AUTH: 'TRUE' } })).toThrow();
        expect(() => createWorkAuthorization({ env: { TOKENHUB_UNIFIED_AUTH: 'true' } })).toThrow();
    });
    it('captures configuration at construction, rather than reading request-derived URLs or mutable env', async () => {
        const localEnv = { ...env };
        const f = fixture();
        const authorization = createWorkAuthorization({ env: localEnv, now: () => now, transport: f.transport, verifyHappyToken: f.verifyHappyToken, findBinding: f.findBinding });
        localEnv.TOKENHUB_UNIFIED_AUTH = 'false'; localEnv.TOKENHUB_AUTHCENTER_URL = 'https://evil.test';
        await authorization.verifyToken('signed-happy');
        expect(f.transport).toHaveBeenCalledWith('http://127.0.0.1:28084/v1/session/verify', expect.anything());
        expect(authorization.enabled).toBe(true);
    });
});

it('verifies Happy first, checks authority every time and enforces the current identity/key binding', async () => {
    const f = fixture();
    expect(await f.authorization.verifyToken('signed-happy', { ip: '::ffff:127.0.0.1', userAgent: 'work-test' })).toEqual({ userId: 'happy-a', expiresAt: active.expires_at * 1000, tokenhub: attribution });
    await f.authorization.verifyToken('signed-happy');
    expect(f.verifyHappyToken).toHaveBeenCalledTimes(2); expect(f.transport).toHaveBeenCalledTimes(2); expect(f.findBinding).toHaveBeenCalledTimes(2);
    const first = vi.mocked(f.transport).mock.calls[0];
    expect(first[1]).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', body: '{"application":"work"}', headers: { Authorization: 'Bearer test-work-token', 'X-Client-IP': '127.0.0.1', 'User-Agent': 'work-test' } });
    expect(f.verifyHappyToken.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.transport).mock.invocationCallOrder[0]);
});

it.each([
    ['invalid signature', null], ['native Happy token', { userId: 'happy-a' }],
    ['wrong authority', { userId: 'happy-a', extras: { tokenhub: { ...grant, authority: 'https://evil.test' } } }],
    ['missing public key', { userId: 'happy-a', extras: { tokenhub: { ...grant, publicKey: undefined } } }],
    ['missing issuer', { userId: 'happy-a', extras: { tokenhub: { ...grant, issuer: '' } } }],
])('rejects %s before calling Authcenter', async (_label, happy) => {
    const f = fixture({ happy }); expect(await f.authorization.verifyToken('signed-happy')).toBeNull(); expect(f.transport).not.toHaveBeenCalled(); expect(f.findBinding).not.toHaveBeenCalled();
});

it.each([
    ['inactive', { ...active, active: false }], ['wrong subject', { ...active, subject: '99' }],
    ['wrong issuer', { ...active, issuer: 'attacker' }], ['wrong app', { ...active, application: 'admin' }],
    ['expired', { ...active, expires_at: now / 1000 }], ['missing session', { ...active, session_id: '' }],
    ['missing permission', { ...active, permissions: [] }], ['unwrapped Core envelope', { code: 0, data: active }],
    ['invalid expiry', { ...active, expires_at: '9999999999' }],
])('fails closed for authority %s', async (_label, response) => {
    const f = fixture({ response }); expect(await f.authorization.verifyToken('signed-happy')).toBeNull(); expect(f.findBinding).not.toHaveBeenCalled();
});

it.each([401, 403, 500, 503])('denies revoked, disabled or unavailable authority status %s', async status => {
    expect(await fixture({ status }).authorization.verifyToken('signed-happy')).toBeNull();
});

it.each([
    ['deleted binding', null], ['other account', { ...binding, accountId: 'happy-b' }],
    ['replaced key', { ...binding, account: { id: 'happy-a', publicKey: 'cd'.repeat(32) } }],
    ['other account row', { ...binding, account: { ...binding.account, id: 'happy-b' } }],
    ['changed issuer', { ...binding, issuer: 'attacker' }],
])('rejects %s without creating/replacing identities', async (_label, row) => {
    expect(await fixture({ binding: row }).authorization.verifyToken('signed-happy')).toBeNull();
});

it('does not reuse a prior successful authority result after revocation', async () => {
    const f = fixture(); expect(await f.authorization.verifyToken('signed-happy')).not.toBeNull();
    vi.mocked(f.transport).mockResolvedValueOnce(new Response('{}', { status: 401 }));
    expect(await f.authorization.verifyToken('signed-happy')).toBeNull();
});

it('keeps the proved SSO issuer binding distinct from the fixed Core authorization issuer', async () => {
    const issuer = 'https://accounts.example.test/sso';
    const f = fixture({ happy: { userId: 'happy-a', extras: { tokenhub: { ...grant, issuer } } }, binding: { ...binding, issuer } });
    expect(await f.authorization.verifyToken('signed-happy')).toEqual({ userId: 'happy-a', expiresAt: active.expires_at * 1000, tokenhub: attribution });
});

it('attributes the session from the freshly verified authority response, never an extra client identity field', async () => {
    const f = fixture({ happy: { userId: 'happy-a', extras: { tokenhub: { ...grant, sessionId: 'untrusted-session', authorizationIssuer: 'untrusted-issuer' } } }, response: { ...active, session_id: 'fresh-authority-session' } });
    expect((await f.authorization.verifyToken('signed-happy'))?.tokenhub).toEqual({ ...attribution, sessionId: 'fresh-authority-session' });
    expect(await f.authorization.verifyGrant(grant)).toBe(active.expires_at * 1000);
});

it.each(['crypto', 'database'])('bounds a stalled %s operation as well as the authority request', async stage => {
    vi.useFakeTimers(); const f = fixture();
    (stage === 'crypto' ? f.verifyHappyToken : f.findBinding).mockImplementation(() => new Promise(() => {}));
    const pending = f.authorization.verifyToken('signed-happy');
    await vi.advanceTimersByTimeAsync(AUTHCENTER_TIMEOUT_MS);
    expect(await pending).toBeNull(); expect(vi.getTimerCount()).toBe(0);
});

it.each(['headers', 'body'])('bounds stalled authority %s to two seconds', async stage => {
    vi.useFakeTimers();
    const transport = vi.fn(() => stage === 'headers' ? new Promise<Response>(() => {}) : Promise.resolve(new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } })));
    const f = fixture({ transport }); const pending = f.authorization.verifyToken('signed-happy');
    await vi.advanceTimersByTimeAsync(AUTHCENTER_TIMEOUT_MS);
    expect(await pending).toBeNull(); expect(transport.mock.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
});

it('rejects oversize/non-JSON responses and transport failures', async () => {
    for (const response of [new Response('x'.repeat(17000), { headers: { 'content-type': 'application/json' } }), new Response('{}')]) {
        expect(await fixture({ transport: vi.fn().mockResolvedValue(response) }).authorization.verifyToken('signed-happy')).toBeNull();
    }
    expect(await fixture({ transport: vi.fn().mockRejectedValue(new Error('connection refused')) }).authorization.verifyToken('signed-happy')).toBeNull();
});

it('preserves upstream non-unified mode without calling Authcenter or database', async () => {
    const f = fixture({ happy: { userId: 'upstream-user' } });
    const authorization = createWorkAuthorization({ env: { TOKENHUB_UNIFIED_AUTH: 'false' }, transport: f.transport, findBinding: f.findBinding, verifyHappyToken: f.verifyHappyToken });
    expect(await authorization.verifyToken('legacy')).toEqual({ userId: 'upstream-user' }); expect(f.transport).not.toHaveBeenCalled(); expect(f.findBinding).not.toHaveBeenCalled();
});
