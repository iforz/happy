import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { defaultPageConfig } from '@slopus/happy-wire';
import type { Fastify } from '../types';
import { tokenHubNativeRoutes } from './tokenHubNativeRoutes';
import { NativeLoginFlows, nativeRequestBinding } from '@/app/tokenhub/nativeFlow';
import { enableAuthentication } from '../utils/enableAuthentication';

const origin = 'https://accounts.example.test', self = 'https://happy.example.test';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
let app: ReturnType<typeof fastify>, now: number;
beforeEach(() => {
    now = Date.now(); vi.stubEnv('TOKENHUB_URL', origin); vi.stubEnv('HAPPY_PUBLIC_ORIGIN', self); vi.stubEnv('TOKENHUB_SSO_ENABLED', 'true');
    app = fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
});
afterEach(async () => { await app.close(); vi.unstubAllEnvs(); });
function setup(options: { grantActive?: boolean; mismatch?: boolean; sessionActive?: boolean; authorizationEnabled?: boolean } = {}) {
    const keys = generateKeyPairSync('ed25519'), publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
    let nonce = '', challenge = '';
    const bind = vi.fn(async () => { if (options.mismatch) throw new Error('identity_key_mismatch'); return 'happy-account'; });
    const token = vi.fn(async () => 'signed-happy-session');
    const verifyGrant = vi.fn(async () => options.grantActive === false ? null : now + 60000);
    const verifyToken = vi.fn(async (token: string) => options.sessionActive !== false && token === 'signed-happy-session' ? { userId: 'happy-account', expiresAt: now + 60000 } : null);
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input); let data: unknown;
        if (url.endsWith('/metadata')) data = { code: 0, data: { enabled: true, audience: 'happy-web', native_audience: 'happy-native', native_binding_method: 'ip-ua-sha256-128-v1', issuer: 'tokenapi' } };
        else if (url.endsWith('/jwks')) data = { keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig', alg: 'RS256' }] };
        else if (url.endsWith('/exchange')) {
            const request = JSON.parse(String(init?.body));
            expect(request).toMatchObject({ client_id: 'happy-native', native_binding_hash: nativeRequestBinding('127.0.0.1', 'TokenHubWorkNative/1'), native_client_ip: '127.0.0.1', redirect_uri: self + '/tokenhub/callback', code: 'one-time-code' });
            expect(createHash('sha256').update(request.code_verifier).digest('base64url')).toBe(challenge);
            const seconds = Math.floor(Date.now() / 1000);
            data = { code: 0, data: { authorization_token: 'work-grant', id_token: jwt.sign({ iss: 'tokenapi', sub: '42', aud: 'happy-native', nonce,
                jti: randomBytes(32).toString('base64url'), iat: seconds, nbf: seconds, exp: seconds + 60 }, rsa.privateKey, { algorithm: 'RS256', keyid: 'key-1' }) } };
        } else throw new Error('Unexpected external request');
        return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    });
    const authorization = { enabled: options.authorizationEnabled !== false, verifyGrant, verifyToken };
    enableAuthentication(app as unknown as Fastify, authorization);
    tokenHubNativeRoutes(app as unknown as Fastify, { nativeFlows: new NativeLoginFlows(() => now), transport: transport as typeof fetch, bind, token,
        pageConfig: async () => ({ ...defaultPageConfig, showLogin: true, ssoReady: true, loginUrl: origin + '/happy/authorize' }),
        authorization });
    return { publicKey, bind, token, transport, verifyGrant, verifyToken, async start() {
        const response = await app.inject({ method: 'POST', url: '/v1/tokenhub/native/start', headers: { 'user-agent': 'TokenHubWorkNative/1' }, payload: { publicKey } });
        expect(response.statusCode).toBe(200); expect(response.headers['set-cookie']).toBeUndefined();
        const data = response.json(), url = new URL(data.authorizeUrl);
        nonce = url.searchParams.get('nonce')!; challenge = url.searchParams.get('code_challenge')!;
        return { ...data, signature: sign(null, Buffer.from(data.proof), keys.privateKey).toString('base64') };
    } };
}
const complete = (flow: any, patch: Record<string, unknown> = {}) => ({ method: 'POST' as const, url: '/v1/tokenhub/native/complete', headers: { 'user-agent': 'TokenHubWorkNative/1' },
    payload: { state: flow.state, binding: flow.binding, code: 'one-time-code', signature: flow.signature, ...patch } });

it('uses the registered HTTPS/PKCE contract and requires device binding plus the original identity proof', async () => {
    const service = setup(), flow = await service.start();
    const url = new URL(flow.authorizeUrl);
    expect(url.searchParams.get('redirect_uri')).toBe(self + '/tokenhub/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const intercepted = await app.inject(complete(flow, { binding: 'x'.repeat(43) }));
    expect(intercepted.statusCode).toBe(400); expect(service.transport.mock.calls.some(call => String(call[0]).endsWith('/exchange'))).toBe(false);
    const success = await app.inject(complete(flow)); expect(success.statusCode).toBe(200);
    expect(success.json()).toEqual({ token: 'signed-happy-session', expiresAt: now + 60000, refresh: 'reauthenticate' });
    expect(service.bind).toHaveBeenCalledWith(origin, { issuer: 'tokenapi', subject: '42' }, Buffer.from(service.publicKey, 'base64').toString('hex'));
    expect(service.token).toHaveBeenCalledWith('happy-account', { tokenhub: expect.objectContaining({ authorizationToken: 'work-grant', publicKey: Buffer.from(service.publicKey, 'base64').toString('hex') }) });
    expect((await app.inject(complete(flow))).statusCode).toBe(400);
});
it('only bridges a live native transaction to the fixed scheme without exposing authorization material', async () => {
    const service = setup(), flow = await service.start();
    const request = { method: 'POST' as const, url: '/v1/tokenhub/native/handoff', headers: { origin: self }, payload: { state: flow.state, code: 'one-time-code' } };
    const response = await app.inject(request); expect(response.statusCode).toBe(200);
    const target = new URL(response.json().callbackUrl);
    expect(target.origin).toBe('null'); expect(target.protocol + '//' + target.hostname + target.pathname).toBe('happy://tokenhub/callback');
    expect([...target.searchParams.keys()].sort()).toEqual(['code', 'state']); expect(response.body).not.toContain(flow.binding); expect(response.body).not.toContain(flow.proof);
    expect((await app.inject({ ...request, headers: { origin: 'https://attacker.test' } })).statusCode).toBe(403);
    expect((await app.inject({ ...request, payload: { ...request.payload, callbackUrl: 'evil://takeover' } })).statusCode).toBe(400);
    now += 300001; expect((await app.inject(request)).statusCode).toBe(400); expect((await app.inject(complete(flow))).statusCode).toBe(400);
});
it('rejects browser-origin native requests and caller-specified redirects', async () => {
    const service = setup();
    expect((await app.inject({ method: 'POST', url: '/v1/tokenhub/native/start', headers: { origin: self }, payload: { publicKey: service.publicKey } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/tokenhub/native/start', payload: { publicKey: service.publicKey, redirect_uri: 'evil://callback' } })).statusCode).toBe(400);
    const flow = await service.start(); expect((await app.inject({ ...complete(flow), headers: { origin: self } })).statusCode).toBe(403);
    expect((await app.inject(complete(flow))).statusCode).toBe(200);
});
it('rejects a different private key before any Core exchange', async () => {
    const service = setup(), flow = await service.start();
    expect((await app.inject(complete(flow, { signature: Buffer.alloc(64).toString('base64') }))).statusCode).toBe(401);
    expect(service.transport.mock.calls.some(call => String(call[0]).endsWith('/exchange'))).toBe(false); expect(service.bind).not.toHaveBeenCalled();
});
it('consumes cancellation and cannot revive a consumed callback', async () => {
    const service = setup(), flow = await service.start();
    const response = await app.inject({ method: 'POST', url: '/v1/tokenhub/native/complete', headers: { 'user-agent': 'TokenHubWorkNative/1' }, payload: { state: flow.state, binding: flow.binding, error: 'access_denied' } });
    expect(response.statusCode).toBe(400); expect(service.transport.mock.calls.some(call => String(call[0]).endsWith('/exchange'))).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/v1/tokenhub/native/handoff', headers: { origin: self }, payload: { state: flow.state, error: 'access_denied' } })).statusCode).toBe(400);
});
it('fails closed on revoked grants before binding and never offers refresh', async () => {
    const service = setup({ grantActive: false }), flow = await service.start();
    expect((await app.inject(complete(flow))).statusCode).toBe(400); expect(service.bind).not.toHaveBeenCalled(); expect(service.token).not.toHaveBeenCalled();
});
it('returns recovery-required instead of replacing an existing encryption identity', async () => {
    const service = setup({ mismatch: true }), flow = await service.start();
    expect((await app.inject(complete(flow))).statusCode).toBe(409); expect(service.token).not.toHaveBeenCalled();
});
it('checks the existing session without minting a replacement token', async () => {
    const service = setup();
    expect((await app.inject({ method: 'GET', url: '/v1/tokenhub/native/session' })).statusCode).toBe(401);
    const response = await app.inject({ method: 'GET', url: '/v1/tokenhub/native/session', headers: { authorization: 'Bearer signed-happy-session' } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ active: true, expiresAt: now + 60000, refresh: 'reauthenticate' });
    expect(service.token).not.toHaveBeenCalled();
});
it('keeps the native bootstrap exception exact rather than making all future native routes public', async () => {
    setup(); app.post('/v1/tokenhub/native/future', async () => ({ unsafe: true }));
    expect((await app.inject({ method: 'POST', url: '/v1/tokenhub/native/future', payload: {} })).statusCode).toBe(401);
});
it('rejects changed native network context locally before Core exchange or live verification', async () => {
    const service = setup(), flow = await service.start(); service.transport.mockClear();
    expect((await app.inject({ ...complete(flow), remoteAddress: '192.0.2.99' })).statusCode).toBe(412);
    expect(service.transport).not.toHaveBeenCalled(); expect(service.verifyGrant).not.toHaveBeenCalled();
});
it('does not trust forwarded IP/header fields to set the native binding', async () => {
    const service = setup(), flow = await service.start();
    expect(new URL(flow.authorizeUrl).searchParams.get('native_binding_hash')).toBe(nativeRequestBinding('127.0.0.1', 'TokenHubWorkNative/1'));
    expect((await app.inject({ ...complete(flow), headers: { 'user-agent': 'TokenHubWorkNative/1', 'x-client-ip': '192.0.2.99', 'x-forwarded-for': '192.0.2.99' } })).statusCode).toBe(200);
});

it('refuses native login when Work authority validation is disabled instead of issuing an unbounded legacy session', async () => {
    const service = setup({ authorizationEnabled: false });
    expect((await app.inject({ method: 'POST', url: '/v1/tokenhub/native/start', headers: { 'user-agent': 'TokenHubWorkNative/1' }, payload: { publicKey: service.publicKey } })).statusCode).toBe(503);
    expect(service.token).not.toHaveBeenCalled(); expect(service.transport).not.toHaveBeenCalled();
});
