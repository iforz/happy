import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createWorkMockClient, WorkMockError, WORK_MOCK_MAX_RESPONSE_BYTES, WORK_MOCK_REQUEST_TIMEOUT_MS,
    WORK_REAL_REQUEST_TIMEOUT_MS, WORK_REAL_MAX_RESPONSE_BYTES, WORK_REAL_MAX_LINE_LENGTH,
    type WorkMockClientOptions,
} from './workMockClient';

const catalog = { mode: 'mock', billable: false, models: [
    { id: 'mock-echo', name: 'Mock echo' }, { id: 'mock-slow', name: 'Mock slow stream' },
    { id: 'mock-error', name: 'Mock upstream error' },
] };
const usage = { type: 'usage', inputTokens: 4, outputTokens: 6, model: 'mock-slow', requestId: 'mock-request-1', mock: true, billable: false };
const input = { model: 'mock-slow', prompt: '测试 slow model' };
const done = { type: 'done' };
function ndjson(events: unknown[]) { return events.map(event => JSON.stringify(event)).join('\n') + '\n'; }
function streamResponse(text = ndjson([{ type: 'delta', text: 'Hello ' }, { type: 'delta', text: '世界' }, usage, done])) {
    return new Response(text, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
}
function setup(response: Response = streamResponse()) {
    const fetch = vi.fn<NonNullable<WorkMockClientOptions['fetch']>>().mockImplementation(async () => response);
    const tokenProvider = vi.fn<WorkMockClientOptions['tokenProvider']>().mockResolvedValue('synthetic-happy-token');
    const client = createWorkMockClient({ baseUrl: 'https://happy.example.test/', fetch, tokenProvider });
    return { client, fetch, tokenProvider };
}
function openStream() {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel }), {
        headers: { 'content-type': 'application/x-ndjson' },
    });
    return { response, source, cancel };
}
afterEach(() => vi.useRealTimers());

describe('isolated Happy Work mock gateway client', () => {
    it('is opt-in and fetches only the authenticated non-billable mock catalog', async () => {
        const { client, fetch, tokenProvider } = setup(new Response(JSON.stringify(catalog), { headers: { 'content-type': 'application/json' } }));
        expect(fetch).not.toHaveBeenCalled(); expect(tokenProvider).not.toHaveBeenCalled();
        await expect(client.listModels()).resolves.toEqual(catalog.models);
        expect(fetch).toHaveBeenCalledWith('https://happy.example.test/v1/tokenhub/work/models', expect.objectContaining({
            method: 'GET', headers: { Authorization: 'Bearer synthetic-happy-token', Accept: 'application/json' },
            credentials: 'omit', redirect: 'error', cache: 'no-store',
        }));
        expect(fetch.mock.calls[0][1]).not.toHaveProperty('body');
    });

    it('sends exactly selected model and prompt, not browser identity, usage or secret fields', async () => {
        const { client, fetch } = setup();
        const onDelta = vi.fn();
        const extraInput = { ...input, userId: 'untrusted', sessionId: 'untrusted', subject: 'untrusted', inputTokens: 999, secret: 'never-send' };
        const result = await client.stream(extraInput, onDelta);
        expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual(input);
        expect(fetch).toHaveBeenCalledWith('https://happy.example.test/v1/tokenhub/work/stream', expect.objectContaining({
            method: 'POST', headers: { Authorization: 'Bearer synthetic-happy-token', Accept: 'application/x-ndjson', 'Content-Type': 'application/json' },
            credentials: 'omit', redirect: 'error', cache: 'no-store',
        }));
        expect(onDelta.mock.calls).toEqual([['Hello '], ['世界']]);
        expect(result).toEqual({ inputTokens: 4, outputTokens: 6, model: 'mock-slow', requestId: 'mock-request-1', mock: true, billable: false });
    });

    it('delivers chunks before stream completion and handles fragmented UTF-8/JSON records', async () => {
        const { response, source } = openStream();
        const { client } = setup(response);
        const onDelta = vi.fn();
        const result = client.stream(input, onDelta);
        const bytes = new TextEncoder().encode(ndjson([{ type: 'delta', text: '你好🌍' }]));
        // Splitting every byte exercises multibyte decoder state and incomplete JSON lines.
        for (const byte of bytes) source.enqueue(new Uint8Array([byte]));
        await vi.waitFor(() => expect(onDelta).toHaveBeenCalledWith('你好🌍'));
        source.enqueue(new TextEncoder().encode(ndjson([usage, done])));
        source.close();
        await expect(result).resolves.toMatchObject({ mock: true, billable: false });
    });

    it('projects only display-safe usage and catalog fields', async () => {
        const { client } = setup(streamResponse(ndjson([{ ...usage, userId: 'private', sessionId: 'private', subject: 'private' }, done])));
        const result = await client.stream(input, () => {});
        expect(Object.keys(result).sort()).toEqual(['billable', 'inputTokens', 'mock', 'model', 'outputTokens', 'requestId']);
        const projected = setup(new Response(JSON.stringify({ ...catalog, models: [{ ...catalog.models[0], subject: 'private' }] }), { headers: { 'content-type': 'application/json' } }));
        await expect(projected.client.listModels()).resolves.toEqual([catalog.models[0]]);
    });

    it.each([
        { ...catalog, billable: true }, { ...catalog, mode: 'live' }, { ...catalog, models: [] },
        { ...catalog, models: [{ id: 'real-model', name: 'Real model' }] },
        { ...catalog, models: [catalog.models[0], catalog.models[0]] },
        { ...catalog, models: [{ id: 'mock-echo', name: '' }] },
    ])('rejects malformed or non-mock catalogs', async body => {
        const { client } = setup(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
        await expect(client.listModels()).rejects.toMatchObject({ kind: 'invalid_response' });
    });

    it.each([
        { model: 'real-model', prompt: 'hello' }, { model: 'mock-echo', prompt: '' },
        { model: 'mock-echo', prompt: '   ' }, { model: 'mock-echo', prompt: 'x'.repeat(4001) },
    ])('rejects invalid input before reading credentials or fetching', async request => {
        const { client, fetch, tokenProvider } = setup();
        await expect(client.stream(request, () => {})).rejects.toMatchObject({ kind: 'invalid_request' });
        expect(fetch).not.toHaveBeenCalled(); expect(tokenProvider).not.toHaveBeenCalled();
    });

    it.each([[401, 'authentication'], [403, 'forbidden'], [429, 'rate_limit'], [503, 'unavailable'], [500, 'http']] as const)
    ('handles HTTP %s without exposing bodies or retrying', async (status, kind) => {
        const { client, fetch } = setup(new Response('sensitive upstream diagnostics', { status }));
        await expect(client.stream(input, () => {})).rejects.toMatchObject({ kind, status, message: `Work mock request failed (${kind})` });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('handles simulated upstream errors after partial content without reporting success', async () => {
        const { client } = setup(streamResponse(ndjson([{ type: 'delta', text: 'partial' }, { type: 'error', code: 'mock_upstream_error', message: 'private detail' }])));
        const onDelta = vi.fn();
        await expect(client.stream(input, onDelta)).rejects.toMatchObject({ kind: 'upstream', message: 'Work mock request failed (upstream)' });
        expect(onDelta).toHaveBeenCalledWith('partial');
    });

    it.each([['authorization_revoked', 'authentication'], ['gateway_timeout', 'timeout'], ['cancelled', 'aborted'], ['unexpected_server_error', 'upstream']] as const)
    ('classifies stream error %s without exposing server diagnostics', async (code, kind) => {
        const { client } = setup(streamResponse(ndjson([{ type: 'error', code, message: 'private details' }])));
        await expect(client.stream(input, () => {})).rejects.toMatchObject({ kind, message: `Work mock request failed (${kind})` });
    });

    it.each(['', ndjson([{ type: 'delta', text: 'partial' }]), ndjson([usage])])('never treats premature EOF as success', async text => {
        await expect(setup(streamResponse(text)).client.stream(input, () => {})).rejects.toMatchObject({ kind: 'truncated_stream' });
    });

    it.each([
        '{"type":', 'not json\n', ndjson([done]), ndjson([usage, usage, done]),
        ndjson([usage, { type: 'delta', text: 'too late' }, done]), ndjson([usage, done, done]),
        ndjson([{ type: 'unknown' }]), ndjson([{ type: 'delta', text: 5 }]),
        ndjson([{ ...usage, model: 'mock-echo' }, done]), ndjson([{ ...usage, billable: true }, done]),
        ndjson([{ ...usage, inputTokens: -1 }, done]), ndjson([{ ...usage, outputTokens: 1.2 }, done]),
        ndjson([{ ...usage, requestId: '' }, done]),
    ])('rejects malformed streams and event ordering', async text => {
        await expect(setup(streamResponse(text)).client.stream(input, () => {})).rejects.toMatchObject({ kind: 'invalid_response' });
    });

    it('accepts a complete final NDJSON event without trailing newline', async () => {
        await expect(setup(streamResponse(ndjson([usage]) + JSON.stringify(done))).client.stream(input, () => {})).resolves.toMatchObject({ mock: true });
    });

    it('rejects incorrect content type and malformed UTF-8', async () => {
        await expect(setup(new Response(ndjson([usage, done]), { headers: { 'content-type': 'text/html' } })).client.stream(input, () => {})).rejects.toMatchObject({ kind: 'invalid_response' });
        await expect(setup(new Response(new Uint8Array([255, 254]), { headers: { 'content-type': 'application/x-ndjson' } })).client.stream(input, () => {})).rejects.toMatchObject({ kind: 'invalid_response' });
    });

    it('bounds individual lines and total response bytes', async () => {
        await expect(setup(streamResponse('x'.repeat(16 * 1024 + 1))).client.stream(input, () => {})).rejects.toMatchObject({ kind: 'response_limit' });
        await expect(setup(streamResponse(' '.repeat(WORK_MOCK_MAX_RESPONSE_BYTES + 1))).client.stream(input, () => {})).rejects.toMatchObject({ kind: 'response_limit' });
        const response = streamResponse();
        response.headers.set('content-length', String(WORK_MOCK_MAX_RESPONSE_BYTES + 1));
        await expect(setup(response).client.stream(input, () => {})).rejects.toMatchObject({ kind: 'response_limit' });
    });

    it('honors pre-abort without touching credentials or network', async () => {
        const { client, fetch, tokenProvider } = setup();
        const controller = new AbortController(); controller.abort();
        await expect(client.stream(input, () => {}, controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
        expect(fetch).not.toHaveBeenCalled(); expect(tokenProvider).not.toHaveBeenCalled();
    });

    it('cancels a stalled credential provider immediately without making a request', async () => {
        const { client, fetch, tokenProvider } = setup();
        const controller = new AbortController();
        tokenProvider.mockReturnValue(new Promise(() => {}));
        const result = client.stream(input, () => {}, controller.signal);
        controller.abort();
        await expect(result).rejects.toMatchObject({ kind: 'aborted' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('aborts a pending read, cancels the stream and does not emit any later data', async () => {
        const { response, source, cancel } = openStream();
        const { client, fetch } = setup(response);
        const controller = new AbortController(); const onDelta = vi.fn();
        const result = client.stream(input, onDelta, controller.signal);
        source.enqueue(new TextEncoder().encode(ndjson([{ type: 'delta', text: 'partial' }])));
        await vi.waitFor(() => expect(onDelta).toHaveBeenCalledOnce());
        controller.abort();
        await expect(result).rejects.toMatchObject({ kind: 'aborted' });
        expect((fetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
        expect(cancel).toHaveBeenCalledOnce(); expect(onDelta).toHaveBeenCalledTimes(1);
    });

    it('cleans up a late response from a transport that ignores abort', async () => {
        const { response, cancel } = openStream();
        const { client, fetch } = setup();
        let resolve!: (value: Response) => void;
        fetch.mockReturnValue(new Promise<Response>(callback => { resolve = callback; }));
        const controller = new AbortController();
        const result = client.stream(input, () => {}, controller.signal);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
        controller.abort(); await expect(result).rejects.toMatchObject({ kind: 'aborted' });
        resolve(response);
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    });

    it('times out a stalled response instead of hanging indefinitely', async () => {
        vi.useFakeTimers();
        const { response, cancel } = openStream();
        const { client } = setup(response);
        const rejected = expect(client.stream(input, () => {})).rejects.toMatchObject({ kind: 'timeout' });
        await vi.advanceTimersByTimeAsync(WORK_MOCK_REQUEST_TIMEOUT_MS);
        await rejected;
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('obtains fresh credentials each request and sanitizes failures', async () => {
        const { client, fetch, tokenProvider } = setup();
        fetch.mockImplementation(async () => streamResponse());
        await client.stream(input, () => {}); await client.stream(input, () => {});
        expect(tokenProvider).toHaveBeenCalledTimes(2);
        fetch.mockRejectedValue(new Error('secret auth token in network diagnostics'));
        await expect(client.stream(input, () => {})).rejects.toMatchObject({ kind: 'network', message: 'Work mock request failed (network)' });
        tokenProvider.mockRejectedValue(new Error('secret encryption identity'));
        await expect(client.stream(input, () => {})).rejects.toMatchObject({ kind: 'authentication' });
    });

    it.each([null, '', ' ', 'two words', 'line\nbreak'])('rejects unusable existing auth credentials', async value => {
        const { client, fetch, tokenProvider } = setup(); tokenProvider.mockResolvedValue(value);
        await expect(client.stream(input, () => {})).rejects.toMatchObject({ kind: 'authentication' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each(['http://external.example.test', 'https://user:secret@happy.example.test', 'https://happy.example.test/?token=x', 'https://happy.example.test/#x', 'bad-url'])
    ('rejects unsafe destinations before any network access: %s', baseUrl => {
        const tokenProvider = vi.fn();
        expect(() => createWorkMockClient({ baseUrl, tokenProvider })).toThrow(WorkMockError);
        expect(tokenProvider).not.toHaveBeenCalled();
    });

    it.each(['http://127.0.0.1:3005', 'http://localhost:3005', 'http://[::1]:3005'])('permits local loopback development: %s', baseUrl => {
        expect(() => createWorkMockClient({ baseUrl, tokenProvider: async () => 'test' })).not.toThrow();
    });
});

const realCatalog = { mode: 'real', billable: true, models: [{ id: 'provider/model', name: 'Real model' }] };
const realId = '11111111-1111-4111-8111-111111111111';
const realInput = { model: 'provider/model', prompt: 'hello', requestId: realId };
const realUsage = { type: 'usage', ...realInput, inputTokens: 3, outputTokens: 5, mock: false, billable: true, accounting: 'core' };
async function realSetup(events: unknown[] = [realUsage, done]) {
    const state = setup();
    state.fetch.mockImplementation(async url => url.endsWith('/models')
        ? new Response(JSON.stringify(realCatalog), { headers: { 'content-type': 'application/json' } })
        : streamResponse(ndjson(events)));
    await expect(state.client.getCatalog()).resolves.toEqual(realCatalog);
    return state;
}
describe('opt-in real Work gateway client', () => {
    it('sends only model, prompt and UUID, and projects Core usage as display counts', async () => {
        const { client, fetch } = await realSetup();
        const result = await client.stream({ ...realInput, identity: 'forbidden', apiKey: 'forbidden' } as typeof realInput, () => {});
        expect(JSON.parse(fetch.mock.calls[1][1].body as string)).toEqual(realInput);
        expect(result).toEqual({ model: realInput.model, requestId: realId, inputTokens: 3, outputTokens: 5, mock: false, billable: true, accounting: 'core' });
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it.each([undefined, 'not-a-uuid', '11111111-1111-1111-1111-111111111111'])('rejects invalid real request ID %s before transport', async requestId => {
        const { client, fetch } = await realSetup();
        await expect(client.stream({ ...realInput, requestId }, () => {})).rejects.toMatchObject({ kind: 'invalid_request' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it('rejects a model absent from the real catalog', async () => {
        const { client, fetch } = await realSetup();
        await expect(client.stream({ ...realInput, model: 'not-allowed' }, () => {})).rejects.toMatchObject({ kind: 'invalid_request' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it.each([
        { ...realUsage, requestId: '22222222-2222-4222-8222-222222222222' },
        { ...realUsage, accounting: undefined }, { ...realUsage, billable: false }, { ...realUsage, mock: true },
    ])('rejects mismatched or non-authoritative usage metadata', async event => {
        const { client } = await realSetup([event, done]);
        await expect(client.stream(realInput, () => {})).rejects.toMatchObject({ kind: 'invalid_response' });
    });
    it.each(['usage_unavailable', 'request_conflict', 'rate_limit', 'core_gateway_error', 'quota_exceeded', 'forbidden', 'work_reconciliation_required'])('sanitizes %s and never retries', async code => {
        const { client, fetch } = await realSetup([{ type: 'error', code, message: 'private core diagnostic' }]);
        await expect(client.stream(realInput, () => {})).rejects.toMatchObject({ kind: code });
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it('does not accept missing usage as completion', async () => {
        const { client } = await realSetup([{ type: 'delta', text: 'partial paid output' }]);
        await expect(client.stream(realInput, () => {})).rejects.toMatchObject({ kind: 'truncated_stream' });
    });
    it.each([['access_or_quota_denied', 'forbidden'], ['rate_limited', 'rate_limit']] as const)('maps Core alias %s safely', async (code, kind) => {
        const { client, fetch } = await realSetup([{ type: 'error', code, message: 'private' }]);
        await expect(client.stream(realInput, () => {})).rejects.toMatchObject({ kind });
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it.each([[402, 'quota_exceeded'], [403, 'forbidden'], [409, 'request_conflict'], [429, 'rate_limit']] as const)('maps real HTTP %s without exposing diagnostic bodies', async (status, kind) => {
        const { client, fetch } = await realSetup();
        fetch.mockResolvedValue(new Response('private core diagnostic', { status }));
        await expect(client.stream(realInput, () => {})).rejects.toMatchObject({ kind, status });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('allows real deltas larger than the mock line limit', async () => {
        const onDelta = vi.fn();
        const { client } = await realSetup([{ type: 'delta', text: 'x'.repeat(64 * 1024) }, realUsage, done]);
        await expect(client.stream(realInput, onDelta)).resolves.toMatchObject({ accounting: 'core' });
        expect(onDelta).toHaveBeenCalledWith('x'.repeat(64 * 1024));
    });
    it('bounds real response and line limits independently from mock limits', async () => {
        const { client, fetch } = await realSetup();
        fetch.mockResolvedValue(streamResponse('x'.repeat(WORK_REAL_MAX_LINE_LENGTH + 1)));
        await expect(client.stream(realInput, () => {})).rejects.toMatchObject({ kind: 'response_limit' });
        const oversized = streamResponse(); oversized.headers.set('content-length', String(WORK_REAL_MAX_RESPONSE_BYTES + 1));
        fetch.mockResolvedValue(oversized);
        await expect(client.stream(realInput, () => {})).rejects.toMatchObject({ kind: 'response_limit' });
    });
    it('uses the real 120-second timeout rather than the mock timeout', async () => {
        const { client, fetch } = await realSetup();
        vi.useFakeTimers();
        const pending = openStream(); fetch.mockResolvedValue(pending.response);
        const rejected = expect(client.stream(realInput, () => {})).rejects.toMatchObject({ kind: 'timeout' });
        await vi.advanceTimersByTimeAsync(WORK_MOCK_REQUEST_TIMEOUT_MS);
        expect(pending.cancel).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(WORK_REAL_REQUEST_TIMEOUT_MS - WORK_MOCK_REQUEST_TIMEOUT_MS);
        await rejected; expect(pending.cancel).toHaveBeenCalledOnce();
    });
    it('accepts bounded real catalogs larger than mock catalog limits', async () => {
        const models = Array.from({ length: 1000 }, (_, i) => ({ id: `model-${i}`, name: `Model ${i}` }));
        const { client } = setup(new Response(JSON.stringify({ ...realCatalog, models }), { headers: { 'content-type': 'application/json' } }));
        expect((await client.getCatalog()).models).toHaveLength(1000);
    });

    it('projects a safe Core correlation ID separately from the client UUID', async () => {
        const { client } = await realSetup([{ ...realUsage, coreRequestId: 'a'.repeat(64) }, done]);
        await expect(client.stream(realInput, () => {})).resolves.toMatchObject({ requestId: realId, coreRequestId: 'a'.repeat(64) });
    });
    it.each(['unsafe id', 'x'.repeat(129), 123])('rejects unsafe Core correlation ID %s', async coreRequestId => {
        const { client } = await realSetup([{ ...realUsage, coreRequestId }, done]);
        await expect(client.stream(realInput, () => {})).rejects.toMatchObject({ kind: 'invalid_response' });
    });
    it('accepts empty real catalogs and 200-character names', async () => {
        const { client, fetch } = setup(new Response(JSON.stringify({ ...realCatalog, models: [] }), { headers: { 'content-type': 'application/json' } }));
        expect((await client.getCatalog()).models).toEqual([]);
        fetch.mockResolvedValue(new Response(JSON.stringify({ ...realCatalog, models: [{ id: 'x'.repeat(200), name: 'n'.repeat(200) }] }), { headers: { 'content-type': 'application/json' } }));
        expect((await client.getCatalog()).models[0].name).toHaveLength(200);
    });

});

describe('account conversation routing', () => {
    const conversationId = 'a695462e-41f4-45f1-9503-45355a79cf11';
    async function platformSetup() {
        const fetch = vi.fn<NonNullable<WorkMockClientOptions['fetch']>>().mockImplementation(async url => url.endsWith('/models')
            ? new Response(JSON.stringify(realCatalog), { headers: { 'content-type': 'application/json' } })
            : streamResponse(ndjson([realUsage, done])));
        const tokenProvider = vi.fn(async () => 'never-read-device-token');
        const client = createWorkMockClient({ baseUrl: 'https://work.example', platformSession: { csrf: 'a'.repeat(43), origin: 'https://work.example' }, tokenProvider, fetch });
        await client.getCatalog();
        return { client, fetch, tokenProvider };
    }
    it('adds the validated conversation UUID only on the cookie platform stream', async () => {
        const { client, fetch, tokenProvider } = await platformSetup();
        await client.stream({ ...realInput, conversationId }, () => {});
        const [url, request] = fetch.mock.calls[1];
        expect(url).toBe('https://work.example/v1/tokenhub/platform/stream');
        expect(JSON.parse(request.body as string)).toEqual({ ...realInput, conversationId });
        expect(request.headers).not.toHaveProperty('Authorization');
        expect(request.headers).toMatchObject({ 'x-tokenhub-csrf': 'a'.repeat(43) });
        expect(request.credentials).toBe('include');
        expect(tokenProvider).not.toHaveBeenCalled();
    });
    it.each(['bad-id', '', '11111111-1111-1111-1111-111111111111', null, 12])('rejects malformed platform conversation ID %s before fetching', async conversationId => {
        const { client, fetch } = await platformSetup();
        await expect(client.stream({ ...realInput, conversationId } as any, () => {})).rejects.toMatchObject({ kind: 'invalid_request' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it('does not change native/device real wire shape even if a caller supplies conversationId', async () => {
        const { client, fetch } = await realSetup();
        await client.stream({ ...realInput, conversationId }, () => {});
        expect(JSON.parse(fetch.mock.calls[1][1].body as string)).toEqual(realInput);
    });
    it('does not change the existing mock wire shape', async () => {
        const { client, fetch } = setup();
        await client.stream({ ...input, conversationId }, () => {});
        expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual(input);
    });
});


describe('bounded catalog diagnostics', () => {
    it.each(['work_gateway_disabled', 'work_gateway_unavailable', 'work_authority_unavailable', 'work_key_lookup_unavailable'])('retains fixed diagnostic %s without exposing upstream details', async code => {
        const { client } = setup(new Response(JSON.stringify({ code, error: 'private upstream message' }), { status: 503, headers: { 'content-type': 'application/json' } }));
        const error = await client.getCatalog().catch(value => value);
        expect(error).toMatchObject({ kind: 'unavailable', status: 503, diagnostic: code });
        expect(String(error)).not.toContain('private');
    });
    it.each([
        [503, 'application/json', JSON.stringify({ code: 'private-secret' })],
        [503, 'application/json', JSON.stringify({ code: 'work_gateway_disabled', padding: 'x'.repeat(4096) })],
        [503, 'text/html', JSON.stringify({ code: 'work_gateway_disabled' })],
        [401, 'application/json', JSON.stringify({ code: 'work_gateway_disabled' })],
        [503, 'application/json', '{'],
    ])('ignores untrusted diagnostic for HTTP %s and type %s', async (status, type, body) => {
        const { client } = setup(new Response(body as string, { status: status as number, headers: { 'content-type': type as string } }));
        const error = await client.getCatalog().catch(value => value);
        expect(error).toBeInstanceOf(WorkMockError);
        expect(error.status).toBe(status); expect(error.diagnostic).toBeUndefined();
    });
});
