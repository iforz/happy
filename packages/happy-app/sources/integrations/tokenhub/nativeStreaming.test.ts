import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('expo/fetch', () => ({ fetch: fixture.fetch }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://happy.example.test' }));
import { tokenHubFetch } from './transport.native';
import { createWorkMockClient } from './workMockClient';
beforeEach(() => { fixture.fetch.mockReset(); });

it('injects Expo fetch and exposes chunks before EOF, then cancels the native request and reader', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = vi.fn();
    fixture.fetch.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel: cancelled }), { headers: { 'content-type': 'application/x-ndjson' } }));
    const client = createWorkMockClient({ baseUrl: 'https://happy.example.test', tokenProvider: async () => 'happy-token', fetch: tokenHubFetch });
    const controller = new AbortController(), chunks: string[] = [];
    const pending = client.stream({ model: 'mock-slow', prompt: 'synthetic' }, chunk => chunks.push(chunk), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    await vi.waitFor(() => expect(fixture.fetch).toHaveBeenCalled());
    source.enqueue(new TextEncoder().encode('{"type":"delta","text":"first native chunk"}\n'));
    await vi.waitFor(() => expect(chunks).toEqual(['first native chunk']));
    source.enqueue(new TextEncoder().encode('{"type":"delta","text":"second native chunk"}\n'));
    await vi.waitFor(() => expect(chunks).toHaveLength(2));
    controller.abort(); await rejected;
    expect(new Headers(fixture.fetch.mock.calls[0][1].headers).get('User-Agent')).toBe('TokenHubWorkNative/1');
    expect(new Headers(fixture.fetch.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer happy-token');
    expect(cancelled).toHaveBeenCalledOnce(); expect(fixture.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fixture.fetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error', headers: expect.any(Headers) });
});
