import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fastify from 'fastify';
import { Server } from 'socket.io';
import { enableAuthentication } from '../api/utils/enableAuthentication';
import { authRoutes } from '../api/routes/authRoutes';
import { installWorkSocketAuthentication, protectWorkSocket } from './socketAuthorization';
import { createWorkAuthorization } from './workAuthorization';
import { socketServerOptions } from '../api/socketConfig';
import type { Fastify } from '../api/types';

vi.mock('@/storage/db', () => ({ db: { account: { upsert: vi.fn() } } }));
vi.mock('@/app/auth/auth', () => ({ auth: { createToken: vi.fn() } }));
vi.mock('@/utils/log', () => ({ debug: vi.fn(), log: vi.fn() }));

// Exercise the real WebSocket transport on Node 20 as well as newer runtimes.
// Resolve Engine.IO's declared ws dependency from its own package, rather than
// relying on a global WebSocket or an undeclared/hoisted client dependency.
const testRequire = createRequire(__filename);
const socketIoRequire = createRequire(testRequire.resolve('socket.io'));
const engineIoRequire = createRequire(socketIoRequire.resolve('engine.io'));
const WebSocketClient = engineIoRequire('ws') as typeof WebSocket;
class TestSocket {
    readonly connected: Promise<'connected' | 'rejected'>;
    readonly disconnected: Promise<void>;
    private socket: WebSocket;
    private acknowledgments = new Map<number, (value: unknown) => void>();
    private sequence = 0;
    constructor(url: string) {
        let connected!: (value: 'connected' | 'rejected') => void;
        let disconnected!: () => void;
        this.connected = new Promise(resolve => { connected = resolve; });
        this.disconnected = new Promise(resolve => { disconnected = resolve; });
        this.socket = new WebSocketClient(url);
        this.socket.addEventListener('message', event => {
            const packet = String(event.data);
            if (packet.startsWith('0')) this.socket.send('40' + JSON.stringify({ token: 'signed-happy-token' }));
            else if (packet === '2') this.socket.send('3');
            else if (packet.startsWith('40')) connected('connected');
            else if (packet.startsWith('44')) connected('rejected');
            else if (packet.startsWith('43')) {
                const match = /^43([0-9]+)(\[.*)$/.exec(packet);
                if (match) { this.acknowledgments.get(Number(match[1]))?.(JSON.parse(match[2])[0]); this.acknowledgments.delete(Number(match[1])); }
            }
        });
        this.socket.addEventListener('close', () => { connected('rejected'); disconnected(); });
        this.socket.addEventListener('error', () => connected('rejected'));
    }
    protectedEvent(): Promise<unknown> {
        const sequence = ++this.sequence;
        const result = new Promise(resolve => this.acknowledgments.set(sequence, resolve));
        this.socket.send(`42${sequence}["protected-event"]`);
        return result;
    }
    disconnect() { this.socket.close(); }
}
const clients: TestSocket[] = [];
const servers: { app: ReturnType<typeof fastify>; io: Server }[] = [];
afterEach(async () => {
    clients.splice(0).forEach(client => client.disconnect());
    for (const server of servers.splice(0)) { await new Promise<void>(resolve => server.io.close(() => resolve())); await server.app.close(); }
});

async function setup(options: { happyToken?: 'native' | 'tampered'; status?: number; mismatch?: boolean; expired?: boolean } = {}) {
    const authority = 'https://accounts.example.test';
    const grant = { authorizationToken: 'test-core-work-token', authority, issuer: 'tokenapi', subject: '42', publicKey: 'ab'.repeat(32) };
    let status = options.status ?? 200;
    const transport = vi.fn(async () => new Response(JSON.stringify({ active: true, application: 'work', issuer: 'tokenapi', subject: '42', session_id: 'test-session', expires_at: Math.floor(Date.now() / 1000) + (options.expired ? -1 : 60), permissions: ['work:access'] }), { status, headers: { 'content-type': 'application/json' } }));
    const authorization = createWorkAuthorization({
        env: { TOKENHUB_UNIFIED_AUTH: 'true', TOKENHUB_AUTHCENTER_URL: 'http://127.0.0.1:28084', TOKENHUB_URL: authority }, transport,
        verifyHappyToken: async token => token !== 'signed-happy-token' || options.happyToken === 'tampered' ? null : options.happyToken === 'native' ? { userId: 'happy-a' } : { userId: 'happy-a', extras: { tokenhub: grant } },
        findBinding: async () => ({ authority, issuer: 'tokenapi', subject: '42', accountId: options.mismatch ? 'happy-b' : 'happy-a', account: { id: 'happy-a', publicKey: grant.publicKey } }),
    });
    const app = fastify(); enableAuthentication(app as unknown as Fastify, authorization); authRoutes(app as unknown as Fastify, authorization);
    app.get('/protected', { preHandler: app.authenticate }, async request => ({ userId: request.userId }));
    app.get('/v2/future-api', async request => ({ userId: request.userId }));
    app.post('/v2/trusted-context', async request => request.workSession);
    app.get('/v1/tokenhub/config', async () => ({ public: true }));
    app.post('/v1/tokenhub/start', async () => ({ public: true }));
    app.post('/v1/tokenhub/complete', async () => ({ public: true }));
    app.post('/v1/version', async () => ({ public: true }));
    const unsafeHandler = vi.fn(async () => 'private file or external callback');
    app.get('/files/*', unsafeHandler);
    app.get('/v1/connect/github/callback', unsafeHandler);
    app.post('/v1/connect/github/webhook', unsafeHandler);
    app.post('/logs-combined-from-cli-and-mobile-for-simple-ai-debugging', unsafeHandler);
    const io = new Server(app.server, socketServerOptions); installWorkSocketAuthentication(io, authorization);
    const handler = vi.fn();
    io.on('connection', socket => {
        protectWorkSocket(socket, socket.handshake.auth.token, socket.data.workSession, authorization);
        socket.on('protected-event', (ack: (data: unknown) => void) => { handler(); ack({ userId: socket.data.userId }); });
    });
    servers.push({ app, io });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No test listener');
    return { app, transport, handler, unsafeHandler, revoke: () => { status = 401; }, client() {
        const client = new TestSocket(`ws://127.0.0.1:${address.port}/v1/updates/?EIO=4&transport=websocket`);
        clients.push(client); return client;
    } };
}

function connectResult(client: TestSocket): Promise<'connected' | 'rejected'> {
    return client.connected;
}

it('uses one live verifier for HTTP and real WebSocket handshake/events, never trusting forwarded headers', async () => {
    const f = await setup();
    const response = await f.app.inject({ url: '/protected', headers: { authorization: 'Bearer signed-happy-token', 'user-agent': 'work-http-test', 'x-forwarded-for': '203.0.113.9', 'x-client-ip': '203.0.113.10' } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ userId: 'happy-a' });
    const client = f.client(); expect(await connectResult(client)).toBe('connected');
    expect(await client.protectedEvent()).toEqual({ userId: 'happy-a' });
    expect(f.transport).toHaveBeenCalledTimes(3); expect(f.handler).toHaveBeenCalledTimes(1);
    for (const [, init] of f.transport.mock.calls as unknown as [string, RequestInit][]) {
        expect(init.headers).toMatchObject({ 'X-Client-IP': '127.0.0.1' });
        expect(new Headers(init.headers).has('x-forwarded-for')).toBe(false);
    }
    f.revoke();
    void client.protectedEvent(); await client.disconnected;
    expect(f.handler).toHaveBeenCalledTimes(1);
    expect((await f.app.inject({ url: '/protected', headers: { authorization: 'Bearer signed-happy-token' } })).statusCode).toBe(401);
});

it.each([
    ['native bypass', { happyToken: 'native' as const }], ['tampered Happy token', { happyToken: 'tampered' as const }],
    ['revoked', { status: 401 }], ['disabled', { status: 403 }], ['unavailable', { status: 503 }],
    ['wrong account', { mismatch: true }], ['expired', { expired: true }],
])('rejects %s over both HTTP and real WebSocket', async (_label, options) => {
    const f = await setup(options);
    expect((await f.app.inject({ url: '/protected', headers: { authorization: 'Bearer signed-happy-token' } })).statusCode).toBe(401);
    expect(await connectResult(f.client())).toBe('rejected'); expect(f.handler).not.toHaveBeenCalled();
});

it('disables direct identity creation and every native/account pairing endpoint in unified mode', async () => {
    const f = await setup();
    for (const [method, url] of [['POST', '/v1/auth'], ['POST', '/v1/auth/request'], ['GET', '/v1/auth/request/status'], ['POST', '/v1/auth/response'], ['POST', '/v1/auth/account/request'], ['POST', '/v1/auth/account/response']] as const) {
        const response = await f.app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
        expect(response.statusCode).toBe(403);
    }
    expect(f.transport).not.toHaveBeenCalled();
});

it('default-protects future API routes and blocks legacy raw files/debug/callbacks even with a valid token', async () => {
    const f = await setup();
    expect((await f.app.inject('/v2/future-api')).statusCode).toBe(401);
    const response = await f.app.inject({ url: '/v2/future-api', headers: { authorization: 'Bearer signed-happy-token' } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ userId: 'happy-a' });
    for (const [method, url] of [['GET', '/files/private-key-data'], ['GET', '/v1/connect/github/callback'], ['POST', '/v1/connect/github/webhook'], ['POST', '/logs-combined-from-cli-and-mobile-for-simple-ai-debugging']] as const) {
        expect((await f.app.inject({ method, url, headers: { authorization: 'Bearer signed-happy-token' } })).statusCode).toBe(403);
    }
    expect(f.unsafeHandler).not.toHaveBeenCalled(); expect(f.transport).toHaveBeenCalledTimes(1);
});

it('leaves only the explicit API login/display/version bootstrap endpoints public', async () => {
    const f = await setup();
    for (const [method, url] of [['GET', '/v1/tokenhub/config'], ['POST', '/v1/tokenhub/start'], ['POST', '/v1/tokenhub/complete'], ['POST', '/v1/version']] as const) {
        expect((await f.app.inject({ method, url })).statusCode).toBe(200);
    }
    expect(f.transport).not.toHaveBeenCalled();
});

it('attaches verified attribution to the HTTP request without accepting body or header identity claims', async () => {
    const f = await setup();
    const response = await f.app.inject({ method: 'POST', url: '/v2/trusted-context',
        headers: { authorization: 'Bearer signed-happy-token', 'x-tokenhub-subject': '99', 'x-tokenhub-session-id': 'attacker-session' },
        payload: { userId: 'attacker', tokenhub: { authority: 'https://evil.test', issuer: 'attacker', subject: '99', sessionId: 'attacker-session' } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: 'happy-a', expiresAt: expect.any(Number), tokenhub: { authority: 'https://accounts.example.test', issuer: 'tokenapi', subject: '42', sessionId: 'test-session' } });
});

it('attaches only the upstream user identity when unified authorization is disabled', async () => {
    const app = fastify();
    const authorization = createWorkAuthorization({ env: { TOKENHUB_UNIFIED_AUTH: 'false' }, verifyHappyToken: async () => ({ userId: 'upstream', extras: { tokenhub: { subject: 'forged', sessionId: 'unverified' } } }) });
    enableAuthentication(app as unknown as Fastify, authorization);
    app.get('/v1/context', { preHandler: app.authenticate }, async request => request.workSession);
    try { expect((await app.inject({ url: '/v1/context', headers: { authorization: 'Bearer legacy' } })).json()).toEqual({ userId: 'upstream' }); }
    finally { await app.close(); }
});
