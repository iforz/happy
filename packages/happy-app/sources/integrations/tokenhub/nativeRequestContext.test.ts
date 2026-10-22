import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { NATIVE_WORK_USER_AGENT, isSelectedWorkOrigin, nativeWorkFetch, nativeWorkSocketHeaders, nativeWorkSocketAllowed } from './nativeRequestContext';
import { workSocketHeaders as webSocketHeaders } from './requestContext';
const runtime = vi.hoisted(() => ({ blocked: false }));
vi.mock('./runtimeRestart.native', () => ({ requiresRuntimeRestart: () => runtime.blocked, RUNTIME_RESTART_MESSAGE: 'runtime stopped' }));
beforeEach(() => { runtime.blocked = false; });
afterEach(() => vi.unstubAllGlobals());

it.each(['https://happy.example.test.evil.test/v1', 'https://evil.test/?next=https://happy.example.test', 'https://happy.example.test:444/v1', 'http://happy.example.test/v1', 'https://user:password@happy.example.test/v1'])('never changes third-party or mismatched origin %s', async url => {
    expect(isSelectedWorkOrigin(url, 'https://happy.example.test')).toBe(false);
    const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}')), init = { headers: { Authorization: 'already-specified' } };
    await nativeWorkFetch(transport as typeof fetch, () => 'https://happy.example.test')(url, init);
    expect(transport).toHaveBeenCalledWith(url, init); expect(nativeWorkSocketHeaders(url, 'https://happy.example.test')).toBeUndefined();
});
it('sets an explicit app UA only for the selected origin and keeps credentials/body/abort intact', async () => {
    const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}')); let server = 'https://happy.example.test';
    const wrapped = nativeWorkFetch(transport as typeof fetch, () => server);
    const signal = new AbortController().signal;
    await wrapped(server + '/v1/test', { method: 'POST', headers: { Authorization: 'Bearer token', 'User-Agent': 'a different UA' }, body: '{}', signal });
    const init = transport.mock.calls[0][1]!; expect(new Headers(init.headers).get('user-agent')).toBe(NATIVE_WORK_USER_AGENT);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer token'); expect(init.body).toBe('{}'); expect(init.signal).toBe(signal);
    server = 'https://other.example.test'; await wrapped('https://happy.example.test/v1/test', { headers: { 'User-Agent': 'unchanged' } });
    expect(transport.mock.calls[1][1]!.headers).toEqual({ 'User-Agent': 'unchanged' });
    expect(webSocketHeaders('https://happy.example.test')).toBeUndefined();
});
it('handles Fetch Request header replacement semantics without dropping an existing bearer', async () => {
    const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}')), wrapped = nativeWorkFetch(transport as typeof fetch, () => 'https://happy.example.test');
    const request = new Request('https://happy.example.test/v1/test', { headers: { Authorization: 'Bearer token' } });
    await wrapped(request); expect(new Headers(transport.mock.calls[0][1]!.headers).get('authorization')).toBe('Bearer token');
    await wrapped(request, { headers: { 'X-Explicit': 'replacement' } });
    expect(new Headers(transport.mock.calls[1][1]!.headers).has('authorization')).toBe(false);
});
it('delivers the same app UA over real loopback HTTP and installed Socket.IO WebSocket extraHeaders', async () => {
    let httpUA: string | undefined, socketUA: string | undefined;
    const server = createServer((request, response) => { httpUA = request.headers['user-agent']; response.end('ok'); });
    const sockets = new Server(server, { path: '/v1/updates', transports: ['websocket'] });
    sockets.on('connection', socket => { socketUA = socket.handshake.headers['user-agent']; socket.emit('context', socketUA); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback listener');
    const origin = `http://127.0.0.1:${address.port}`;
    const client = io(origin, { path: '/v1/updates', transports: ['websocket'], extraHeaders: nativeWorkSocketHeaders(origin, origin), autoConnect: false, reconnection: false });
    try {
        await nativeWorkFetch(fetch, () => origin)(origin + '/health');
        const context = new Promise<string>((resolve, reject) => { client.on('context', resolve); client.on('connect_error', reject); });
        client.connect(); expect(await context).toBe(NATIVE_WORK_USER_AGENT); expect(httpUA).toBe(NATIVE_WORK_USER_AGENT); expect(socketUA).toBe(httpUA);
    } finally { client.disconnect(); await new Promise<void>(resolve => sockets.close(() => resolve())); }
});
it('the installed Engine.IO React Native branch passes extraHeaders to native WebSocket options', async () => {
    const construct = vi.fn();
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    vi.stubGlobal('WebSocket', class { binaryType = ''; constructor(...args: unknown[]) { construct(...args); } close() {} });
    // Separate module evaluation ensures the installed React Native detection sees the native fixture.
    // @ts-expect-error Vitest query forces a new module evaluation; declarations have no query suffix.
    const { WS } = await import('../../../../../node_modules/engine.io-client/build/esm/transports/websocket.js?native-context-test');
    const transport = new WS({ hostname: 'happy.example.test', port: '443', secure: true, path: '/v1/updates/', query: {}, socket: { binaryType: 'arraybuffer' },
        extraHeaders: nativeWorkSocketHeaders('https://happy.example.test', 'https://happy.example.test') });
    transport.doOpen();
    expect(construct).toHaveBeenCalledWith(expect.stringContaining('wss://happy.example.test'), undefined, { headers: { 'User-Agent': NATIVE_WORK_USER_AGENT } });
    transport.doClose();
});

it('blocks old Work HTTP and native socket creation locally after invalidation, without changing third-party requests', async () => {
    const transport = vi.fn(async () => new Response('{}'));
    const wrapped = nativeWorkFetch(transport as typeof fetch, () => 'https://happy.example.test');
    runtime.blocked = true;
    await expect(wrapped('https://happy.example.test/v1/sessions', { headers: { Authorization: 'Bearer old' } })).rejects.toThrow('runtime stopped');
    await expect(wrapped('https://happy.example.test/v1/tokenhub/native/start')).rejects.toThrow('runtime stopped');
    expect(nativeWorkSocketAllowed('wss://happy.example.test', 'https://happy.example.test')).toBe(false);
    expect(() => nativeWorkSocketHeaders('https://happy.example.test', 'https://happy.example.test')).toThrow('runtime stopped');
    expect(transport).not.toHaveBeenCalled();
    const init = { headers: { 'X-Third-Party': 'unchanged' } };
    await wrapped('https://other.example.test/public', init);
    expect(transport).toHaveBeenCalledWith('https://other.example.test/public', init);
    expect(nativeWorkSocketAllowed('https://other.example.test', 'https://happy.example.test')).toBe(true);
});
