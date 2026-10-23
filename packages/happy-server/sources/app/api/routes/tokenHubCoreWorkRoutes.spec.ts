import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Fastify } from '../types';
import { enableAuthentication } from '../utils/enableAuthentication';
import { tokenHubWorkRoutes } from './tokenHubWorkRoutes';
import { createWorkAuthorization } from '@/app/tokenhub/workAuthorization';
import { createCoreGateway } from '@/app/tokenhub/coreGateway';
vi.mock('@/utils/log', () => ({ debug: vi.fn() }));
const apps: ReturnType<typeof fastify>[] = [], servers: Server[] = [];
afterEach(async () => { for (const app of apps.splice(0)) { app.server.closeAllConnections(); await app.close(); } for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); } });
async function setup(options: { slow?: boolean; wrongBinding?: boolean } = {}) {
    const calls: Array<{ headers: import('node:http').IncomingHttpHeaders; body: string }> = [], cancelled = vi.fn();
    const core = createServer(async (request, response) => {
        let body = ''; for await (const chunk of request) body += chunk; calls.push({ headers: request.headers, body });
        if (request.url?.endsWith('/models')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'real-model', apiKey: 'private' }] })); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
        if (options.slow) response.on('close', cancelled);
        else response.end('data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
    }); servers.push(core); await new Promise<void>(resolve => core.listen(0, '127.0.0.1', resolve));
    const coreAddress = core.address(); if (!coreAddress || typeof coreAddress === 'string') throw new Error();
    let active = true;
    const authority = 'https://accounts.example.test', grant = { authority, issuer: 'sso', subject: '42', publicKey: 'ab'.repeat(32), authorizationToken: 'signed-core-work-grant' };
    const authorization = createWorkAuthorization({
        env: { TOKENHUB_UNIFIED_AUTH: 'true', TOKENHUB_AUTHCENTER_URL: 'http://127.0.0.1:28084', TOKENHUB_URL: authority },
        verifyHappyToken: async token => token === 'signed-happy' ? { userId: 'happy-user', extras: { tokenhub: grant } } : null,
        findBinding: async () => ({ authority, issuer: 'sso', subject: '42', accountId: options.wrongBinding ? 'other' : 'happy-user', account: { id: 'happy-user', publicKey: grant.publicKey } }),
        transport: async () => new Response(JSON.stringify({ active, application: 'work', issuer: 'tokenapi', subject: '42', session_id: 'trusted-session', expires_at: Math.floor(Date.now() / 1000) + 60, permissions: ['work:access'] }), { headers: { 'content-type': 'application/json' } }),
    });
    const app = fastify(); apps.push(app); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler); enableAuthentication(app as unknown as Fastify, authorization);
    tokenHubWorkRoutes(app as unknown as Fastify, { authorization, revalidateMs: 20, coreGateway: createCoreGateway({ env: { TOKENHUB_GATEWAY_MODE: 'real', TOKENHUB_UNIFIED_AUTH: 'true', TOKENHUB_CORE_GATEWAY_URL: `http://127.0.0.1:${coreAddress.port}` } }) });
    await app.listen({ port: 0, host: '127.0.0.1' }); const addr = app.server.address(); if (!addr || typeof addr === 'string') throw new Error();
    return { app, calls, cancelled, authorization, url: `http://127.0.0.1:${addr.port}`, revoke: () => { active = false; } };
}
const headers = { authorization: 'Bearer signed-happy', 'content-type': 'application/json' };
it('extracts the exact grant only after fresh authority and persisted binding checks, without adding it to public session', async () => {
    const f = await setup();
    expect(await f.authorization.verifyToken('signed-happy')).not.toHaveProperty('authorizationToken');
    expect(await f.authorization.resolveGatewayGrant!('signed-happy')).toMatchObject({ authorizationToken: 'signed-core-work-grant' });
    f.revoke(); expect(await f.authorization.resolveGatewayGrant!('signed-happy')).toBeNull();
    const bad = await setup({ wrongBinding: true }); expect(await bad.authorization.resolveGatewayGrant!('signed-happy')).toBeNull(); expect(bad.calls).toHaveLength(0);
});
it('authenticates before Core calls and returns projected real models', async () => {
    const f = await setup(); expect((await f.app.inject('/v1/tokenhub/work/models')).statusCode).toBe(401);
    const response = await f.app.inject({ url: '/v1/tokenhub/work/models', headers }); expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ mode: 'real', billable: true, models: [{ id: 'real-model', name: 'real-model' }] }); expect(f.calls).toHaveLength(1);
});
it('streams through actual Core HTTP and ignores forged client identity and forwarding headers', async () => {
    const f = await setup(); const response = await f.app.inject({ method: 'POST', url: '/v1/tokenhub/work/stream', headers: { ...headers, 'x-client-ip': '1.1.1.1', 'x-forwarded-for': '8.8.8.8', 'x-user-id': '999' }, payload: { model: 'real-model', prompt: 'hi' } });
    expect(response.headers['x-tokenhub-gateway']).toBe('core'); expect(response.body).toContain('"type":"done"');
    expect(f.calls[0].headers.authorization).toBe('Bearer signed-core-work-grant'); expect(f.calls[0].headers['x-client-ip']).toBe('127.0.0.1'); expect(f.calls[0].headers['x-user-id']).toBeUndefined();
    expect(response.body).not.toContain('signed-core-work-grant'); expect(response.body).not.toContain('trusted-session'); expect(f.calls).toHaveLength(1);
});
it.each([{ userId: 'other' }, { subject: '999' }, { apiKey: 'key' }, { endpoint: 'https://evil.test' }, { usage: 10 }, { requestId: 'invalid-uuid' }])('rejects browser authority fields %j', async extra => {
    const f = await setup(); const response = await f.app.inject({ method: 'POST', url: '/v1/tokenhub/work/stream', headers, payload: { model: 'real-model', prompt: 'hi', ...extra } }); expect(response.statusCode).toBe(400); expect(f.calls).toHaveLength(0);
});
it.each(['revocation', 'disconnect'])('propagates %s through real relay/Core HTTP', async mode => {
    const f = await setup({ slow: true }), controller = new AbortController();
    const response = await fetch(f.url + '/v1/tokenhub/work/stream', { method: 'POST', headers, body: JSON.stringify({ model: 'real-model', prompt: 'hi' }), signal: controller.signal });
    const reader = response.body!.getReader(); expect((await reader.read()).value).toBeTruthy();
    if (mode === 'disconnect') { controller.abort(); await reader.cancel().catch(() => {}); }
    else { f.revoke(); let rest = ''; for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); } expect(rest).toContain('authorization_revoked'); expect(rest).not.toContain('"type":"done"'); }
    await vi.waitFor(() => expect(f.cancelled).toHaveBeenCalledOnce()); expect(f.calls).toHaveLength(1);
});

it('preserves client request UUID for Core idempotency without accepting ownership', async () => {
    const f = await setup(); const requestId = '6f948430-bc83-4558-8cdc-a07e32061c7f';
    await f.app.inject({ method: 'POST', url: '/v1/tokenhub/work/stream', headers, payload: { model: 'real-model', prompt: 'hi', requestId } });
    expect(f.calls[0].headers['x-work-request-id']).toBe(requestId); expect(JSON.parse(f.calls[0].body)).not.toHaveProperty('requestId');
});
