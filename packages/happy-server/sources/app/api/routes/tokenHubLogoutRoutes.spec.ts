import { afterEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Fastify } from '../types';
import { tokenHubLogoutRoutes } from './tokenHubLogoutRoutes';
import { enableAuthentication } from '../utils/enableAuthentication';
import { createWorkAuthorization } from '@/app/tokenhub/workAuthorization';

vi.mock('@/utils/log', () => ({ debug: vi.fn() }));
const apps: ReturnType<typeof fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.useRealTimers(); });
const now = 1_800_000_000_000, authority = 'https://accounts.example.test';
const body = [{ alg: 'HS256' }, { iss: 'tokenapi', aud: ['work'], user_id: 42, sub: '42', sid: 'own-sid', token_version: 0, iat: now / 1000 - 120, nbf: now / 1000 - 120, exp: now / 1000 - 60 }].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
const workToken = body + '.' + createHmac('sha256', 'isolated-route-fixture-only').update(body).digest('base64url');
const grant = { authority, issuer: 'sso-issuer', subject: '42', publicKey: 'ab'.repeat(32), authorizationToken: workToken };
const binding = { authority, issuer: 'sso-issuer', subject: '42', accountId: 'happy-user', account: { id: 'happy-user', publicKey: grant.publicKey } };
const headers = { authorization: 'Bearer signed-happy' };
function setup(options: { disabled?: boolean; result?: unknown; status?: number; transport?: typeof fetch; happy?: unknown; binding?: unknown } = {}) {
    const transport = options.transport ?? vi.fn(async url => {
        // Live authorization is deliberately unavailable for this expired/disabled fixture.
        if (String(url).endsWith('/verify')) return new Response('{}', { status: 401 });
        return new Response(JSON.stringify(options.result ?? { revoked: true, application: 'work' }), { status: options.status ?? 200, headers: { 'content-type': 'application/json' } });
    });
    const findBinding = vi.fn().mockResolvedValue('binding' in options ? options.binding : binding);
    const verifyHappyToken = vi.fn(async token => token === 'signed-happy' ? ('happy' in options ? options.happy : { userId: 'happy-user', extras: { tokenhub: grant } }) : null) as ReturnType<typeof vi.fn>;
    const authorization = createWorkAuthorization({
        env: { TOKENHUB_UNIFIED_AUTH: options.disabled ? 'false' : 'true', TOKENHUB_AUTHCENTER_URL: 'http://127.0.0.1:28084', TOKENHUB_URL: authority },
        transport, findBinding, verifyHappyToken, now: () => now,
    });
    const app = fastify(); apps.push(app); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    enableAuthentication(app as unknown as Fastify, authorization);
    tokenHubLogoutRoutes(app as unknown as Fastify, { authorization });
    app.get('/v1/private', async () => ({ secret: 'protected' }));
    return { app, transport, authorization, findBinding, verifyHappyToken };
}
function logout(app: ReturnType<typeof fastify>) { return app.inject({ method: 'POST', url: '/v1/tokenhub/logout', headers, payload: {} }); }

it('allows the same expired/disabled grant to revoke its SID but not access a normal API', async () => {
    const f = setup();
    const result = await logout(f.app);
    expect(result.statusCode).toBe(200); expect(result.json()).toEqual({ revoked: true }); expect(result.headers['cache-control']).toBe('no-store');
    expect(f.transport).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:28084/v1/session/revoke', expect.objectContaining({ body: '{"application":"work"}' }));
    const privateResult = await f.app.inject({ url: '/v1/private', headers });
    expect(privateResult.statusCode).toBe(401); expect(privateResult.body).not.toContain('protected');
    expect(vi.mocked(f.transport).mock.calls[1][0]).toBe('http://127.0.0.1:28084/v1/session/verify');
});

it.each([{}, { authorization: 'Basic signed-happy' }, { authorization: 'Bearer forged-happy' }, { authorization: 'Bearer signed-happy other' }, { authorization: 'Bearer ' + 'x'.repeat(32769) }])('requires its own valid Happy bearer, independent of the bootstrap exemption %j', async badHeaders => {
    const f = setup(); const result = await f.app.inject({ method: 'POST', url: '/v1/tokenhub/logout', payload: {}, headers: badHeaders });
    expect(result.statusCode).toBe(401); expect(result.json()).toEqual({ error: 'Invalid logout credentials' }); expect(f.transport).not.toHaveBeenCalled();
});

it('does not trust duplicate authorization headers', async () => {
    const f = setup(); const result = await f.app.inject({ method: 'POST', url: '/v1/tokenhub/logout', payload: {}, headers: { authorization: ['Bearer signed-happy', 'Bearer other'] as unknown as string } });
    expect(result.statusCode).toBe(401); expect(f.transport).not.toHaveBeenCalled();
});

it.each([{ userId: 'happy-user' }, { userId: 'other', extras: { tokenhub: grant } }, { userId: 'happy-user', extras: { tokenhub: { ...grant, subject: '99' } } }])('rejects legacy or identity-mismatched signed Happy tokens', async happy => {
    const f = setup({ happy }); const result = await logout(f.app);
    expect(result.statusCode).toBe(401); expect(f.transport).not.toHaveBeenCalled();
});
it('requires the existing persistent binding', async () => {
    const f = setup({ binding: null }); expect((await logout(f.app)).statusCode).toBe(401); expect(f.transport).not.toHaveBeenCalled();
});

it.each([{ sid: 'other' }, { sessionId: 'other' }, { subject: '99' }, { user_id: 99 }, { userId: 'other' }, { url: 'https://evil.test' }, { application: 'work' }, { token: workToken }, []])('rejects any client-selected identity, session, token or target %j', async payload => {
    const f = setup(); const result = await f.app.inject({ method: 'POST', url: '/v1/tokenhub/logout', headers, payload });
    expect(result.statusCode).toBe(400); expect(f.verifyHappyToken).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
});
it('rejects query-selected sessions and oversized bodies', async () => {
    const f = setup();
    expect((await f.app.inject({ method: 'POST', url: '/v1/tokenhub/logout?sid=other', headers, payload: {} })).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'POST', url: '/v1/tokenhub/logout', headers, payload: { x: 'x'.repeat(1100) } })).statusCode).toBe(413);
    expect(f.transport).not.toHaveBeenCalled();
});

it.each([401, 403])('returns 401 rather than success for upstream rejection %s', async status => {
    const f = setup({ status }); const result = await logout(f.app);
    expect(result.statusCode).toBe(401); expect(result.json()).toEqual({ error: 'Invalid logout credentials' });
});
it.each([201, 302, 400, 500, 503])('returns sanitized 503 rather than success for upstream status %s', async status => {
    const f = setup({ status }); const result = await logout(f.app);
    expect(result.statusCode).toBe(503); expect(result.json()).toEqual({ error: 'Could not confirm session revocation; try again' });
});
it.each([{}, { revoked: false, application: 'work' }, { revoked: true, application: 'admin' }, { revoked: true, application: 'work', sid: 'private-session' }])('never reports malformed remote acknowledgements as success %j', async response => {
    const f = setup({ result: response }); const result = await logout(f.app);
    expect(result.statusCode).toBe(503); expect(result.body).not.toContain('private-session');
});
it('sanitizes transport errors, never exposing tokens or internal destinations', async () => {
    const f = setup({ transport: vi.fn().mockRejectedValue(new Error(`private stack ${workToken} http://127.0.0.1:28084`)) });
    const result = await logout(f.app);
    expect(result.statusCode).toBe(503); expect(result.json()).toEqual({ error: 'Could not confirm session revocation; try again' });
});
it('has no non-unified logout fallback', async () => {
    const f = setup({ disabled: true }); const result = await logout(f.app);
    expect(result.statusCode).toBe(503); expect(f.verifyHappyToken).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
});
it('does not exempt other methods or neighboring routes from authentication', async () => {
    const f = setup();
    f.app.get('/v1/tokenhub/logout', async () => ({ insecure: true }));
    f.app.post('/v1/tokenhub/logout/all', async () => ({ insecure: true }));
    expect((await f.app.inject('/v1/tokenhub/logout')).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'POST', url: '/v1/tokenhub/logout/all', payload: {} })).statusCode).toBe(401);
});
