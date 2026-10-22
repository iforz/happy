import { afterEach, expect, it, vi } from 'vitest';
import { createMockGateway, mockGatewayConfig, type MockEvent, type MockIdentity } from './mockGateway';
import { createMockProvider } from './mockProvider';

const identity: MockIdentity = { userId: 'verified-happy-user', authority: 'https://accounts.example.test', issuer: 'tokenapi', subject: '42', sessionId: 'verified-core-session' };
const env = (origin = 'http://127.0.0.1:3099') => ({ TOKENHUB_GATEWAY_MODE: 'mock', TOKENHUB_UNIFIED_AUTH: 'true', TOKENHUB_MOCK_GATEWAY_URL: origin });
const servers: ReturnType<typeof createMockProvider>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function provider(hooks: Parameters<typeof createMockProvider>[0] = {}) {
    const server = createMockProvider({ chunkDelayMs: 1, ...hooks }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
    return `http://127.0.0.1:${address.port}`;
}
async function collect(stream: AsyncIterable<MockEvent>) { const events: MockEvent[] = []; for await (const event of stream) events.push(event); return events; }
const response = (events: unknown[]) => new Response(events.map(event => JSON.stringify(event) + '\n').join(''), { headers: { 'content-type': 'application/x-ndjson', 'x-tokenhub-mock': 'true' } });

it('is disabled by default and rejects real/ambiguous modes, hosts, paths, credentials and redirects', () => {
    expect(mockGatewayConfig({})).toEqual({ enabled: false });
    expect(mockGatewayConfig({ TOKENHUB_GATEWAY_MODE: 'disabled' })).toEqual({ enabled: false });
    expect(() => mockGatewayConfig({ ...env(), TOKENHUB_GATEWAY_MODE: 'production' })).toThrow();
    expect(() => mockGatewayConfig({ ...env(), TOKENHUB_UNIFIED_AUTH: 'false' })).toThrow();
    for (const origin of ['https://127.0.0.1:3099', 'http://localhost:3099', 'http://2130706433:3099', 'http://127.1:3099', 'http://127.0.0.1:3099/', 'http://127.0.0.1:3099?q=x', 'http://user@127.0.0.1:3099', 'http://example.test:3099', 'http://127.0.0.1:99999']) expect(() => mockGatewayConfig(env(origin))).toThrow();
});

it('transmits chosen model, streams chunks and attributes synthetic usage only to server-verified identity', async () => {
    const seen = vi.fn();
    const gateway = createMockGateway({ env: env(await provider({ onRequest: seen })) });
    const events = await collect(gateway.stream({ model: 'mock-echo', prompt: 'Hello 世界' }, identity, new AbortController().signal));
    expect(seen).toHaveBeenCalledWith({ model: 'mock-echo', prompt: 'Hello 世界', requestId: expect.any(String) });
    expect(events.filter(event => event.type === 'delta')).toHaveLength(4);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(events.at(-2)).toMatchObject({ type: 'usage', model: 'mock-echo', mock: true, billable: false });
    expect(gateway.ledger.snapshot()).toEqual([{ ...identity, requestId: expect.any(String), model: 'mock-echo', inputTokens: 2, outputTokens: expect.any(Number), mock: true, billable: false }]);
    expect(JSON.stringify(events)).not.toContain(identity.userId);
    expect(JSON.stringify(events)).not.toContain(identity.sessionId);
});

it('pins the loopback destination and never forwards auth or browser identity/usage fields', async () => {
    const configuration = env();
    const transport = vi.fn(async () => response([{ type: 'usage', inputTokens: 1, outputTokens: 2 }, { type: 'done' }]));
    const gateway = createMockGateway({ env: configuration, transport });
    configuration.TOKENHUB_MOCK_GATEWAY_URL = 'http://evil.test:1234';
    await collect(gateway.stream({ model: 'mock-slow', prompt: 'test' }, identity, new AbortController().signal));
    expect(transport).toHaveBeenCalledWith('http://127.0.0.1:3099/v1/mock/completions', expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
    const init = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.keys(JSON.parse(String(init[1].body))).sort()).toEqual(['model', 'prompt', 'requestId']);
    expect(new Headers(init[1].headers).has('authorization')).toBe(false);
});

it('propagates abort to the actual local provider and records no completed usage', async () => {
    const cancelled = vi.fn();
    const gateway = createMockGateway({ env: env(await provider({ chunkDelayMs: 500, onCancel: cancelled })) });
    const controller = new AbortController();
    const iterator = gateway.stream({ model: 'mock-slow', prompt: 'cancel me' }, identity, controller.signal);
    expect((await iterator.next()).value).toMatchObject({ type: 'delta' });
    controller.abort();
    expect((await iterator.next()).value).toMatchObject({ type: 'error', code: 'cancelled' });
    await iterator.return(undefined);
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(gateway.ledger.snapshot()).toEqual([]);
});

it('stops buffered chunks immediately after authorization revocation', async () => {
    const gateway = createMockGateway({ env: env(), transport: async () => response([{ type: 'delta', text: 'first' }, { type: 'delta', text: 'must not arrive' }, { type: 'usage', inputTokens: 1, outputTokens: 2 }, { type: 'done' }]) });
    const controller = new AbortController();
    const iterator = gateway.stream({ model: 'mock-echo', prompt: 'test' }, identity, controller.signal);
    expect((await iterator.next()).value).toEqual({ type: 'delta', text: 'first' });
    controller.abort('authorization_revoked');
    expect((await iterator.next()).value).toMatchObject({ type: 'error', code: 'authorization_revoked' });
    await iterator.return(undefined); expect(gateway.ledger.snapshot()).toEqual([]);
});

it('sanitizes provider failures and does not invent completed usage', async () => {
    const gateway = createMockGateway({ env: env(await provider()) });
    expect(await collect(gateway.stream({ model: 'mock-error', prompt: 'test' }, identity, new AbortController().signal))).toEqual([{ type: 'error', code: 'mock_upstream_error', message: 'Mock upstream failed or returned an invalid stream.' }]);
    expect(gateway.ledger.snapshot()).toEqual([]);
});

it.each([
    [{ type: 'delta', text: 'truncated' }],
    [{ type: 'done' }],
    [{ type: 'usage', inputTokens: -1, outputTokens: 2 }, { type: 'done' }],
    [{ type: 'usage', inputTokens: 1, outputTokens: 2, userId: 'forged' }, { type: 'done' }],
    [{ type: 'usage', inputTokens: 1, outputTokens: 2 }, { type: 'delta', text: 'after usage' }, { type: 'done' }],
    [{ type: 'usage', inputTokens: 1, outputTokens: 2 }, { type: 'done' }, { type: 'delta', text: 'after done' }],
])('rejects incomplete, forged or out-of-order provider protocols: %j', async (...events) => {
    const gateway = createMockGateway({ env: env(), transport: async () => response(events) });
    const result = await collect(gateway.stream({ model: 'mock-echo', prompt: 'test' }, identity, new AbortController().signal));
    expect(result.at(-1)).toMatchObject({ type: 'error' }); expect(gateway.ledger.snapshot()).toEqual([]);
});

it('bounds a stalled stream and cancels its reader', async () => {
    const cancelled = vi.fn();
    const gateway = createMockGateway({ env: env(), timeoutMs: 15, transport: async () => new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'content-type': 'application/x-ndjson', 'x-tokenhub-mock': 'true' } }) });
    const events = await collect(gateway.stream({ model: 'mock-echo', prompt: 'test' }, identity, new AbortController().signal));
    expect(events).toEqual([{ type: 'error', code: 'gateway_timeout', message: 'Mock gateway timed out.' }]);
    expect(cancelled).toHaveBeenCalled(); expect(gateway.ledger.snapshot()).toEqual([]);
});


it('rejects an unmarked local service instead of treating it as a mock provider', async () => {
    const gateway = createMockGateway({ env: env(), transport: async () => new Response('{"type":"usage","inputTokens":1,"outputTokens":2}\n{"type":"done"}\n', { headers: { 'content-type': 'application/x-ndjson' } }) });
    const events = await collect(gateway.stream({ model: 'mock-echo', prompt: 'test' }, identity, new AbortController().signal));
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'mock_upstream_error' }); expect(gateway.ledger.snapshot()).toEqual([]);
});

it('caps the provider response and releases its reader without recording usage', async () => {
    const cancelled = vi.fn();
    const gateway = createMockGateway({ env: env(), transport: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel: cancelled,
    }), { headers: { 'content-type': 'application/x-ndjson', 'x-tokenhub-mock': 'true' } }) });
    const events = await collect(gateway.stream({ model: 'mock-echo', prompt: 'test' }, identity, new AbortController().signal));
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'mock_upstream_error' }); expect(cancelled).toHaveBeenCalled(); expect(gateway.ledger.snapshot()).toEqual([]);
});
