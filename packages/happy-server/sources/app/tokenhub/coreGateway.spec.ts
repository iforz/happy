import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createCoreGateway, coreGatewayConfig } from './coreGateway';
const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); } });
const sse = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
const delta = sse({ choices: [{ delta: { content: 'Hello' } }] });
const usage = sse({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } });
const done = 'data: [DONE]\n\n';
async function fixture(stream = delta + usage + done, options: { slow?: boolean; status?: number } = {}) {
    const calls: Array<{ url: string; headers: import('node:http').IncomingHttpHeaders; body: string }> = [];
    const cancelled = vi.fn();
    const server = createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk;
        calls.push({ url: req.url!, headers: req.headers, body });
        if (options.status) { res.writeHead(options.status); res.end('sensitive upstream diagnostic'); return; }
        if (req.url?.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'real-model', privateKey: 'never-return' }] })); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(stream);
        if (options.slow) res.on('close', cancelled); else res.end();
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error();
    const gateway = createCoreGateway({ env: { TOKENHUB_GATEWAY_MODE: 'real', TOKENHUB_UNIFIED_AUTH: 'true', TOKENHUB_CORE_GATEWAY_URL: `http://127.0.0.1:${address.port}` }, timeoutMs: 500 });
    return { gateway, calls, cancelled };
}
async function collect(gateway: ReturnType<typeof createCoreGateway>, signal = new AbortController().signal) {
    const events = []; for await (const event of gateway.stream({ model: 'real-model', prompt: 'Hi' }, 'verified-core-grant', { ip: '::ffff:127.0.0.1', userAgent: 'Happy' }, signal)) events.push(event); return events;
}
it('defaults disabled, requires real+unified auth and pins literal loopback without redirects', () => {
    expect(coreGatewayConfig({}).enabled).toBe(false); expect(coreGatewayConfig({ TOKENHUB_GATEWAY_MODE: 'mock' }).enabled).toBe(false);
    for (const origin of ['https://evil.test', 'http://localhost:28080', 'http://127.0.0.1:28080/path', 'http://127.0.0.1:28080?x=y', 'http://u:p@127.0.0.1:28080']) expect(() => coreGatewayConfig({ TOKENHUB_GATEWAY_MODE: 'real', TOKENHUB_UNIFIED_AUTH: 'true', TOKENHUB_CORE_GATEWAY_URL: origin })).toThrow();
    expect(() => coreGatewayConfig({ TOKENHUB_GATEWAY_MODE: 'real' })).toThrow();
});
it('uses real HTTP Core paths, verified grant and a projected catalog; no provider key or ledger', async () => {
    const f = await fixture();
    expect(await f.gateway.models('verified-core-grant', {}, new AbortController().signal)).toEqual({ mode: 'real', billable: true, models: [{ id: 'real-model', name: 'real-model' }] });
    const events = await collect(f.gateway);
    expect(events).toEqual([{ type: 'delta', text: 'Hello' }, expect.objectContaining({ type: 'usage', inputTokens: 3, outputTokens: 2, accounting: 'core', mock: false, billable: true }), { type: 'done' }]);
    expect(f.calls.map(call => call.url)).toEqual(['/api/v1/work/models', '/api/v1/work/chat/completions']);
    expect(f.calls[1].headers.authorization).toBe('Bearer verified-core-grant'); expect(f.calls[1].headers['x-client-ip']).toBe('127.0.0.1');
    expect(JSON.parse(f.calls[1].body)).toEqual({ model: 'real-model', messages: [{ role: 'user', content: 'Hi' }], stream: true, stream_options: { include_usage: true } });
    expect(JSON.stringify(events)).not.toContain('verified-core-grant'); expect(f.gateway).not.toHaveProperty('ledger');
});
it.each([delta + done, delta + usage, delta + usage + usage + done, delta + usage + done + delta])('never reports success for missing/truncated/duplicate/trailing usage streams', async stream => {
    const f = await fixture(stream), events = await collect(f.gateway);
    expect(events.at(-1)?.type).toBe('error'); expect(events.some(event => event.type === 'done')).toBe(false); expect(f.calls).toHaveLength(1);
});
it('does not retry rate limits or expose upstream response content', async () => {
    const f = await fixture('', { status: 429 }), events = await collect(f.gateway);
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'rate_limited' })]); expect(f.calls).toHaveLength(1); expect(JSON.stringify(events)).not.toContain('sensitive');
});
it('rejects untrusted fields before any request', async () => {
    const f = await fixture();
    for await (const event of f.gateway.stream({ model: 'real-model', prompt: 'hi', userId: '999' } as never, 'grant', {}, new AbortController().signal)) expect(event.type).toBe('error');
    expect(f.calls).toHaveLength(0);
});
it('cancels the actual HTTP Core stream on caller abort', async () => {
    const f = await fixture(delta, { slow: true }), controller = new AbortController();
    const stream = f.gateway.stream({ model: 'real-model', prompt: 'Hi' }, 'grant', {}, controller.signal);
    expect((await stream.next()).value).toEqual({ type: 'delta', text: 'Hello' });
    controller.abort('authorization_revoked'); expect((await stream.next()).value).toMatchObject({ type: 'error', code: 'authorization_revoked' }); await stream.return(undefined);
    await vi.waitFor(() => expect(f.cancelled).toHaveBeenCalledOnce());
});
it('times out incomplete streams instead of treating EOF as settlement', async () => {
    const f = await fixture(delta, { slow: true }), events = await collect(f.gateway);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'gateway_timeout' }); expect(f.calls).toHaveLength(1);
});
it('passes a stable Work request UUID and uses Core response ID, without retrying 409', async () => {
    const id = '6f948430-bc83-4558-8cdc-a07e32061c7f';
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect((init?.headers as Record<string, string>)['X-Work-Request-ID']).toBe(id);
        expect(JSON.parse(String(init?.body))).not.toHaveProperty('requestId');
        return new Response(delta + usage + done, { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'core-authoritative-id' } });
    });
    const gateway = createCoreGateway({ env: { TOKENHUB_GATEWAY_MODE: 'real', TOKENHUB_UNIFIED_AUTH: 'true', TOKENHUB_CORE_GATEWAY_URL: 'http://127.0.0.1:28080' }, transport });
    const events = []; for await (const event of gateway.stream({ model: 'real-model', prompt: 'Hi', requestId: id }, 'grant', {}, new AbortController().signal)) events.push(event);
    expect(events[1]).toMatchObject({ requestId: id, coreRequestId: 'core-authoritative-id' }); expect(transport).toHaveBeenCalledOnce();
    const conflict = await fixture('', { status: 409 }); expect((await collect(conflict.gateway)).at(-1)).toMatchObject({ code: 'request_conflict' }); expect(conflict.calls).toHaveLength(1);
});

it('surfaces Core reconciliation without claiming completion or exposing diagnostics', async () => {
    const f = await fixture(delta + usage + sse({ error: { type: 'work_reconciliation_required', message: 'private diagnostic' } }));
    const events = await collect(f.gateway);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'work_reconciliation_required' });
    expect(events.some(event => event.type === 'done' || event.type === 'usage')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('private diagnostic');
});
it('passes actual relay events through the actual App client while keeping client UUID distinct from Core correlation', async () => {
    const { createWorkMockClient } = await import('../../../../happy-app/sources/integrations/tokenhub/workMockClient');
    const id = '6f948430-bc83-4558-8cdc-a07e32061c7f', coreId = 'a'.repeat(64);
    const gateway = createCoreGateway({ env: { TOKENHUB_GATEWAY_MODE: 'real', TOKENHUB_UNIFIED_AUTH: 'true', TOKENHUB_CORE_GATEWAY_URL: 'http://127.0.0.1:28080' },
        transport: async () => new Response(delta + usage + done, { headers: { 'content-type': 'text/event-stream', 'x-request-id': coreId } }),
    });
    const client = createWorkMockClient({ baseUrl: 'https://happy.example.test', tokenProvider: async () => 'signed-happy', fetch: async (url, init) => {
        if (url.endsWith('/models')) return new Response(JSON.stringify({ mode: 'real', billable: true, models: [{ id: 'real-model', name: 'Real' }] }), { headers: { 'content-type': 'application/json' } });
        const input = JSON.parse(String(init.body)), records = [];
        for await (const event of gateway.stream(input, 'core-grant', {}, new AbortController().signal)) records.push(JSON.stringify(event));
        return new Response(records.join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
    } });
    await client.listModels();
    const result = await client.stream({ model: 'real-model', prompt: 'Hi', requestId: id }, () => {});
    expect(result).toMatchObject({ requestId: id, coreRequestId: coreId, accounting: 'core', mock: false, inputTokens: 3 });
});

it('preserves full multi-turn roles with the exact selected model and existing accounting path',async()=>{
 const f=await fixture();
 const messages=[{role:'user' as const,content:'first'},{role:'assistant' as const,content:'answer'},{role:'user' as const,content:'follow up'}];
 const events=[];for await(const event of f.gateway.stream({model:'real-model',messages,requestId:'60a399cd-f49f-4064-8fe6-46d2d6d9c0d0'},'verified-core-grant',{},new AbortController().signal))events.push(event);
 expect(JSON.parse(f.calls[0].body).messages).toEqual(messages);
 expect(f.calls[0].headers['x-work-request-id']).toBe('60a399cd-f49f-4064-8fe6-46d2d6d9c0d0');
 expect(events.some(event=>event.type==='done')).toBe(true);
});
