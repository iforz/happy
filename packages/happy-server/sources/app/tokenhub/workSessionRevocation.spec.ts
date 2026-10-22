import { afterEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { AUTHCENTER_TIMEOUT_MS, createWorkAuthorization } from './workAuthorization';
import { auth } from '@/app/auth/auth';

vi.mock('@/utils/log', () => ({ debug: vi.fn(), log: vi.fn() }));
const now = 1_800_000_000_000, authority = 'https://accounts.example.test';
const env = { TOKENHUB_UNIFIED_AUTH: 'true', TOKENHUB_AUTHCENTER_URL: 'http://127.0.0.1:28084', TOKENHUB_URL: authority };
const claims = { iss: 'tokenapi', aud: ['work'], sub: '42', user_id: 42, token_version: 0, sid: 'own-session-a', iat: now / 1000 - 120, nbf: now / 1000 - 120, exp: now / 1000 + 60 };
function workToken(change: object = {}, header: object = { alg: 'HS256', typ: 'JWT' }) {
    const body = [header, { ...claims, ...change }].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return body + '.' + createHmac('sha256', 'isolated-work-fixture-only').update(body).digest('base64url');
}
function workTokenWithVersion(versionJSON: string, extra: object = {}) {
    const payload = JSON.stringify({ ...claims, ...extra }).replace('"token_version":0', `"token_version":${versionJSON}`);
    const body = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url') + '.' + Buffer.from(payload).toString('base64url');
    return body + '.' + createHmac('sha256', 'isolated-work-fixture-only').update(body).digest('base64url');
}
const grant = { authorizationToken: workToken(), authority, issuer: 'sso-issuer', subject: '42', publicKey: 'ab'.repeat(32) };
const binding = { authority, issuer: grant.issuer, subject: '42', accountId: 'happy-a', account: { id: 'happy-a', publicKey: grant.publicKey } };
function fixture(options: { happy?: unknown; binding?: unknown; response?: unknown; status?: number; transport?: typeof fetch } = {}) {
    const transport = options.transport ?? vi.fn(async () => new Response(JSON.stringify(options.response ?? { revoked: true, application: 'work' }), { status: options.status ?? 200, headers: { 'content-type': 'application/json' } }));
    const verifyHappyToken = vi.fn().mockResolvedValue('happy' in options ? options.happy : { userId: 'happy-a', extras: { tokenhub: grant } });
    const findBinding = vi.fn().mockResolvedValue('binding' in options ? options.binding : binding);
    return { transport, verifyHappyToken, findBinding, authorization: createWorkAuthorization({ env: { ...env }, transport, verifyHappyToken, findBinding, now: () => now }) };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

it('revokes only the embedded Work token after crypto and persistent binding, with no authorization call', async () => {
    const f = fixture();
    expect(await f.authorization.revokeToken('signed-happy')).toBe('revoked');
    expect(f.transport).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:28084/v1/session/revoke', expect.objectContaining({
        method: 'POST', redirect: 'error', credentials: 'omit', body: '{"application":"work"}',
        headers: { Authorization: `Bearer ${grant.authorizationToken}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Cache-Control': 'no-store' },
    }));
    expect(f.verifyHappyToken.mock.invocationCallOrder[0]).toBeLessThan(f.findBinding.mock.invocationCallOrder[0]);
    expect(f.findBinding.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.transport).mock.invocationCallOrder[0]);
});

it('keeps sessions separate and repeats the actual revocation rather than caching success', async () => {
    const f = fixture();
    f.verifyHappyToken.mockImplementation(async token => ({ userId: 'happy-a', extras: { tokenhub: { ...grant, authorizationToken: workToken({ sid: token }) } } }));
    for (const token of ['own-session-a', 'own-session-a', 'own-session-b']) expect(await f.authorization.revokeToken(token)).toBe('revoked');
    expect(vi.mocked(f.transport).mock.calls.map(([, init]) => {
        const bearer = (init!.headers as Record<string, string>).Authorization.slice(7);
        return JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).sid;
    })).toEqual(['own-session-a', 'own-session-a', 'own-session-b']);
});

it.each(['disabled', 'expired', 'already-revoked'])('does not require live authorization for %s Work grants', async state => {
    const authorizationToken = workToken(state === 'expired' ? { exp: now / 1000 - 60 } : {});
    const transport = vi.fn(async url => {
        if (String(url).endsWith('/verify')) return new Response('{}', { status: 401 });
        return new Response('{"revoked":true,"application":"work"}', { headers: { 'content-type': 'application/json' } });
    });
    const f = fixture({ happy: { userId: 'happy-a', extras: { tokenhub: { ...grant, authorizationToken } } }, transport });
    expect(await f.authorization.revokeToken('signed-happy')).toBe('revoked');
    expect(transport).toHaveBeenCalledOnce(); expect(transport.mock.calls[0][0]).toContain('/revoke');
});

it.each([
    ['invalid Happy signature', null], ['legacy Happy token', { userId: 'happy-a' }],
    ['other Happy identity', { userId: 'happy-b', extras: { tokenhub: grant } }],
    ['wrong pinned authority', { userId: 'happy-a', extras: { tokenhub: { ...grant, authority: 'https://evil.test' } } }],
    ['changed public key', { userId: 'happy-a', extras: { tokenhub: { ...grant, publicKey: 'cd'.repeat(32) } } }],
    ['changed issuer', { userId: 'happy-a', extras: { tokenhub: { ...grant, issuer: 'other' } } }],
])('rejects %s before contacting Authcenter', async (_label, happy) => {
    const f = fixture({ happy }); expect(await f.authorization.revokeToken('signed-happy')).toBe('invalid'); expect(f.transport).not.toHaveBeenCalled();
});

it.each([
    null, { ...binding, accountId: 'happy-b' }, { ...binding, account: { ...binding.account, id: 'happy-b' } },
    { ...binding, issuer: 'other' }, { ...binding, authority: 'https://evil.test' }, { ...binding, subject: '99' },
    { ...binding, account: { ...binding.account, publicKey: 'cd'.repeat(32) } },
])('rejects a missing or mismatched persistent binding without revoking', async row => {
    const f = fixture({ binding: row }); expect(await f.authorization.revokeToken('signed-happy')).toBe('invalid'); expect(f.transport).not.toHaveBeenCalled();
});

it.each([
    { aud: ['admin'] }, { aud: ['work', 'admin'] }, { aud: 'work' }, { iss: 'other' }, { sub: '99' },
    { sid: '' }, { sid: 'bad session' }, { token_version: undefined }, { token_version: -1 },
    { exp: undefined }, { exp: '1900000000' }, { exp: 1.5 }, { exp: 1 },
    { iat: now / 1000 + 5 }, { nbf: now / 1000 + 5 },
])('does not forward wrong-purpose or malformed embedded grants %j', async change => {
    const f = fixture({ happy: { userId: 'happy-a', extras: { tokenhub: { ...grant, authorizationToken: workToken(change) } } } });
    expect(await f.authorization.revokeToken('signed-happy')).toBe('invalid'); expect(f.transport).not.toHaveBeenCalled();
});

it.each(['not-a-jwt', workToken({}, { alg: 'none' }), workToken({}, { alg: 'HS512' })])('does not forward malformed or alternate-algorithm grants', async authorizationToken => {
    const f = fixture({ happy: { userId: 'happy-a', extras: { tokenhub: { ...grant, authorizationToken } } } });
    expect(await f.authorization.revokeToken('signed-happy')).toBe('invalid'); expect(f.transport).not.toHaveBeenCalled();
});

it.each([401, 403])('returns invalid when Core rejects an embedded signature with %s', async status => {
    expect(await fixture({ status }).authorization.revokeToken('signed-happy')).toBe('invalid');
});
it.each([201, 302, 400, 500, 503])('does not acknowledge an unconfirmed status %s', async status => {
    expect(await fixture({ status }).authorization.revokeToken('signed-happy')).toBe('unavailable');
});
it.each([{}, { revoked: false, application: 'work' }, { revoked: 'true', application: 'work' }, { revoked: true }, { revoked: true, application: 'admin' }, { code: 0, data: { revoked: true, application: 'work' } }, { revoked: true, application: 'work', sid: 'other' }])('fails closed on malformed acknowledgements %j', async response => {
    expect(await fixture({ response }).authorization.revokeToken('signed-happy')).toBe('unavailable');
});

it.each(['crypto', 'database', 'headers', 'body'])('times out a stalled %s and never starts a late revoke', async stage => {
    vi.useFakeTimers(); const f = fixture();
    let finish: ((value: any) => void) | undefined;
    if (stage === 'crypto') f.verifyHappyToken.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    else if (stage === 'database') f.findBinding.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    else vi.mocked(f.transport).mockImplementation(() => stage === 'headers' ? new Promise<Response>(() => {}) : Promise.resolve(new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } })));
    const pending = f.authorization.revokeToken('signed-happy');
    await vi.advanceTimersByTimeAsync(AUTHCENTER_TIMEOUT_MS);
    expect(await pending).toBe('unavailable');
    finish?.(stage === 'crypto' ? { userId: 'happy-a', extras: { tokenhub: grant } } : binding);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.transport).toHaveBeenCalledTimes(stage === 'crypto' || stage === 'database' ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
});

it('handles database, offline, oversize, non-JSON and invalid-JSON failures without success', async () => {
    const f = fixture(); f.findBinding.mockRejectedValue(new Error('private database error'));
    expect(await f.authorization.revokeToken('signed-happy')).toBe('unavailable'); expect(f.transport).not.toHaveBeenCalled();
    for (const response of [new Response('x'.repeat(17000), { headers: { 'content-type': 'application/json' } }), new Response('{}'), new Response('{', { headers: { 'content-type': 'application/json' } })]) {
        expect(await fixture({ transport: vi.fn().mockResolvedValue(response) }).authorization.revokeToken('signed-happy')).toBe('unavailable');
    }
    expect(await fixture({ transport: vi.fn().mockRejectedValue(new Error('connection refused')) }).authorization.revokeToken('signed-happy')).toBe('unavailable');
});

it('never falls back to non-unified Happy authorization', async () => {
    const f = fixture(), authorization = createWorkAuthorization({ env: { TOKENHUB_UNIFIED_AUTH: 'false' }, transport: f.transport, verifyHappyToken: f.verifyHappyToken, findBinding: f.findBinding });
    expect(await authorization.revokeToken('legacy')).toBe('unavailable'); expect(f.verifyHappyToken).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
});

it('uses real fresh Happy cryptographic verification, rejecting forged and cached-only payloads', async () => {
    vi.useFakeTimers(); vi.stubEnv('HANDY_MASTER_SECRET', 'isolated-own-session-logout-test-seed');
    await auth.init(); vi.clearAllTimers();
    const f = fixture();
    const authorization = createWorkAuthorization({ env, now: () => now, transport: f.transport, findBinding: f.findBinding });
    const extras = { tokenhub: { ...grant } };
    const token = await auth.createToken('happy-a', extras);
    extras.tokenhub.authority = 'https://evil.test';
    expect(await authorization.revokeToken(token)).toBe('revoked');
    expect(await authorization.revokeToken(token + 'forged')).toBe('invalid');
    const wrongIdentity = await auth.createToken('happy-b', { tokenhub: grant });
    expect(await authorization.revokeToken(wrongIdentity)).toBe('invalid');
    const legacy = await auth.createToken('happy-a');
    expect(await authorization.revokeToken(legacy)).toBe('invalid');
    // The Happy wrapper's own cryptographic validity is never relaxed, even though
    // an expired inner Work grant can revoke. privacy-kit's verifier enforces exp.
    const expiredHappy = await auth.createToken('happy-a', { tokenhub: grant, exp: Math.floor(Date.now() / 1000) - 60 });
    expect(await authorization.revokeToken(expiredHappy)).toBe('invalid');
    const mismatched = { tokenhub: { ...grant, subject: '99' } };
    const cachedWrong = await auth.createToken('happy-a', mismatched); mismatched.tokenhub.subject = '42';
    expect(await authorization.revokeToken(cachedWrong)).toBe('invalid');
    expect(f.transport).toHaveBeenCalledOnce();
});


it.each(['9007199254740993', '9223372036854775807'])('forwards an exact int64 version %s without JS rounding or resigning', async versionJSON => {
    const authorizationToken = workTokenWithVersion(versionJSON, { email: 'quoted \"token_version\":0 and 9007199254740993', nested: { token_version: 1 } });
    const f = fixture({ happy: { userId: 'happy-a', extras: { tokenhub: { ...grant, authorizationToken } } } });
    expect(await f.authorization.revokeToken('signed-happy')).toBe('revoked');
    expect(vi.mocked(f.transport).mock.calls[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${authorizationToken}` });
});

it.each(['9223372036854775808', '9007199254740993.1', '1e3', '-1', '"9007199254740993"', 'null'])('rejects non-int64 JSON version %s before forwarding', async versionJSON => {
    const authorizationToken = workTokenWithVersion(versionJSON);
    const f = fixture({ happy: { userId: 'happy-a', extras: { tokenhub: { ...grant, authorizationToken } } } });
    expect(await f.authorization.revokeToken('signed-happy')).toBe('invalid'); expect(f.transport).not.toHaveBeenCalled();
});


it('accepts a Go jwt/v5 serialized int64 fingerprint without changing the signed bytes', async () => {
    // Generated with Go jwt.NewWithClaims(HS256, jwt.MapClaims), version MaxInt64-17,
    // public test-only key "isolated-work-fixture-only", and the fixed fixture dates.
    const authorizationToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOlsid29yayJdLCJleHAiOjE4MDAwMDAwNjAsImlhdCI6MTc5OTk5OTg4MCwiaXNzIjoidG9rZW5hcGkiLCJuYmYiOjE3OTk5OTk4ODAsInNpZCI6Im93bi1zZXNzaW9uLWEiLCJzdWIiOiI0MiIsInRva2VuX3ZlcnNpb24iOjkyMjMzNzIwMzY4NTQ3NzU3OTAsInVzZXJfaWQiOjQyfQ.PWJHo-gs_xhWI4GHA5xBjZZzgbvMod3BmBhACl-PEfw";
    const f = fixture({ happy: { userId: 'happy-a', extras: { tokenhub: { ...grant, authorizationToken } } } });
    expect(await f.authorization.revokeToken('signed-happy')).toBe('revoked');
    expect(vi.mocked(f.transport).mock.calls[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${authorizationToken}` });
});
