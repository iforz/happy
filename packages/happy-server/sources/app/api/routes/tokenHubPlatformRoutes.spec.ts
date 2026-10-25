import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { defaultPageConfig } from '@slopus/happy-wire';
import type { Fastify } from '../types';
import { enableAuthentication } from '../utils/enableAuthentication';
import type { WorkAuthorization } from '@/app/tokenhub/workAuthorization';
import type { PlatformConversations } from '@/app/tokenhub/platformConversations';
import { PlatformSessionStore } from '@/app/tokenhub/platformSession';
import { tokenHubPlatformRoutes } from './tokenHubPlatformRoutes';

const forbidden = vi.hoisted(() => ({
    bindIdentity: vi.fn(() => { throw new Error('Platform login must not bind a Happy encryption identity'); }),
    createToken: vi.fn(() => { throw new Error('Platform login must not create a Happy token'); }),
    database: vi.fn(() => { throw new Error('Platform login must not access legacy account/session data'); }),
    network: vi.fn(() => { throw new Error('This suite permits only injected synthetic transports'); }),
}));
vi.mock('@/app/tokenhub/binding', () => ({ bindIdentity: forbidden.bindIdentity }));
vi.mock('@/app/auth/auth', () => ({ auth: { createToken: forbidden.createToken } }));
vi.mock('@/storage/db', () => ({ db: new Proxy({}, { get: forbidden.database }) }));
vi.mock('@/utils/log', () => ({ debug: vi.fn() }));

const authority = 'https://accounts.example.test';
const self = 'https://work.example.test';
const authcenter = 'http://127.0.0.1:28084';
const gatewayOrigin = 'http://127.0.0.1:28080';
const grant = 'synthetic-server-only-work-grant';
const coreSid = 'verified-core-work-sid';
const flowCookieName = '__Host-tokenhub-platform-flow';
const channelCookieName = '__Host-tokenhub-platform';
const authCookieName = '__Host-tokenhub-platform-auth';
const prefix = '/v1/tokenhub/platform';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const apps: ReturnType<typeof fastify>[] = [];
const enabledEnv: NodeJS.ProcessEnv = {
    TOKENHUB_PLATFORM_AUTH: 'true', TOKENHUB_UNIFIED_AUTH: 'true', TOKENHUB_SSO_ENABLED: 'true',
    TOKENHUB_GATEWAY_MODE: 'real', TOKENHUB_URL: authority, HAPPY_PUBLIC_ORIGIN: self,
    TOKENHUB_AUTHCENTER_URL: authcenter, TOKENHUB_CORE_GATEWAY_URL: gatewayOrigin,
};
const browserHeaders = { origin: self, 'sec-fetch-site': 'same-origin', 'user-agent': 'synthetic-work-browser' };
const endpoints = [
    { method: 'POST', path: '/start', payload: {} },
    { method: 'POST', path: '/complete', payload: { state: 'a'.repeat(43), code: 'not-used' } },
    { method: 'GET', path: '/session' },
    { method: 'HEAD', path: '/session' },
    { method: 'POST', path: '/logout', payload: {} },
    { method: 'GET', path: '/models' },
    { method: 'HEAD', path: '/models' },
    { method: 'POST', path: '/stream', payload: { model: 'model-a', prompt: 'hello' } },
] as const;

type ResponseLike = { headers: Record<string, unknown>; json(): any; body: string; statusCode: number };
type Flow = { state: string; nonce: string; challenge: string; cookie: string; code: string; response: ResponseLike };
type Options = {
    history?: PlatformConversations;
    env?: NodeJS.ProcessEnv;
    metadata?: Record<string, unknown>;
    claims?: Record<string, unknown>;
    wrongSignature?: boolean;
    hs256?: boolean;
    missingGrant?: boolean;
    core?: Record<string, unknown>;
    coreUnavailable?: boolean;
    page?: Record<string, unknown>;
    maxSessions?: number;
    maxFlows?: number;
};
function setCookies(response: ResponseLike): string[] {
    const value = response.headers['set-cookie'];
    return Array.isArray(value) ? value as string[] : typeof value === 'string' ? [value] : [];
}
function cookie(response: ResponseLike, name: string) {
    const result = setCookies(response).find(value => value.startsWith(name + '='));
    if (!result) throw new Error(`Missing ${name} cookie: ${response.body}`);
    return result.split(';')[0];
}
function jarCookie(jar: string, name: string) {
    return jar.split(';').map(value => value.trim()).find(value => value.startsWith(name + '=')) ?? '';
}
function mergeCookieJar(jar: string, response: ResponseLike) {
    const values = new Map(jar.split(';').map(value => value.trim()).filter(Boolean).map(value => {
        const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)];
    }));
    for (const header of setCookies(response)) {
        const pair = header.split(';')[0], index = pair.indexOf('='), name = pair.slice(0, index), value = pair.slice(index + 1);
        if (/Max-Age=0(?:;|$)/.test(header)) values.delete(name);
        else values.set(name, value);
    }
    return [...values].map(([name, value]) => name + '=' + value).join('; ');
}
function json(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function assertNoCredentials(response: ResponseLike) {
    expect(response.body).not.toContain(grant);
    for (const sid of [coreSid, 'newer-core-work-sid', 'winning-core-work-sid']) expect(response.body).not.toContain(sid);
    for (const name of ['authorizationToken', 'authorization_token', 'authToken', 'authHash', 'authSecret', 'id_token', 'publicKey', 'privateKey', 'code_verifier', 'signature', 'seed']) {
        expect(response.body).not.toContain(`"${name}"`);
    }
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', forbidden.network);
    vi.stubEnv('TOKENHUB_TRUST_LOOPBACK_PROXY', 'false');
});
afterEach(async () => {
    vi.useRealTimers();
    for (const app of apps.splice(0)) await app.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    expect(forbidden.bindIdentity).not.toHaveBeenCalled();
    expect(forbidden.createToken).not.toHaveBeenCalled();
    expect(forbidden.database).not.toHaveBeenCalled();
    expect(forbidden.network).not.toHaveBeenCalled();
});

function setup(options: Options = {}) {
    let now = Date.now();
    const expiresAt = Math.floor(now / 1000) * 1000 + 60_000;
    const env = { ...enabledEnv, ...options.env };
    const flows = new Map<string, Flow>();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const state = { coreUnavailable: options.coreUnavailable ?? false, core: options.core ?? {}, claims: options.claims ?? {}, slowStream: false, deferExchange: false, deferNextVerify: false, deferNextMetadata: false };
    const streamCancelled = vi.fn();
    let streamStartedResolve: (() => void) | undefined;
    const streamStarted = new Promise<void>(resolve => { streamStartedResolve = resolve; });
    let exchangeStartedResolve: (() => void) | undefined, releaseExchangeResolve: (() => void) | undefined;
    const exchangeStarted = new Promise<void>(resolve => { exchangeStartedResolve = resolve; });
    const exchangeRelease = new Promise<void>(resolve => { releaseExchangeResolve = resolve; });
    let verifyStartedResolve: (() => void) | undefined, releaseVerifyResolve: (() => void) | undefined;
    const verifyStarted = new Promise<void>(resolve => { verifyStartedResolve = resolve; });
    const verifyRelease = new Promise<void>(resolve => { releaseVerifyResolve = resolve; });
    let metadataStartedResolve: (() => void) | undefined, releaseMetadataResolve: (() => void) | undefined;
    const metadataStarted = new Promise<void>(resolve => { metadataStartedResolve = resolve; });
    const metadataRelease = new Promise<void>(resolve => { releaseMetadataResolve = resolve; });
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input); calls.push({ url, init });
        expect(init?.redirect).toBe('error');
        expect(init?.credentials).toBe('omit');
        if (url === authority + '/api/v1/auth/happy/metadata') {
            if (state.deferNextMetadata) { state.deferNextMetadata = false; metadataStartedResolve?.(); await metadataRelease; }
            return json({ code: 0, data: { enabled: true, issuer: 'sso-issuer', audience: 'happy-web', jwks_path: 'https://attacker.test/keys', ...options.metadata } });
        }
        if (url === authority + '/api/v1/auth/sso/jwks') {
            return json({ keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: 'platform-test', alg: 'RS256', use: 'sig' }] });
        }
        if (url === authority + '/api/v1/auth/happy/exchange') {
            const body = JSON.parse(String(init?.body));
            const flow = flows.get(body.code);
            expect(flow).toBeDefined();
            expect(Object.keys(body).sort()).toEqual(['client_id', 'code', 'code_verifier', 'redirect_uri']);
            expect(body.client_id).toBe('happy-web');
            expect(body.redirect_uri).toBe(self + '/tokenhub/callback');
            expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(flow!.challenge);
            expect(body.code_verifier).not.toBe(flow!.state);
            expect(body.code_verifier).not.toBe(flow!.nonce);
            if (state.deferExchange) { exchangeStartedResolve?.(); await exchangeRelease; }
            const seconds = Math.floor(now / 1000);
            const claims = { iss: 'sso-issuer', sub: '42', aud: 'happy-web', nonce: flow!.nonce, jti: randomBytes(32).toString('base64url'), iat: seconds, nbf: seconds, exp: seconds + 60, ...state.claims };
            const assertion = options.hs256
                ? jwt.sign(claims, 'synthetic-wrong-algorithm', { algorithm: 'HS256', keyid: 'platform-test' })
                : jwt.sign(claims, options.wrongSignature ? otherKey.privateKey : key.privateKey, { algorithm: 'RS256', keyid: 'platform-test' });
            return json({ code: 0, data: { id_token: assertion, ...(!options.missingGrant ? { authorization_token: grant } : {}) } });
        }
        if (url === authcenter + '/v1/session/verify') {
            expect(init?.method).toBe('POST');
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${grant}`);
            expect(JSON.parse(String(init?.body))).toEqual({ application: 'work' });
            const unavailable = state.coreUnavailable;
            const result = { active: true, application: 'work', issuer: 'tokenapi', subject: '42', session_id: coreSid, expires_at: expiresAt / 1000, permissions: ['work:access'], ...state.core };
            if (state.deferNextVerify) { state.deferNextVerify = false; verifyStartedResolve?.(); await verifyRelease; }
            if (unavailable) return json({ error: 'synthetic authority outage' }, 503);
            return json(result);
        }
        if (url === authcenter + '/v1/session/revoke') {
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${grant}`);
            expect(JSON.parse(String(init?.body))).toEqual({ application: 'work' });
            return json({ revoked: true, application: 'work' });
        }
        if (url === gatewayOrigin + '/api/v1/work/models') {
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${grant}`);
            return json({ data: [{ id: 'model-a', apiKey: 'provider-secret', subject: 'internal-subject' }, { id: 'model-b' }, { id: 'default' }] });
        }
        if (url === gatewayOrigin + '/api/v1/work/chat/completions') {
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${grant}`);
            if (!state.slowStream) return new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'synthetic-core-request' } });
            return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
                    streamStartedResolve?.();
                },
                cancel: streamCancelled,
            }), { headers: { 'content-type': 'text/event-stream' } });
        }
        throw new Error('Unexpected synthetic destination: ' + url);
    });
    const legacyVerify = vi.fn(async (token: string) => token === 'signed-legacy-token' ? { userId: 'legacy-account' } : null);
    const legacyAuthorization: WorkAuthorization = { enabled: true, verifyToken: legacyVerify, verifyGrant: vi.fn(async () => null) };
    const app = fastify(); apps.push(app);
    app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    enableAuthentication(app as unknown as Fastify, legacyAuthorization);
    const pageConfig = vi.fn(async () => ({ ...defaultPageConfig, showLogin: true, ssoReady: true, loginUrl: authority + '/happy/authorize', ...options.page }));
    tokenHubPlatformRoutes(app as unknown as Fastify, {
        env, transport: transport as typeof fetch, pageConfig, now: () => now, history: options.history,
        ...(options.maxSessions !== undefined ? { maxSessions: options.maxSessions } : {}),
        ...(options.maxFlows !== undefined ? { maxFlows: options.maxFlows } : {}),
    });
    const legacyHandler = vi.fn(async () => ({ legacy: true }));
    for (const path of ['/v1/sessions', '/v1/account', '/v1/machines', prefix + '/future']) app.get(path, legacyHandler);
    app.put(prefix + '/session', legacyHandler);
    const start = async (headers: Record<string, string> = {}) => {
        const response = await app.inject({ method: 'POST', url: prefix + '/start', headers: { ...browserHeaders, ...headers }, payload: {} });
        expect(response.statusCode, response.body).toBe(200);
        const data = response.json(); const url = new URL(data.authorizeUrl);
        const jar = mergeCookieJar(headers.cookie ?? '', response);
        const channel = jarCookie(jar, channelCookieName);
        if (!channel) throw new Error('Start must issue or retain a server-known browser channel');
        const flow: Flow = { state: data.state, nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')!, cookie: jar, code: 'synthetic-code-' + flows.size, response };
        flows.set(flow.code, flow); return flow;
    };
    const complete = async (flow: Flow, headers: Record<string, string> = {}) => {
        const response = await app.inject({ method: 'POST', url: prefix + '/complete', headers: { ...browserHeaders, cookie: flow.cookie, ...headers }, payload: { state: flow.state, code: flow.code } });
        if (response.statusCode === 200) {
            expect(setCookies(response)).toHaveLength(1);
            expect(cookie(response, authCookieName)).toMatch(/^__Host-tokenhub-platform-auth=[A-Za-z0-9_-]{43}$/);
            expect(response.body).not.toContain(cookie(response, authCookieName).split('=')[1]);
        } else expect(response.headers['set-cookie']).toBeUndefined();
        expect(setCookies(response).some(header => header.startsWith(channelCookieName + '='))).toBe(false);
        assertNoCredentials(response);
        return response;
    };
    const login = async (headers: Record<string, string> = {}) => {
        const flow = await start(headers); const response = await complete(flow);
        expect(response.statusCode, response.body).toBe(200);
        return { flow, response, session: response.json(), cookie: mergeCookieJar(flow.cookie, response) };
    };
    return { app, calls, state, transport, legacyVerify, legacyHandler, pageConfig, start, complete, login, expiresAt, streamStarted, streamCancelled, exchangeStarted, releaseExchange: () => releaseExchangeResolve?.(), verifyStarted, releaseVerify: () => releaseVerifyResolve?.(), metadataStarted, releaseMetadata: () => releaseMetadataResolve?.(), advance: (ms: number) => { now += ms; } };
}

describe('independent TokenHub platform login', () => {
    it('uses independent opaque state, nonce, PKCE and browser binding without a Happy key or signature', async () => {
        const f = setup(); const flow = await f.start(); const startData = flow.response.json(); const url = new URL(startData.authorizeUrl);
        expect(Object.keys(startData).sort()).toEqual(['authorizeUrl', 'state', 'tokenHubOrigin']);
        expect(url.origin).toBe(authority); expect(url.pathname).toBe('/happy/authorize');
        expect(url.searchParams.get('redirect_uri')).toBe(self + '/tokenhub/callback');
        expect(url.searchParams.get('client_id')).toBe('happy-web'); expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('state')).toBe(flow.state); expect(startData.tokenHubOrigin).toBe(authority);
        const binding = flow.cookie.split('=')[1];
        for (const opaque of [flow.state, flow.nonce, flow.challenge, binding]) expect(opaque).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
        expect(new Set([flow.state, flow.nonce, flow.challenge, binding]).size).toBe(4);
        const response = await f.complete(flow); expect(response.statusCode, response.body).toBe(200);
        expect(Object.keys(response.json()).sort()).toEqual(['authority', 'csrf', 'expiresAt', 'issuer', 'sessionId', 'subject']);
        expect(response.json()).toEqual({ authority, issuer: 'tokenapi', subject: '42', sessionId: expect.stringMatching(/^[a-f0-9]{64}$/), expiresAt: f.expiresAt, csrf: expect.stringMatching(/^[A-Za-z0-9_-]{43,128}$/) });
        expect(response.headers['cache-control']).toBe('no-store'); assertNoCredentials(response);
        expect(f.legacyVerify).not.toHaveBeenCalled();
        expect(f.calls.map(call => call.url)).toEqual(expect.arrayContaining([authority + '/api/v1/auth/sso/jwks', authcenter + '/v1/session/verify']));
        expect(f.calls.some(call => call.url.includes('attacker.test'))).toBe(false);
    });

    it('sets a bounded preauth channel at start and only a separate secure HttpOnly auth secret on successful completion', async () => {
        const f = setup(); const logged = await f.login();
        for (const response of [logged.flow.response, logged.response]) {
            for (const header of setCookies(response)) {
                expect(header).toContain('Path=/'); expect(header).toContain('HttpOnly'); expect(header).toContain('Secure'); expect(header).toContain('SameSite=Lax'); expect(header).not.toMatch(/Domain=/i);
                expect(header).not.toContain('__Host-happy-tokenhub');
                expect(header).not.toContain(flowCookieName);
            }
        }
        expect(setCookies(logged.response)).toHaveLength(1);
        expect(cookie(logged.response, authCookieName)).toBe(jarCookie(logged.cookie, authCookieName));
        expect(setCookies(logged.flow.response)).toHaveLength(1);
        const channelHeader = setCookies(logged.flow.response).find(value => value.startsWith(channelCookieName + '='))!;
        expect(Number(channelHeader.match(/Max-Age=(\d+)/)?.[1])).toBeGreaterThan(0);
        expect(Number(channelHeader.match(/Max-Age=(\d+)/)?.[1])).toBeLessThanOrEqual(24 * 60 * 60);
        const authHeader = setCookies(logged.response)[0]; expect(Number(authHeader.match(/Max-Age=(\d+)/)?.[1])).toBeLessThanOrEqual(60);
        const opaque = jarCookie(logged.cookie, channelCookieName).split('=')[1]; expect(opaque).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
        const authSecret = jarCookie(logged.cookie, authCookieName).split('=')[1]; expect(authSecret).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(authSecret).not.toBe(opaque); expect(authSecret).not.toBe(logged.session.csrf);
        expect(opaque).not.toBe(coreSid); expect(opaque).not.toBe(grant); expect(opaque).not.toBe(logged.session.csrf);
    });

    it.each([undefined, 'null', 'https://attacker.test', self + '.attacker.test', self + '/', 'http://work.example.test'])('requires the exact configured Origin for login start (%s)', async origin => {
        const f = setup(); const response = await f.app.inject({ method: 'POST', url: prefix + '/start', headers: origin === undefined ? {} : { origin }, payload: {} });
        expect(response.statusCode).toBe(403); expect(f.transport).not.toHaveBeenCalled();
    });

    it.each([{ publicKey: 'unwanted-key' }, { signature: 'unwanted-proof' }, { redirect_uri: 'https://attacker.test' }, { client_id: 'happy-native' }, { channelId: 'attacker-chosen-channel' }])('rejects client-supplied login authority or Happy key fields %j', async payload => {
        const f = setup(); const response = await f.app.inject({ method: 'POST', url: prefix + '/start', headers: browserHeaders, payload });
        expect(response.statusCode).toBe(400); expect(f.transport).not.toHaveBeenCalled();
    });

    it('rejects missing/wrong state binding, rejects a foreign callback origin, and consumes successful state once', async () => {
        const f = setup(); const flow = await f.start(); const before = f.calls.length;
        const request = { method: 'POST' as const, url: prefix + '/complete', headers: { ...browserHeaders, cookie: flow.cookie }, payload: { state: flow.state, code: flow.code } };
        for (const headers of [{ ...browserHeaders }, { ...browserHeaders, cookie: channelCookieName + '=' + 'b'.repeat(43) }, { ...browserHeaders, origin: 'https://attacker.test', cookie: flow.cookie }]) {
            const rejected = await f.app.inject({ ...request, headers }); expect([400, 403]).toContain(rejected.statusCode); expect(f.calls).toHaveLength(before);
        }
        const badState = await f.app.inject({ ...request, payload: { ...request.payload, state: 'x'.repeat(43) } }); expect(badState.statusCode).toBe(400);
        const success = await f.app.inject(request); expect(success.statusCode, success.body).toBe(200);
        const count = f.transport.mock.calls.length;
        expect((await f.app.inject(request)).statusCode).toBe(400); expect(f.transport).toHaveBeenCalledTimes(count);
    });

    it('does not invalidate a newer transaction when an old callback arrives with the newer cookie', async () => {
        const f = setup(); const old = await f.start(); const current = await f.start();
        const stale = await f.complete(old, { cookie: current.cookie }); expect(stale.statusCode).toBe(400); expect(stale.headers['set-cookie']).toBeUndefined();
        expect((await f.complete(current)).statusCode).toBe(200);
    });

    it('cancels and consumes the browser-bound flow without exchanging a code', async () => {
        const f = setup(); const flow = await f.start(); const before = f.calls.length;
        const cancelled = await f.app.inject({ method: 'POST', url: prefix + '/complete', headers: { ...browserHeaders, cookie: flow.cookie }, payload: { state: flow.state, error: 'access_denied' } });
        expect(cancelled.statusCode).toBe(400); expect(f.calls).toHaveLength(before);
        expect((await f.complete(flow)).statusCode).toBe(400);
    });

    it('expires a login transaction after five minutes without exchanging its code', async () => {
        const f = setup(); const flow = await f.start(); const before = f.calls.length; f.advance(300_001);
        expect((await f.complete(flow)).statusCode).toBe(400); expect(f.calls).toHaveLength(before);
    });

    it.each<Options>([
        { claims: { aud: 'happy-native' } }, { claims: { aud: ['happy-web', 'attacker'] } },
        { claims: { iss: 'attacker' } }, { claims: { sub: 'not-a-core-subject' } },
        { claims: { nonce: 'wrong-browser-transaction' } }, { claims: { jti: 'short' } },
        { claims: { exp: 1 } }, { claims: { nbf: Math.floor(Date.now() / 1000) + 1000 } },
        { wrongSignature: true }, { hs256: true }, { missingGrant: true },
    ])('fails closed on invalid assertions or metadata %j', async options => {
        const f = setup(options); const flow = await f.start(); const response = await f.complete(flow);
        expect([400, 401, 403, 503]).toContain(response.statusCode); assertNoCredentials(response);
        expect(setCookies(response).some(value => value.startsWith(channelCookieName + '=') && !value.includes('Max-Age=0'))).toBe(false);
        expect(f.calls.filter(call => call.url.startsWith(gatewayOrigin))).toHaveLength(0);
    });

    it.each([{ enabled: false }, { audience: 'attacker' }, { issuer: '' }])('does not start login with invalid SSO metadata %j', async metadata => {
        const f = setup({ metadata }); const response = await f.app.inject({ method: 'POST', url: prefix + '/start', headers: browserHeaders, payload: {} });
        expect(response.statusCode).toBe(503); expect(response.json()).toMatchObject({ platform: true, enabled: true });
        expect(response.headers['set-cookie']).toBeUndefined();
    });

    it.each([
        { active: false }, { application: 'other' }, { issuer: 'attacker' }, { subject: '99' },
        { session_id: '' }, { expires_at: 1 }, { expires_at: Number.MAX_SAFE_INTEGER },
        { permissions: [] }, { permissions: ['work:admin'] },
    ])('refuses a Core grant without valid active Work authority %j', async core => {
        const f = setup({ core }); const flow = await f.start(); const response = await f.complete(flow);
        expect([400, 401, 403]).toContain(response.statusCode); assertNoCredentials(response);
        expect(setCookies(response).some(value => value.startsWith(channelCookieName + '=') && !value.includes('Max-Age=0'))).toBe(false);
    });
});

describe('platform session authorization and legacy isolation', () => {
    it('never authenticates a later login when a separate client replays the entire pre-logout cookie jar', async () => {
        const f = setup(); const first = await f.login(); const copiedJar = first.cookie;
        expect((await f.app.inject({ method: 'POST', url: prefix + '/logout', headers: { ...browserHeaders, cookie: first.cookie, 'x-tokenhub-csrf': first.session.csrf }, payload: {} })).statusCode).toBe(200);
        const second = await f.login({ cookie: first.cookie });
        expect(jarCookie(second.cookie, channelCookieName)).toBe(jarCookie(copiedJar, channelCookieName));
        expect(jarCookie(second.cookie, authCookieName)).not.toBe(jarCookie(copiedJar, authCookieName));
        const beforeReplay = f.calls.length;
        for (const endpoint of endpoints.filter(endpoint => !['/start', '/complete'].includes(endpoint.path))) {
            const replay = await f.app.inject({ method: endpoint.method, url: prefix + endpoint.path, headers: { ...browserHeaders, cookie: copiedJar, 'x-tokenhub-csrf': second.session.csrf }, ...('payload' in endpoint ? { payload: endpoint.payload } : {}) });
            expect(replay.statusCode, endpoint.path + ': ' + replay.body).toBe(401); expect(replay.body).not.toContain(second.session.csrf); expect(replay.body).not.toContain(second.session.sessionId);
        }
        expect(f.calls).toHaveLength(beforeReplay);
        expect((await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: second.cookie } })).statusCode).toBe(200);
    });

    it('requires the matching current auth secret and channel together before any live authorization call', async () => {
        const f = setup(); const previous = await f.login(); const first = await f.login({ cookie: previous.cookie }); const second = await f.login();
        const channelA = jarCookie(first.cookie, channelCookieName), authA = jarCookie(first.cookie, authCookieName);
        const channelB = jarCookie(second.cookie, channelCookieName), authB = jarCookie(second.cookie, authCookieName);
        const staleAuthA = jarCookie(previous.cookie, authCookieName);
        const before = f.calls.length;
        const invalidJars = [channelA, authA, channelA + '; ' + authB, channelB + '; ' + authA, channelA + '; ' + authCookieName + '=' + 'x'.repeat(43), channelA + '; ' + authA + '; ' + authA, channelA + '; ' + authA + '; ' + staleAuthA, channelA + '; ' + staleAuthA + '; ' + authA];
        for (const jar of invalidJars) {
            for (const path of ['/session', '/models', '/stream', '/logout']) {
                const response = await f.app.inject({ method: ['/session', '/models'].includes(path) ? 'GET' : 'POST', url: prefix + path, headers: { ...browserHeaders, cookie: jar, 'x-tokenhub-csrf': first.session.csrf }, ...(['/session', '/models'].includes(path) ? {} : { payload: path === '/stream' ? { model: 'model-a', prompt: 'hello' } : {} }) });
                expect(response.statusCode, path + ': ' + response.body).toBe(401); expect(response.body).not.toContain(first.session.csrf); expect(response.body).not.toContain(second.session.csrf);
            }
        }
        expect(f.calls).toHaveLength(before);
        for (const logged of [first, second]) {
            const valid = await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: logged.cookie } }); expect(valid.statusCode).toBe(200); expect(valid.json()).toEqual(logged.session);
        }
    });

    it('stores only a hash of the rotated auth secret in the server record and never exposes it in JSON or Core requests', async () => {
        const completed = vi.spyOn(PlatformSessionStore.prototype, 'complete');
        try {
            const f = setup(); const logged = await f.login(); const authSecret = jarCookie(logged.cookie, authCookieName).split('=')[1];
            const result = completed.mock.results[0].value as ReturnType<PlatformSessionStore['complete']>;
            expect(result.record.authHash).toBe(createHash('sha256').update(authSecret).digest('base64url'));
            expect(JSON.stringify(result.record)).not.toContain(authSecret); expect(result.record).not.toHaveProperty('authToken');
            expect(authSecret).not.toBe(jarCookie(logged.cookie, channelCookieName).split('=')[1]); expect(authSecret).not.toBe(logged.session.csrf); expect(authSecret).not.toBe(logged.session.sessionId);
            const response = await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: logged.cookie } }); expect(response.statusCode).toBe(200); assertNoCredentials(response); expect(response.body).not.toContain(authSecret); expect(response.body).not.toContain(result.record.authHash);
            for (const call of f.calls) {
                expect(String(call.init?.body)).not.toContain(authSecret);
                new Headers(call.init?.headers).forEach(value => expect(value).not.toContain(authSecret));
            }
        } finally { completed.mockRestore(); }
    });

    it.each([
        { TOKENHUB_PLATFORM_AUTH: undefined }, { TOKENHUB_PLATFORM_AUTH: 'false' }, { TOKENHUB_UNIFIED_AUTH: 'false' },
        { TOKENHUB_SSO_ENABLED: 'false' }, { TOKENHUB_GATEWAY_MODE: 'mock' }, { TOKENHUB_URL: 'http://accounts.example.test' },
        { HAPPY_PUBLIC_ORIGIN: 'http://work.example.test' }, { HAPPY_PUBLIC_ORIGIN: self + '/path' },
        { TOKENHUB_AUTHCENTER_URL: 'http://localhost:28084' }, { TOKENHUB_AUTHCENTER_URL: 'https://attacker.test' },
        { TOKENHUB_CORE_GATEWAY_URL: 'http://127.0.0.1:28080/path' }, { TOKENHUB_CORE_GATEWAY_URL: 'http://attacker.test:28080' },
    ])('registers all routes but returns disabled 503 for an unsafe/incomplete gate %j', async env => {
        const f = setup({ env });
        for (const endpoint of endpoints) {
            const response = await f.app.inject({ method: endpoint.method, url: prefix + endpoint.path, headers: browserHeaders, ...('payload' in endpoint ? { payload: endpoint.payload } : {}) });
            expect(response.statusCode, endpoint.method + ' ' + endpoint.path + ': ' + response.body).toBe(503);
            if (endpoint.method !== 'HEAD') expect(response.json()).toMatchObject({ platform: true, enabled: false });
        }
        expect(f.transport).not.toHaveBeenCalled(); expect(f.legacyVerify).not.toHaveBeenCalled();
    });

    it('returns enabled unauthenticated 401 rather than disabled 503 for protected routes', async () => {
        const f = setup();
        for (const endpoint of endpoints.filter(endpoint => !['/start', '/complete'].includes(endpoint.path))) {
            const response = await f.app.inject({ method: endpoint.method, url: prefix + endpoint.path, headers: browserHeaders, ...('payload' in endpoint ? { payload: endpoint.payload } : {}) });
            expect(response.statusCode, response.body).toBe(401);
            if (endpoint.method !== 'HEAD') expect(response.json()).toMatchObject({ platform: true, enabled: true });
        }
        expect(f.transport).not.toHaveBeenCalled(); expect(f.legacyVerify).not.toHaveBeenCalled();
    });

    it('revalidates the grant for each session request and exposes only the public session projection', async () => {
        const f = setup(); const logged = await f.login(); const before = f.calls.filter(call => call.url.endsWith('/verify')).length;
        for (let i = 0; i < 2; i++) {
            const response = await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: logged.cookie } });
            expect(response.statusCode, response.body).toBe(200); expect(response.json()).toEqual(logged.session); assertNoCredentials(response);
        }
        expect(f.calls.filter(call => call.url.endsWith('/verify'))).toHaveLength(before + 2);
        expect(f.legacyVerify).not.toHaveBeenCalled();
    });

    it.each(['session', 'models'])('rejects cross-site reads before live authority or gateway calls: %s', async path => {
        const f = setup(); const logged = await f.login(); const before = f.calls.length;
        for (const headers of [
            { origin: 'https://attacker.test', 'sec-fetch-site': 'cross-site' },
            { origin: self, 'sec-fetch-site': 'cross-site' },
            { origin: 'https://attacker.test', 'sec-fetch-site': 'same-origin' },
        ]) {
            const response = await f.app.inject({ url: prefix + '/' + path, headers: { ...headers, cookie: logged.cookie, 'x-tokenhub-csrf': logged.session.csrf } });
            expect(response.statusCode).toBe(403);
        }
        expect(f.calls).toHaveLength(before);
    });

    it.each(['models', 'stream', 'logout'])('requires session-bound CSRF before Core or gateway access: %s', async path => {
        const f = setup(); const logged = await f.login(); const before = f.calls.length;
        for (const csrf of [undefined, '', 'not-the-session-csrf']) {
            const response = await f.app.inject({ method: path === 'models' ? 'GET' : 'POST', url: prefix + '/' + path, headers: { ...browserHeaders, cookie: logged.cookie, ...(csrf === undefined ? {} : { 'x-tokenhub-csrf': csrf }) }, ...(path === 'models' ? {} : { payload: path === 'stream' ? { model: 'model-a', prompt: 'hello' } : {} }) });
            expect(response.statusCode, response.body).toBe(403);
        }
        expect(f.calls).toHaveLength(before);
    });

    it.each(['stream', 'logout'])('rejects foreign or absent Origin on authenticated writes: %s', async path => {
        const f = setup(); const logged = await f.login(); const before = f.calls.length;
        for (const origin of [undefined, 'https://attacker.test']) {
            const response = await f.app.inject({ method: 'POST', url: prefix + '/' + path, headers: { cookie: logged.cookie, 'x-tokenhub-csrf': logged.session.csrf, ...(origin ? { origin } : {}) }, payload: path === 'stream' ? { model: 'model-a', prompt: 'hello' } : {} });
            expect(response.statusCode).toBe(403);
        }
        expect(f.calls).toHaveLength(before);
    });

    it.each([{ active: false }, { subject: '99' }, { session_id: 'replaced-core-session' }, { permissions: [] }, { expires_at: 1 }])('fails closed when live Core authorization changes %j', async core => {
        const f = setup(); const logged = await f.login(); f.state.core = core;
        const response = await f.app.inject({ url: prefix + '/models', headers: { ...browserHeaders, cookie: logged.cookie, 'x-tokenhub-csrf': logged.session.csrf } });
        expect(response.statusCode).toBe(401); expect(response.headers['set-cookie']).toBeUndefined(); expect(f.calls.filter(call => call.url.startsWith(gatewayOrigin))).toHaveLength(0); assertNoCredentials(response);
    });

    it('distinguishes authority unavailability from missing login, without stale authorization or catalog access', async () => {
        const f = setup(); const logged = await f.login(); f.state.coreUnavailable = true;
        const response = await f.app.inject({ url: prefix + '/models', headers: { ...browserHeaders, cookie: logged.cookie, 'x-tokenhub-csrf': logged.session.csrf } });
        expect(response.statusCode).toBe(503); expect(response.json()).toMatchObject({ platform: true, enabled: true });
        expect(f.calls.filter(call => call.url.startsWith(gatewayOrigin))).toHaveLength(0); assertNoCredentials(response);
    });

    it('does not extend the browser session past the original Core expiry', async () => {
        const f = setup(); const logged = await f.login(); f.state.core = { expires_at: f.expiresAt / 1000 + 3600 }; f.advance(61_000);
        const response = await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: logged.cookie } }); expect(response.statusCode).toBe(401);
    });

    it('cannot authorize legacy APIs with platform cookies or their opaque IDs and does not exempt future platform routes', async () => {
        const f = setup(); const logged = await f.login();
        for (const path of ['/v1/sessions', '/v1/account', '/v1/machines', prefix + '/future']) {
            for (const authorization of [undefined, 'Bearer ' + jarCookie(logged.cookie, channelCookieName).split('=')[1], 'Bearer ' + jarCookie(logged.cookie, authCookieName).split('=')[1], 'Bearer ' + grant]) {
                const response = await f.app.inject({ url: path, headers: { ...browserHeaders, cookie: logged.cookie, ...(authorization ? { authorization } : {}) } }); expect(response.statusCode).toBe(401);
            }
        }
        expect((await f.app.inject({ method: 'PUT', url: prefix + '/session', headers: { ...browserHeaders, cookie: logged.cookie }, payload: {} })).statusCode).toBe(401);
        expect(f.legacyHandler).not.toHaveBeenCalled();
        const legacy = await f.app.inject({ url: '/v1/sessions', headers: { authorization: 'Bearer signed-legacy-token' } });
        expect(legacy.statusCode).toBe(200); expect(f.legacyHandler).toHaveBeenCalledOnce();
    });

    it('does not accept a legacy Happy bearer token in place of a platform session cookie', async () => {
        const f = setup(); const response = await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, authorization: 'Bearer signed-legacy-token' } });
        expect(response.statusCode).toBe(401); expect(f.legacyVerify).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
    });

    it('rejects ambiguous duplicate platform cookies instead of selecting one', async () => {
        const f = setup(); const logged = await f.login(); const before = f.calls.length;
        for (const cookies of [logged.cookie + '; ' + logged.cookie, logged.cookie + '; ' + channelCookieName + '=' + 'z'.repeat(43)]) {
            const response = await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: cookies } }); expect(response.statusCode).toBe(401);
        }
        expect(f.calls).toHaveLength(before);
        const flow = await f.start(); const beforeComplete = f.calls.length;
        const response = await f.complete(flow, { cookie: flow.cookie + '; ' + flow.cookie }); expect(response.statusCode).toBe(400); expect(f.calls).toHaveLength(beforeComplete);
    });

    it('binds CSRF to its particular platform session rather than accepting another browser session CSRF', async () => {
        const f = setup(); const first = await f.login(); const second = await f.login(); const before = f.calls.length;
        const response = await f.app.inject({ url: prefix + '/models', headers: { ...browserHeaders, cookie: first.cookie, 'x-tokenhub-csrf': second.session.csrf } });
        expect(response.statusCode).toBe(403); expect(first.session.csrf).not.toBe(second.session.csrf); expect(f.calls).toHaveLength(before);
    });

    it('logs out locally despite an authority outage, invalidates the copied cookie, and never revokes the shared Core family', async () => {
        const f = setup(); const logged = await f.login(); const before = f.calls.length; f.state.coreUnavailable = true;
        const response = await f.app.inject({ method: 'POST', url: prefix + '/logout', headers: { ...browserHeaders, cookie: logged.cookie + '; __Host-happy-tokenhub=legacy-flow', 'x-tokenhub-csrf': logged.session.csrf }, payload: {} });
        expect(response.statusCode, response.body).toBe(200); expect(response.json()).toEqual({ loggedOut: true, scope: 'work', coreSessionRevoked: false });
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(f.calls).toHaveLength(before); expect(f.calls.some(call => call.url.endsWith('/revoke'))).toBe(false);
        for (const path of ['/session', '/models']) {
            const replay = await f.app.inject({ url: prefix + path, headers: { ...browserHeaders, cookie: logged.cookie, 'x-tokenhub-csrf': logged.session.csrf } }); expect(replay.statusCode).toBe(401);
        }
        expect(f.calls).toHaveLength(before);
        expect((await f.app.inject({ url: '/v1/sessions', headers: { authorization: 'Bearer signed-legacy-token' } })).statusCode).toBe(200);
    });

    it('does not log out a separate platform browser session', async () => {
        const f = setup(); const first = await f.login(); const second = await f.login();
        expect((await f.app.inject({ method: 'POST', url: prefix + '/logout', headers: { ...browserHeaders, cookie: first.cookie, 'x-tokenhub-csrf': first.session.csrf }, payload: {} })).statusCode).toBe(200);
        const surviving = await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: second.cookie } }); expect(surviving.statusCode).toBe(200); expect(surviving.json()).toEqual(second.session);
    });

    it('cannot clear a newer login cookie when an earlier logout response arrives late', async () => {
        const f = setup(); const first = await f.login();
        const delayedLogout = await f.app.inject({ method: 'POST', url: prefix + '/logout', headers: { ...browserHeaders, cookie: first.cookie, 'x-tokenhub-csrf': first.session.csrf }, payload: {} });
        expect(delayedLogout.statusCode).toBe(200);
        const nextFlow = await f.start({ cookie: first.cookie });
        const newerLogin = await f.complete(nextFlow); expect(newerLogin.statusCode).toBe(200);
        const newerCookie = mergeCookieJar(nextFlow.cookie, newerLogin), newerSession = newerLogin.json(); expect(jarCookie(newerCookie, channelCookieName)).toBe(jarCookie(first.cookie, channelCookieName));
        // Deliver A's already-generated logout response only after B's login cookies.
        const currentCookie = mergeCookieJar(newerCookie, delayedLogout);
        expect(delayedLogout.headers['set-cookie']).toBeUndefined();
        expect(currentCookie).toBe(newerCookie);
        const session = await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: currentCookie } }); expect(session.statusCode).toBe(200); expect(session.json()).toEqual(newerSession);
        const models = await f.app.inject({ url: prefix + '/models', headers: { ...browserHeaders, cookie: currentCookie, 'x-tokenhub-csrf': newerSession.csrf } }); expect(models.statusCode).toBe(200);
        expect((await f.app.inject({ url: prefix + '/models', headers: { ...browserHeaders, cookie: first.cookie, 'x-tokenhub-csrf': first.session.csrf } })).statusCode).toBe(401);
    });

    it('retains the browser channel but rotates public record ID and CSRF even when relogin has the same Core SID', async () => {
        const f = setup(); const first = await f.login(); const replacement = await f.start({ cookie: first.cookie });
        expect(replacement.cookie).toBe(first.cookie); expect(replacement.response.headers['set-cookie']).toBeUndefined();
        const response = await f.complete(replacement); expect(response.statusCode).toBe(200); expect(response.json().csrf).not.toBe(first.session.csrf);
        expect(response.json().sessionId).toMatch(/^[a-f0-9]{64}$/); expect(response.json().sessionId).not.toBe(first.session.sessionId); expect(response.json().sessionId).not.toBe(coreSid);
        const newerJar = mergeCookieJar(replacement.cookie, response); expect(jarCookie(newerJar, authCookieName)).not.toBe(jarCookie(first.cookie, authCookieName));
        expect((await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: first.cookie } })).statusCode).toBe(401);
        expect((await f.app.inject({ url: prefix + '/models', headers: { ...browserHeaders, cookie: newerJar, 'x-tokenhub-csrf': first.session.csrf } })).statusCode).toBe(403);
        const current = await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: newerJar } }); expect(current.statusCode).toBe(200); expect(current.json()).toEqual(response.json());
    });

    it('does not resurrect a platform session when a pending login finishes after browser logout', async () => {
        const f = setup(); const logged = await f.login(); const flow = await f.start({ cookie: logged.cookie });
        f.state.deferExchange = true;
        const browserCookie = flow.cookie; expect(browserCookie).toBe(logged.cookie);
        const pending = f.complete(flow, { cookie: browserCookie }).then(response => response);
        await f.exchangeStarted;
        const logout = await f.app.inject({ method: 'POST', url: prefix + '/logout', headers: { ...browserHeaders, cookie: browserCookie, 'x-tokenhub-csrf': logged.session.csrf }, payload: {} });
        expect(logout.statusCode).toBe(200); f.releaseExchange(); const response = await pending;
        expect([400, 401]).toContain(response.statusCode);
        expect(setCookies(response).some(value => value.startsWith(channelCookieName + '=') && !value.includes('Max-Age=0'))).toBe(false);
        expect((await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: logged.cookie } })).statusCode).toBe(401);
        expect(f.calls.some(call => call.url.endsWith('/revoke'))).toBe(false);
    });

    it('does not let an earlier in-flight completion replace a newer browser login transaction', async () => {
        const f = setup(); const old = await f.start(); f.state.deferExchange = true;
        const pending = f.complete(old).then(response => response); await f.exchangeStarted;
        const current = await f.start({ cookie: old.cookie }); f.releaseExchange(); const obsolete = await pending;
        expect([400, 401]).toContain(obsolete.statusCode);
        expect(setCookies(obsolete).some(value => value.startsWith(channelCookieName + '=') && !value.includes('Max-Age=0'))).toBe(false);
        expect(setCookies(obsolete).some(value => value.startsWith(flowCookieName + '=') && value.includes('Max-Age=0'))).toBe(false);
        const good = await f.complete(current); expect(good.statusCode, good.body).toBe(200);
        expect((await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: mergeCookieJar(current.cookie, good) } })).statusCode).toBe(200);
    });

    it('fails closed rather than reviving an old principal when its delayed success auth cookie overwrites a newer login', async () => {
        const f = setup(); const first = await f.login(); const delayedSuccess = first.response;
        f.state.claims = { sub: '99' }; f.state.core = { subject: '99', session_id: 'newer-core-work-sid' };
        const newer = await f.login({ cookie: first.cookie }); expect(jarCookie(newer.cookie, channelCookieName)).toBe(jarCookie(first.cookie, channelCookieName)); expect(newer.session.subject).toBe('99');
        expect(newer.flow.response.headers['set-cookie']).toBeUndefined(); expect(setCookies(delayedSuccess)).toHaveLength(1);
        const browserCookie = mergeCookieJar(newer.cookie, delayedSuccess); expect(browserCookie).not.toBe(newer.cookie);
        const beforeLateCookie = f.calls.length;
        for (const path of ['/session', '/models', '/stream', '/logout']) {
            const rejected = await f.app.inject({ method: ['/session', '/models'].includes(path) ? 'GET' : 'POST', url: prefix + path, headers: { ...browserHeaders, cookie: browserCookie, 'x-tokenhub-csrf': newer.session.csrf }, ...(['/session', '/models'].includes(path) ? {} : { payload: path === '/stream' ? { model: 'model-a', prompt: 'hello' } : {} }) });
            expect(rejected.statusCode).toBe(401); expect(rejected.body).not.toContain(newer.session.csrf); expect(rejected.body).not.toContain(newer.session.sessionId);
        }
        expect(f.calls).toHaveLength(beforeLateCookie);
        const session = await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: newer.cookie } }); expect(session.statusCode).toBe(200); expect(session.json()).toEqual(newer.session);
        const beforeOldCsrf = f.calls.length;
        for (const path of ['/models', '/stream', '/logout']) {
            const rejected = await f.app.inject({ method: path === '/models' ? 'GET' : 'POST', url: prefix + path, headers: { ...browserHeaders, cookie: newer.cookie, 'x-tokenhub-csrf': first.session.csrf }, ...(path === '/models' ? {} : { payload: path === '/stream' ? { model: 'model-a', prompt: 'hello' } : {} }) });
            expect(rejected.statusCode).toBe(403);
        }
        expect(f.calls).toHaveLength(beforeOldCsrf);
        expect((await f.app.inject({ url: prefix + '/models', headers: { ...browserHeaders, cookie: newer.cookie, 'x-tokenhub-csrf': newer.session.csrf } })).statusCode).toBe(200);
    });

    it.each([false, true])('a captured old-session authority response cannot revoke a newer principal on the same channel (revoked=%s)', async revoked => {
        const f = setup(); const first = await f.login(); f.state.core = { active: !revoked }; f.state.deferNextVerify = true;
        const pending = f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: first.cookie } }).then(response => response); await f.verifyStarted;
        f.state.claims = { sub: '99' }; f.state.core = { subject: '99', session_id: 'newer-core-work-sid' };
        const newer = await f.login({ cookie: first.cookie }); expect(jarCookie(newer.cookie, channelCookieName)).toBe(jarCookie(first.cookie, channelCookieName));
        f.releaseVerify(); const obsolete = await pending; expect(obsolete.statusCode).toBe(401); expect(obsolete.headers['set-cookie']).toBeUndefined();
        const current = await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: newer.cookie } }); expect(current.statusCode).toBe(200); expect(current.json()).toEqual(newer.session);
        expect((await f.app.inject({ url: prefix + '/models', headers: { ...browserHeaders, cookie: newer.cookie, 'x-tokenhub-csrf': newer.session.csrf } })).statusCode).toBe(200);
    });

    it('never adopts an arbitrary browser-supplied channel identifier', async () => {
        const f = setup(); const arbitrary = channelCookieName + '=' + 'x'.repeat(43);
        expect((await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: arbitrary } })).statusCode).toBe(401);
        const flow = await f.start({ cookie: arbitrary }); expect(flow.cookie).not.toBe(arbitrary); expect(setCookies(flow.response)).toHaveLength(1);
        const before = f.calls.length; expect((await f.complete(flow, { cookie: arbitrary })).statusCode).toBe(400); expect(f.calls).toHaveLength(before);
        expect((await f.complete(flow)).statusCode).toBe(200);
        expect((await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: arbitrary } })).statusCode).toBe(401);
    });

    it('fails closed for mismatched concurrent fresh starts and a late first-start cookie instead of switching authenticated accounts', async () => {
        const f = setup(); const [first, second] = await Promise.all([f.start(), f.start()]); expect(first.cookie).not.toBe(second.cookie);
        const mismatched = await f.complete(first, { cookie: second.cookie }); expect(mismatched.statusCode).toBe(400);
        for (const channel of [first.cookie, second.cookie]) expect((await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: channel } })).statusCode).toBe(401);
        f.state.claims = { sub: '99' }; f.state.core = { subject: '99', session_id: 'winning-core-work-sid' };
        const winner = await f.complete(second); expect(winner.statusCode).toBe(200);
        // Deliver the older fresh-start response after the winning channel logged in.
        const lateCookie = cookie(first.response, channelCookieName); expect(lateCookie).toBe(first.cookie);
        expect((await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: lateCookie } })).statusCode).toBe(401);
        const retry = await f.start({ cookie: lateCookie }); expect(retry.cookie).toBe(lateCookie); expect(retry.response.headers['set-cookie']).toBeUndefined();
        expect((await f.complete(first)).statusCode).toBe(400);
        const restored = await f.complete(retry); expect(restored.statusCode).toBe(200);
        const current = await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: mergeCookieJar(retry.cookie, restored) } }); expect(current.statusCode).toBe(200); expect(current.json()).toEqual(restored.json());
    });

    it.each(['expired', 'restarted'])('rejects a stale %s channel and issues a new one only on an explicit start', async mode => {
        const original = setup(); const logged = await original.login(); const f = mode === 'restarted' ? setup() : original;
        if (mode === 'expired') f.advance(61_000);
        const rejected = await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: logged.cookie } }); expect(rejected.statusCode).toBe(401); expect(rejected.headers['set-cookie']).toBeUndefined();
        const replacement = await f.start({ cookie: logged.cookie }); expect(replacement.cookie).not.toBe(logged.cookie); expect(setCookies(replacement.response)).toHaveLength(1);
        expect((await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: replacement.cookie } })).statusCode).toBe(401);
    });

    it('does not let a slower known-channel start supersede or cancel the newer start after metadata resolves', async () => {
        const f = setup({ maxSessions: 1, maxFlows: 1 }); const channel = await f.start(); f.state.deferNextMetadata = true;
        const pending = f.app.inject({ method: 'POST', url: prefix + '/start', headers: { ...browserHeaders, cookie: channel.cookie }, payload: {} }).then(response => response); await f.metadataStarted;
        const newest = await f.start({ cookie: channel.cookie }); expect(newest.cookie).toBe(channel.cookie); expect(newest.response.headers['set-cookie']).toBeUndefined();
        f.releaseMetadata(); const slower = await pending; expect(slower.statusCode).toBe(503); expect(slower.headers['set-cookie']).toBeUndefined();
        expect((await f.complete(channel)).statusCode).toBe(400);
        const success = await f.complete(newest); expect(success.statusCode).toBe(200);
        const current = await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: mergeCookieJar(newest.cookie, success) } }); expect(current.statusCode).toBe(200); expect(current.json()).toEqual(success.json());
    });
});

describe('bounded platform session memory', () => {
    it('refuses extra active login flows without invalidating the legitimate transaction', async () => {
        const f = setup({ maxFlows: 1 }); const first = await f.start();
        const overflow = await f.app.inject({ method: 'POST', url: prefix + '/start', headers: browserHeaders, payload: {} });
        expect(overflow.statusCode).toBe(503); expect(overflow.json()).toMatchObject({ platform: true, enabled: true }); expect(overflow.headers['set-cookie']).toBeUndefined();
        const success = await f.complete(first); expect(success.statusCode, success.body).toBe(200);
        expect((await f.start()).state).not.toBe(first.state);
    });

    it('counts pending code exchanges toward the flow cap and preserves their legitimate completion', async () => {
        const f = setup({ maxFlows: 1 }); const first = await f.start(); f.state.deferExchange = true;
        const pending = f.complete(first).then(response => response); await f.exchangeStarted;
        const overflow = await f.app.inject({ method: 'POST', url: prefix + '/start', headers: browserHeaders, payload: {} });
        expect(overflow.statusCode).toBe(503); expect(overflow.headers['set-cookie']).toBeUndefined();
        f.releaseExchange(); const success = await pending; expect(success.statusCode, success.body).toBe(200);
        expect((await f.start()).state).not.toBe(first.state);
    });

    it('releases expired flow capacity without accepting the expired transaction', async () => {
        const f = setup({ maxFlows: 1, core: { expires_at: Math.floor(Date.now() / 1000) + 600 } }); const old = await f.start(); f.advance(300_001);
        const current = await f.start(); expect(current.state).not.toBe(old.state);
        expect((await f.complete(old)).statusCode).toBe(400);
        const success = await f.complete(current); expect(success.statusCode, success.body).toBe(200);
    });

    it('refuses additional browser channels without evicting an authenticated browser or its reusable logout marker', async () => {
        const f = setup({ maxSessions: 1 }); const first = await f.login();
        const extraStart = () => f.app.inject({ method: 'POST', url: prefix + '/start', headers: browserHeaders, payload: {} });
        const overflow = await extraStart(); expect(overflow.statusCode).toBe(503); expect(overflow.json()).toMatchObject({ platform: true, enabled: true }); expect(overflow.headers['set-cookie']).toBeUndefined();
        const existing = await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: first.cookie } }); expect(existing.statusCode).toBe(200); expect(existing.json()).toEqual(first.session);
        expect((await f.app.inject({ method: 'POST', url: prefix + '/logout', headers: { ...browserHeaders, cookie: first.cookie, 'x-tokenhub-csrf': first.session.csrf }, payload: {} })).statusCode).toBe(200);
        expect((await extraStart()).statusCode).toBe(503);
        const reused = await f.start({ cookie: first.cookie }); expect(reused.cookie).toBe(first.cookie); expect(reused.response.headers['set-cookie']).toBeUndefined();
        f.advance(300_001); const replacement = await f.start(); expect(replacement.cookie).not.toBe(first.cookie);
    });

    it('caps the session and cookie lifetime at 24 hours even when Core authorizes a later expiry', async () => {
        const lifetime = 24 * 60 * 60_000; const before = Date.now();
        const f = setup({ core: { expires_at: Math.floor(before / 1000) + 3 * 24 * 60 * 60 } }); const logged = await f.login();
        expect(logged.session.expiresAt).toBeGreaterThanOrEqual(before + lifetime); expect(logged.session.expiresAt).toBeLessThanOrEqual(Date.now() + lifetime);
        const header = setCookies(logged.flow.response).find(value => value.startsWith(channelCookieName + '='))!;
        expect(Number(header.match(/Max-Age=(\d+)/)?.[1])).toBe(24 * 60 * 60);
        f.advance(lifetime - 1);
        expect((await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: logged.cookie } })).statusCode).toBe(200);
        f.advance(1);
        expect((await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: logged.cookie } })).statusCode).toBe(401);
    });

    it('expires an anonymous issued channel after five minutes and frees its bounded slot', async () => {
        const f = setup({ maxSessions: 1 }); const old = await f.start(); f.advance(299_999);
        expect((await f.app.inject({ method: 'POST', url: prefix + '/start', headers: browserHeaders, payload: {} })).statusCode).toBe(503);
        f.advance(1); const fresh = await f.start(); expect(fresh.cookie).not.toBe(old.cookie);
        expect((await f.complete(old)).statusCode).toBe(400);
        expect((await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: old.cookie } })).statusCode).toBe(401);
    });

    it('retains a logout marker for at most five minutes without preserving authentication or permanently consuming capacity', async () => {
        const f = setup({ maxSessions: 1, core: { expires_at: Math.floor(Date.now() / 1000) + 600 } }); const logged = await f.login(); f.advance(10_000);
        const logout = await f.app.inject({ method: 'POST', url: prefix + '/logout', headers: { ...browserHeaders, cookie: logged.cookie, 'x-tokenhub-csrf': logged.session.csrf }, payload: {} }); expect(logout.statusCode).toBe(200); expect(logout.headers['set-cookie']).toBeUndefined();
        f.advance(299_999);
        expect((await f.app.inject({ method: 'POST', url: prefix + '/start', headers: browserHeaders, payload: {} })).statusCode).toBe(503);
        expect((await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: logged.cookie } })).statusCode).toBe(401);
        f.advance(1); const next = await f.start(); expect(next.cookie).not.toBe(logged.cookie);
    });

    it('does not slide a channel absolute lifetime when the same browser signs in again', async () => {
        const f = setup({ core: { expires_at: Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60 } }); const first = await f.login();
        f.advance(23 * 60 * 60_000); const newer = await f.login({ cookie: first.cookie });
        expect(jarCookie(newer.cookie, channelCookieName)).toBe(jarCookie(first.cookie, channelCookieName)); expect(newer.session.expiresAt).toBe(first.session.expiresAt); expect(newer.flow.response.headers['set-cookie']).toBeUndefined();
        f.advance(60 * 60_000 - 1); expect((await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: newer.cookie } })).statusCode).toBe(200);
        f.advance(1); expect((await f.app.inject({ url: prefix + '/session', headers: { ...browserHeaders, cookie: newer.cookie } })).statusCode).toBe(401);
        const fresh = await f.start({ cookie: newer.cookie }); expect(fresh.cookie).not.toBe(newer.cookie);
    });

    it('never extends a near-expiry channel past its absolute lifetime when logout retains an anonymous marker', async () => {
        const f = setup({ maxSessions: 1, core: { expires_at: Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60 } }); const first = await f.login(); f.advance(24 * 60 * 60_000 - 1000);
        expect((await f.app.inject({ method: 'POST', url: prefix + '/logout', headers: { ...browserHeaders, cookie: first.cookie, 'x-tokenhub-csrf': first.session.csrf }, payload: {} })).statusCode).toBe(200);
        const reused = await f.start({ cookie: first.cookie }); expect(reused.cookie).toBe(first.cookie); expect(reused.response.headers['set-cookie']).toBeUndefined();
        f.advance(1000); const fresh = await f.start({ cookie: first.cookie }); expect(fresh.cookie).not.toBe(first.cookie);
        expect((await f.complete(reused)).statusCode).toBe(400);
    });
});

describe('platform Core gateway boundary', () => {
    it('projects the real model catalog without provider credentials or placeholder defaults', async () => {
        const f = setup(); const logged = await f.login();
        const response = await f.app.inject({ url: prefix + '/models', headers: { ...browserHeaders, cookie: logged.cookie, 'x-tokenhub-csrf': logged.session.csrf } });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({ mode: 'real', billable: true, models: [{ id: 'model-a', name: 'model-a' }, { id: 'model-b', name: 'model-b' }] });
        expect(response.body).not.toContain('provider-secret'); expect(response.body).not.toContain('internal-subject'); assertNoCredentials(response);
    });

    it('sends the selected model and Core-only usage through the existing parser without client-controlled identity headers', async () => {
        const f = setup(); const logged = await f.login(); const requestId = '6f948430-bc83-4558-8cdc-a07e32061c7f';
        const response = await f.app.inject({ method: 'POST', url: prefix + '/stream', headers: { ...browserHeaders, cookie: logged.cookie, 'x-tokenhub-csrf': logged.session.csrf, 'x-client-ip': '1.1.1.1', 'x-forwarded-for': '8.8.8.8', 'x-user-id': 'attacker' }, payload: { model: 'model-b', prompt: 'hello', requestId } });
        expect(response.statusCode, response.body).toBe(200); expect(response.headers['content-type']).toContain('application/x-ndjson');
        const events = response.body.trim().split('\n').map(line => JSON.parse(line));
        expect(events).toEqual([{ type: 'delta', text: 'hello' }, { type: 'usage', requestId, coreRequestId: 'synthetic-core-request', model: 'model-b', inputTokens: 2, outputTokens: 1, mock: false, billable: true, accounting: 'core' }, { type: 'done' }]);
        const coreCall = f.calls.find(call => call.url.endsWith('/chat/completions'))!;
        expect(JSON.parse(String(coreCall.init?.body))).toEqual({ model: 'model-b', messages: [{ role: 'user', content: 'hello' }], stream: true, stream_options: { include_usage: true } });
        const headers = new Headers(coreCall.init?.headers); expect(headers.get('x-work-request-id')).toBe(requestId); expect(headers.get('x-user-id')).toBeNull(); expect(headers.get('x-forwarded-for')).toBeNull(); expect(headers.get('x-client-ip')).toBe('127.0.0.1'); expect(headers.get('user-agent')).toBe(browserHeaders['user-agent']);
        expect(response.body).not.toContain(coreSid); assertNoCredentials(response);
        const verifyCalls = f.calls.filter(call => call.url.endsWith('/verify'));
        for (const call of verifyCalls) { const context = new Headers(call.init?.headers); expect(context.get('x-user-id')).toBeNull(); expect(context.get('x-forwarded-for')).toBeNull(); expect(context.get('x-client-ip')).toBe('127.0.0.1'); }
    });

    it.each([{ userId: 'other' }, { subject: '99' }, { sessionId: 'other' }, { apiKey: 'key' }, { authorizationToken: 'forged' }, { endpoint: 'https://attacker.test' }, { usage: 10 }, { publicKey: 'key' }, { model: 'default' }])('rejects browser-provided authority or placeholder model %j', async extra => {
        const f = setup(); const logged = await f.login();
        const response = await f.app.inject({ method: 'POST', url: prefix + '/stream', headers: { ...browserHeaders, cookie: logged.cookie, 'x-tokenhub-csrf': logged.session.csrf }, payload: { model: 'model-a', prompt: 'hello', ...extra } });
        expect(response.statusCode).toBe(400); expect(f.calls.filter(call => call.url.startsWith(gatewayOrigin))).toHaveLength(0);
    });

    it.each(['revoked', 'unavailable', 'changed-sid'])('revalidates a live stream at 15 seconds and cancels Core without retry when authority is %s', async mode => {
        const f = setup(); const logged = await f.login(); f.state.slowStream = true;
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
        const pending = f.app.inject({ method: 'POST', url: prefix + '/stream', headers: { ...browserHeaders, cookie: logged.cookie, 'x-tokenhub-csrf': logged.session.csrf }, payload: { model: 'model-b', prompt: 'hello' } }).then(response => response);
        await f.streamStarted;
        const before = f.calls.filter(call => call.url.endsWith('/verify')).length;
        if (mode === 'unavailable') f.state.coreUnavailable = true;
        else f.state.core = mode === 'revoked' ? { active: false } : { session_id: 'changed-sid' };
        f.advance(14_999); await vi.advanceTimersByTimeAsync(14_999);
        expect(f.calls.filter(call => call.url.endsWith('/verify'))).toHaveLength(before);
        f.advance(1); await vi.advanceTimersByTimeAsync(1);
        const response = await pending;
        expect(f.calls.filter(call => call.url.endsWith('/verify'))).toHaveLength(before + 1);
        expect(response.body).toContain('authorization_revoked'); expect(response.body).not.toContain('"type":"done"'); assertNoCredentials(response);
        expect(f.streamCancelled).toHaveBeenCalledOnce(); expect(f.calls.filter(call => call.url.endsWith('/chat/completions'))).toHaveLength(1);
    });

    it('aborts a live stream at the Core expiry before the next 15-second authority poll', async () => {
        const f = setup({ core: { expires_at: Math.floor(Date.now() / 1000) + 2 } }); const logged = await f.login(); f.state.slowStream = true;
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
        const pending = f.app.inject({ method: 'POST', url: prefix + '/stream', headers: { ...browserHeaders, cookie: logged.cookie, 'x-tokenhub-csrf': logged.session.csrf }, payload: { model: 'model-a', prompt: 'hello' } }).then(response => response);
        await f.streamStarted; const before = f.calls.filter(call => call.url.endsWith('/verify')).length;
        f.advance(3000); await vi.advanceTimersByTimeAsync(3000);
        const response = await pending;
        expect(response.body).toContain('authorization_revoked'); expect(response.body).not.toContain('"type":"done"');
        expect(f.calls.filter(call => call.url.endsWith('/verify'))).toHaveLength(before); expect(f.streamCancelled).toHaveBeenCalledOnce();
    });

    it('immediately aborts a browser session live stream on local logout without revoking Core', async () => {
        const f = setup(); const logged = await f.login(); f.state.slowStream = true;
        const pending = f.app.inject({ method: 'POST', url: prefix + '/stream', headers: { ...browserHeaders, cookie: logged.cookie, 'x-tokenhub-csrf': logged.session.csrf }, payload: { model: 'model-a', prompt: 'hello' } }).then(response => response);
        await f.streamStarted;
        const logout = await f.app.inject({ method: 'POST', url: prefix + '/logout', headers: { ...browserHeaders, cookie: logged.cookie, 'x-tokenhub-csrf': logged.session.csrf }, payload: {} });
        expect(logout.statusCode).toBe(200); const response = await pending;
        expect(response.body).toContain('authorization_revoked'); expect(response.body).not.toContain('"type":"done"'); expect(f.streamCancelled).toHaveBeenCalledOnce();
        expect(f.calls.some(call => call.url.endsWith('/revoke'))).toBe(false);
    });
});


const historyId = '81b62d84-999a-4cab-8c3a-8beca703ef7a';
const historyRequestId = 'bd780771-85ee-4b19-a744-9999b73034a9';
function syntheticHistory() {
    let conversation: any = null;
    const history = {
        list: vi.fn(async (_owner: unknown) => conversation ? [{ id: conversation.id, model: conversation.model, title: 'hello', updatedAt: 1, lastStatus: conversation.turns.at(-1).status }] : []),
        get: vi.fn(async (_owner: unknown, _id: string) => conversation),
        remove: vi.fn(async (_owner: unknown, _id: string) => { conversation = null; }),
        import: vi.fn(async (_owner: unknown, input: any) => { conversation = { ...input, updatedAt: 1 }; return conversation; }),
        begin: vi.fn(async (_owner: unknown, input: any) => {
            if (conversation) return { created: false, conversation, turn: conversation.turns[0] };
            const turn = { id: input.requestId, user: input.messages.at(-1).content, assistant: '', status: 'streaming' };
            conversation = { id: input.conversationId, model: input.model, turns: [turn], updatedAt: 1 };
            return { created: true, conversation, turn };
        }),
        checkpoint: vi.fn(async (_owner: unknown, _id: string, turn: any) => {
            conversation = { ...conversation, turns: [{ ...conversation.turns[0], ...turn }], updatedAt: 2 }; return conversation;
        }),
    };
    return history;
}

describe('account-scoped platform conversation routes', () => {
    it('requires both cookie authentication and CSRF plus live authority for all history reads and writes', async () => {
        const history = syntheticHistory(); const f = setup({ history: history as PlatformConversations });
        const paths = [
            { method: 'GET' as const, url: prefix + '/conversations' },
            { method: 'GET' as const, url: prefix + '/conversations/' + historyId },
            { method: 'DELETE' as const, url: prefix + '/conversations/' + historyId },
            { method: 'POST' as const, url: prefix + '/conversations/import', payload: { id: historyId, model: 'model-a', turns: [{ id: historyRequestId, user: 'old', assistant: 'reply', status: 'complete' }] } },
        ];
        for (const path of paths) {
            expect((await f.app.inject({ ...path, headers: browserHeaders })).statusCode).toBe(401);
            expect((await f.app.inject({ ...path, headers: { ...browserHeaders, authorization: 'Bearer signed-legacy-token' } })).statusCode).toBe(401);
        }
        const login = await f.login();
        for (const path of paths) expect((await f.app.inject({ ...path, headers: { ...browserHeaders, cookie: login.cookie } })).statusCode).toBe(403);
        f.state.coreUnavailable = true;
        for (const path of paths) expect((await f.app.inject({ ...path, headers: { ...browserHeaders, cookie: login.cookie, 'x-tokenhub-csrf': login.session.csrf } })).statusCode).toBe(503);
        for (const method of Object.values(history)) expect(method).not.toHaveBeenCalled();
        expect(f.legacyVerify).not.toHaveBeenCalled();
    });

    it('derives every history owner from the verified server principal and rejects client identity fields', async () => {
        const history = syntheticHistory(); const f = setup({ history: history as PlatformConversations }); const login = await f.login();
        const headers = { ...browserHeaders, cookie: login.cookie, 'x-tokenhub-csrf': login.session.csrf };
        const response = await f.app.inject({ method: 'GET', url: prefix + '/conversations', headers });
        expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ conversations: [] });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(history.list).toHaveBeenCalledWith(expect.objectContaining({ authority, issuer: 'tokenapi', subject: '42' }));
        expect((await f.app.inject({ method: 'GET', url: prefix + '/conversations?subject=43', headers })).statusCode).toBe(400);
        expect((await f.app.inject({ method: 'POST', url: prefix + '/conversations/import', headers, payload: { id: historyId, model: 'model-a', subject: '43', turns: [{ id: historyRequestId, user: 'old', assistant: 'reply', status: 'complete' }] } })).statusCode).toBe(400);
        const imported = await f.app.inject({ method: 'POST', url: prefix + '/conversations/import', headers, payload: { id: historyId, model: 'model-a', turns: [{ id: historyRequestId, user: 'old', assistant: 'reply', status: 'complete' }] } });
        expect(imported.statusCode, imported.body).toBe(200);
        expect(history.import.mock.calls[0][0]).toMatchObject({ authority, subject: '42' });
        expect((await f.app.inject({ method: 'GET', url: prefix + '/conversations/' + historyId, headers })).json().turns[0].user).toBe('old');
        expect((await f.app.inject({ method: 'DELETE', url: prefix + '/conversations/' + historyId, headers })).json()).toEqual({ deleted: true });
        expect(history.remove.mock.calls[0][0]).toMatchObject({ authority, subject: '42' });
    });

    it('saves user turn before inference, saves partial/final output, and never repeats a recorded request', async () => {
        const history = syntheticHistory(); const f = setup({ history: history as PlatformConversations }); const login = await f.login();
        const headers = { ...browserHeaders, cookie: login.cookie, 'x-tokenhub-csrf': login.session.csrf };
        const payload = { model: 'model-a', conversationId: historyId, requestId: historyRequestId, messages: [{ role: 'user', content: 'hello' }] };
        const response = await f.app.inject({ method: 'POST', url: prefix + '/stream', headers, payload });
        expect(response.statusCode, response.body).toBe(200);
        expect(history.begin).toHaveBeenCalledTimes(1);
        const calls = history.checkpoint.mock.calls.map(call => call[2]);
        expect(calls.some(turn => turn.assistant === 'hello')).toBe(true);
        const saved = await history.get({}, historyId);
        expect(saved.turns[0]).toMatchObject({ id: historyRequestId, user: 'hello', assistant: 'hello', status: 'complete', usage: { requestId: historyRequestId, accounting: 'core' } });
        expect(response.body).toContain('"type":"done"');
        expect((await f.app.inject({ method: 'POST', url: prefix + '/stream', headers, payload })).statusCode).toBe(409);
        expect(f.calls.filter(call => call.url.endsWith('/chat/completions'))).toHaveLength(1);
        expect(JSON.parse(String(f.calls.find(call => call.url.endsWith('/chat/completions'))!.init!.body))).not.toHaveProperty('conversationId');
    });

    it('fails closed before inference if durable initial persistence fails', async () => {
        const history = syntheticHistory(); history.begin.mockRejectedValueOnce(new Error('synthetic DB failure'));
        const f = setup({ history: history as PlatformConversations }); const login = await f.login();
        const response = await f.app.inject({ method: 'POST', url: prefix + '/stream', headers: { ...browserHeaders, cookie: login.cookie, 'x-tokenhub-csrf': login.session.csrf }, payload: { model: 'model-a', prompt: 'hello', conversationId: historyId, requestId: historyRequestId } });
        expect(response.statusCode).toBe(503); expect(response.body).not.toContain('synthetic');
        expect(f.calls.filter(call => call.url.endsWith('/chat/completions'))).toHaveLength(0);
    });

    it('does not deliver a late history read after sign-out', async () => {
        const history = syntheticHistory(); let release!: () => void;
        history.list.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return []; });
        const f = setup({ history: history as PlatformConversations }); const login = await f.login();
        const headers = { ...browserHeaders, cookie: login.cookie, 'x-tokenhub-csrf': login.session.csrf };
        const read = f.app.inject({ method: 'GET', url: prefix + '/conversations', headers });
        await vi.waitFor(() => expect(history.list).toHaveBeenCalled());
        expect((await f.app.inject({ method: 'POST', url: prefix + '/logout', headers, payload: {} })).statusCode).toBe(200);
        release(); expect((await read).statusCode).toBe(401);
    });
});
