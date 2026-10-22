import { afterEach, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Fastify } from '../types';
import { enableAuthentication } from '../utils/enableAuthentication';
import { tokenHubWorkRoutes } from './tokenHubWorkRoutes';
import { createWorkAuthorization } from '@/app/tokenhub/workAuthorization';
import { createMockGateway } from '@/app/tokenhub/mockGateway';
import { createMockProvider } from '@/app/tokenhub/mockProvider';

vi.mock('@/utils/log', () => ({ debug: vi.fn() }));
const apps: ReturnType<typeof fastify>[] = [], providers: ReturnType<typeof createMockProvider>[] = [];
afterEach(async () => {
    for (const app of apps.splice(0)) { app.server.closeAllConnections(); await app.close(); }
    for (const server of providers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
async function setup(options: { disabled?: boolean; native?: boolean; expiresInMs?: number; slow?: boolean } = {}) {
    const onRequest = vi.fn(), onCancel = vi.fn();
    const provider = createMockProvider({ onRequest, onCancel, chunkDelayMs: options.slow ? 500 : 1 }); providers.push(provider);
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
    const gateway = createMockGateway({ env: options.disabled ? {} : { TOKENHUB_GATEWAY_MODE: 'mock', TOKENHUB_UNIFIED_AUTH: 'true', TOKENHUB_MOCK_GATEWAY_URL: `http://127.0.0.1:${address.port}` } });
    let active = true;
    const authority = 'https://accounts.example.test';
    const grant = { authority, issuer: 'tokenapi', subject: '42', publicKey: 'ab'.repeat(32), authorizationToken: 'test-core-work-token' };
    const authorization = createWorkAuthorization({
        env: { TOKENHUB_UNIFIED_AUTH: 'true', TOKENHUB_AUTHCENTER_URL: 'http://127.0.0.1:28084', TOKENHUB_URL: authority },
        verifyHappyToken: async token => token === 'signed-happy' ? { userId: 'happy-user', extras: options.native ? {} : { tokenhub: grant } } : null,
        findBinding: async () => ({ authority, issuer: 'tokenapi', subject: '42', accountId: 'happy-user', account: { id: 'happy-user', publicKey: grant.publicKey } }),
        transport: async () => new Response(JSON.stringify({ active, application: 'work', issuer: 'tokenapi', subject: '42', session_id: 'trusted-session', expires_at: Math.floor(Date.now() / 1000) + 60, permissions: ['work:access'] }), { headers: { 'content-type': 'application/json' } }),
    });
    if (options.expiresInMs) {
        const original = authorization.verifyToken.bind(authorization), expiresAt = Date.now() + options.expiresInMs;
        authorization.verifyToken = async (...args) => { const verified = await original(...args); return verified ? { ...verified, expiresAt } : null; };
    }
    const app = fastify(); apps.push(app); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    enableAuthentication(app as unknown as Fastify, authorization);
    tokenHubWorkRoutes(app as unknown as Fastify, { gateway, authorization, revalidateMs: 20 });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const api = app.server.address(); if (!api || typeof api === 'string') throw new Error('Missing listener');
    return { app, gateway, onRequest, onCancel, url: `http://127.0.0.1:${api.port}`, revoke: () => { active = false; } };
}
const headers = { authorization: 'Bearer signed-happy', 'content-type': 'application/json' };

it('requires live verified Work auth, advertises only mock models and remains disabled by default', async () => {
    const f = await setup();
    expect((await f.app.inject('/v1/tokenhub/work/models')).statusCode).toBe(401);
    const models = await f.app.inject({ url: '/v1/tokenhub/work/models', headers });
    expect(models.statusCode).toBe(200); expect(models.json()).toMatchObject({ mode: 'mock', billable: false });
    expect(models.json().models.map((model: { id: string }) => model.id)).toEqual(['mock-echo', 'mock-slow', 'mock-error']);
    const disabled = await setup({ disabled: true }); expect((await disabled.app.inject({ url: '/v1/tokenhub/work/models', headers })).statusCode).toBe(503);
    const native = await setup({ native: true }); expect((await native.app.inject({ url: '/v1/tokenhub/work/models', headers })).statusCode).toBe(401);
    expect(f.onRequest).not.toHaveBeenCalled();
});

it('streams through HTTP and binds usage only to verified user/subject/session, never forged headers', async () => {
    const f = await setup();
    const result = await f.app.inject({ method: 'POST', url: '/v1/tokenhub/work/stream', headers: { ...headers, 'x-user-id': 'forged', 'x-tokenhub-subject': '999', 'x-tokenhub-session-id': 'forged-session' }, payload: { model: 'mock-echo', prompt: 'Hello' } });
    expect(result.statusCode).toBe(200); expect(result.headers['x-tokenhub-mock']).toBe('true');
    const events = result.body.trim().split('\n').map(line => JSON.parse(line));
    expect(events.at(-1)).toEqual({ type: 'done' }); expect(events.at(-2)).toMatchObject({ type: 'usage', mock: true, billable: false });
    expect(f.gateway.ledger.snapshot()).toEqual([expect.objectContaining({ userId: 'happy-user', authority: 'https://accounts.example.test', issuer: 'tokenapi', subject: '42', sessionId: 'trusted-session', model: 'mock-echo' })]);
    expect(result.body).not.toContain('trusted-session'); expect(result.body).not.toContain('happy-user');
});

it.each([{ user_id: 'forged' }, { userId: 'forged' }, { subject: '999' }, { sessionId: 'forged' }, { usage: { inputTokens: 100000 } }, { url: 'https://evil.test' }, { apiKey: 'pretend-key' }])('rejects extra browser authority fields %j without contacting upstream', async extra => {
    const f = await setup();
    const result = await f.app.inject({ method: 'POST', url: '/v1/tokenhub/work/stream', headers, payload: { model: 'mock-echo', prompt: 'Hello', ...extra } });
    expect(result.statusCode).toBe(400); expect(f.onRequest).not.toHaveBeenCalled(); expect(f.gateway.ledger.snapshot()).toEqual([]);
});

it('propagates real browser abort through Work to the loopback provider', async () => {
    const f = await setup({ slow: true });
    const controller = new AbortController();
    const result = await fetch(f.url + '/v1/tokenhub/work/stream', { method: 'POST', headers, body: JSON.stringify({ model: 'mock-slow', prompt: 'Cancel' }), signal: controller.signal });
    const reader = result.body!.getReader(); expect((await reader.read()).value).toBeTruthy(); controller.abort();
    await reader.cancel().catch(() => {});
    await vi.waitFor(() => expect(f.onCancel).toHaveBeenCalledOnce()); expect(f.gateway.ledger.snapshot()).toEqual([]);
});

it.each(['revoked', 'expired'])('stops a long stream when Work authorization is %s', async kind => {
    const f = await setup({ slow: true, ...(kind === 'expired' ? { expiresInMs: 100 } : {}) });
    const result = await fetch(f.url + '/v1/tokenhub/work/stream', { method: 'POST', headers, body: JSON.stringify({ model: 'mock-slow', prompt: 'Stop after first chunk' }) });
    const reader = result.body!.getReader(), first = await reader.read(); expect(first.value).toBeTruthy();
    if (kind === 'revoked') f.revoke();
    let remainder = ''; for (;;) { const next = await reader.read(); if (next.done) break; remainder += new TextDecoder().decode(next.value); }
    expect(remainder).toContain('authorization_revoked'); expect(remainder).not.toContain('"type":"delta"');
    await vi.waitFor(() => expect(f.onCancel).toHaveBeenCalledOnce()); expect(f.gateway.ledger.snapshot()).toEqual([]);
});
