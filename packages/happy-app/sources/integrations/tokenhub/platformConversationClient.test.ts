import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createPlatformConversationClient, PLATFORM_CONVERSATION_MAX_RESPONSE_BYTES, PLATFORM_CONVERSATION_REQUEST_TIMEOUT_MS,
    type PlatformConversation, type PlatformConversationClientOptions, type PlatformConversationImport,
} from './platformConversationClient';
import { WorkMockError } from './workMockClient';

const origin = 'https://happy.example.test';
const csrf = 'c'.repeat(43);
const id = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const usage = { inputTokens: 3, outputTokens: 5, model: 'provider/model', requestId: turnId,
    mock: false, billable: true, accounting: 'core' as const, coreRequestId: 'core-request_1' };
const conversation: PlatformConversation = { id, model: 'provider/model', updatedAt: 1720000000000,
    turns: [{ id: turnId, user: '你好', assistant: 'Hello', status: 'complete', usage }] };
const summary = { id, model: conversation.model, title: '你好', updatedAt: conversation.updatedAt, lastStatus: 'complete' as const };
function json(value: unknown) {
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}
function setup(response = json({ conversations: [summary] })) {
    const fetch = vi.fn<NonNullable<PlatformConversationClientOptions['fetch']>>().mockResolvedValue(response);
    const client = createPlatformConversationClient({ baseUrl: origin + '/', csrf, origin, fetch });
    return { client, fetch };
}
function openStream() {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel }),
        { headers: { 'content-type': 'application/json' } });
    return { response, source, cancel };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('account-scoped platform conversation client', () => {
    it('does nothing until explicitly requested and lists with only same-origin cookie and CSRF auth', async () => {
        const { client, fetch } = setup();
        expect(fetch).not.toHaveBeenCalled();
        await expect(client.list()).resolves.toEqual([summary]);
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0][0]).toBe(origin + '/v1/tokenhub/platform/conversations');
        expect(fetch.mock.calls[0][1]).toEqual({ method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store',
            headers: { Accept: 'application/json', 'x-tokenhub-csrf': csrf }, signal: expect.any(AbortSignal) });
    });

    it('gets an exact conversation and deletes with CSRF but no body or caller identity', async () => {
        const { client, fetch } = setup(json(conversation));
        await expect(client.get(id)).resolves.toEqual(conversation);
        expect(fetch.mock.calls[0][0]).toBe(origin + '/v1/tokenhub/platform/conversations/' + id);
        fetch.mockResolvedValue(json({ deleted: true, accountId: 'hidden' }));
        await expect(client.remove(id)).resolves.toEqual({ deleted: true });
        expect(fetch.mock.calls[1][1]).toEqual({ method: 'DELETE', credentials: 'include', redirect: 'error', cache: 'no-store',
            headers: { Accept: 'application/json', 'x-tokenhub-csrf': csrf }, signal: expect.any(AbortSignal) });
    });

    it('imports only through an explicit call and projects exact bounded content and usage fields', async () => {
        const { client, fetch } = setup(json(conversation));
        const value = { ...conversation, accountId: 'forbidden', subject: 'forbidden', snapshot: ['forbidden'],
            turns: [{ ...conversation.turns[0], token: 'forbidden', usage: { ...usage, balance: 'forbidden', apiKey: 'forbidden' } }] };
        await expect(client.importConversation(value)).resolves.toEqual(conversation);
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0][0]).toBe(origin + '/v1/tokenhub/platform/conversations/import');
        expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'error', cache: 'no-store',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-tokenhub-csrf': csrf } });
        expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({ id, model: conversation.model, turns: conversation.turns });
        expect(JSON.stringify(fetch.mock.calls[0])).not.toContain('forbidden');
    });

    it('keeps the same import IDs on explicit repeated calls without background retries or new identity', async () => {
        const { client, fetch } = setup();
        fetch.mockImplementation(async () => json(conversation));
        await client.importConversation(conversation);
        await client.importConversation(conversation);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
    });

    it('projects only safe response fields at every level', async () => {
        const { client, fetch } = setup(json({ conversations: [{ ...summary, subject: 'secret', sessionId: 'secret' }], csrf: 'secret' }));
        await expect(client.list()).resolves.toEqual([summary]);
        fetch.mockResolvedValue(json({ ...conversation, subject: 'secret', token: 'secret',
            turns: [{ ...conversation.turns[0], snapshot: 'secret', usage: { ...usage, identity: 'secret', accessToken: 'secret' } }] }));
        await expect(client.get(id)).resolves.toEqual(conversation);
    });

    it('accepts empty history, missing lastStatus and all declared turn statuses', async () => {
        const { client, fetch } = setup(json({ conversations: [] }));
        await expect(client.list()).resolves.toEqual([]);
        const { lastStatus: _status, ...emptySummary } = summary;
        fetch.mockResolvedValue(json({ conversations: [emptySummary] }));
        await expect(client.list()).resolves.toEqual([emptySummary]);
        fetch.mockResolvedValue(json({ ...conversation, turns: [] }));
        await expect(client.get(id)).resolves.toMatchObject({ turns: [] });
        for (const status of ['streaming', 'complete', 'cancelled', 'failed'] as const) {
            fetch.mockResolvedValue(json({ ...conversation, turns: [{ ...conversation.turns[0], status, usage: undefined }] }));
            await expect(client.get(id)).resolves.toMatchObject({ turns: [{ status }] });
        }
    });

    it('rejects usage from a different request', async () => {
        await expect(setup(json({ ...conversation, turns: [{ ...conversation.turns[0], usage: { ...usage, requestId: otherId } }] })).client.get(id))
            .rejects.toMatchObject({ kind: 'invalid_response' });
    });

    it('imports and restores legitimate mixed-model history without rewriting per-turn usage', async () => {
        const value: PlatformConversation = { ...conversation, model: 'provider/new-model', turns: [conversation.turns[0],
            { ...conversation.turns[0], id: otherId, usage: { ...usage, model: 'provider/new-model', requestId: otherId } }] };
        const { client, fetch } = setup(json(value));
        await expect(client.importConversation(value)).resolves.toEqual(value);
        expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({ id, model: value.model, turns: value.turns });
        fetch.mockResolvedValue(json(value));
        await expect(client.get(id)).resolves.toEqual(value);
    });

    it.each([
        [401, 'authentication'], [403, 'forbidden'], [404, 'http'], [409, 'request_conflict'],
        [429, 'rate_limit'], [503, 'unavailable'], [500, 'http'],
    ] as const)('sanitizes HTTP %s without exposing server diagnostics or retrying', async (status, kind) => {
        const { client, fetch } = setup(new Response('sensitive account diagnostic', { status }));
        await expect(client.list()).rejects.toMatchObject({ kind, status, message: `Work mock request failed (${kind})` });
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('does not interpret request conflicts as successful deletion or import', async () => {
        const { client, fetch } = setup();
        fetch.mockImplementation(async () => new Response('private running/deleted state', { status: 409 }));
        await expect(client.remove(id)).rejects.toMatchObject({ kind: 'request_conflict' });
        await expect(client.importConversation(conversation)).rejects.toMatchObject({ kind: 'request_conflict' });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('sanitizes network failures without exposing credentials', async () => {
        const { client, fetch } = setup();
        fetch.mockRejectedValue(new Error('private token in transport diagnostic'));
        await expect(client.list()).rejects.toMatchObject({ kind: 'network', message: 'Work mock request failed (network)' });
    });

    it.each([
        { baseUrl: 'http://external.test', origin: 'http://external.test' },
        { baseUrl: 'https://other.test' }, { baseUrl: origin + '/?token=secret' }, { baseUrl: origin + '/#secret' },
        { baseUrl: 'https://user:password@happy.example.test' }, { baseUrl: 'not-a-url' },
        { origin: origin + '/' }, { origin: origin + '/path' }, { csrf: '' }, { csrf: 'x'.repeat(42) }, { csrf: '\n'.repeat(43) },
    ])('rejects unsafe or mismatched configuration before transport: %j', override => {
        const fetch = vi.fn();
        expect(() => createPlatformConversationClient({ baseUrl: origin, csrf, origin, fetch, ...override })).toThrow(WorkMockError);
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each(['http://localhost:3005', 'http://127.0.0.1:3005', 'http://[::1]:3005'])('accepts matching loopback development: %s', baseUrl => {
        expect(() => createPlatformConversationClient({ baseUrl, csrf, origin: baseUrl })).not.toThrow();
    });

    it.each(['../session', 'not-a-uuid', '', '11111111-1111-1111-1111-111111111111', id + '?subject=other'])
    ('rejects invalid path IDs before transport: %s', async value => {
        const { client, fetch } = setup();
        await expect(client.get(value)).rejects.toMatchObject({ kind: 'invalid_request' });
        await expect(client.remove(value)).rejects.toMatchObject({ kind: 'invalid_request' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
        null, {}, { conversations: null }, { conversations: [null] },
        { conversations: [summary, summary] },
        { conversations: [{ ...summary, id: 'bad' }] },
        { conversations: [{ ...summary, model: '' }] },
        { conversations: [{ ...summary, model: 'x'.repeat(201) }] },
        { conversations: [{ ...summary, title: 123 }] },
        { conversations: [{ ...summary, title: 'x'.repeat(121) }] },
        { conversations: [{ ...summary, updatedAt: -1 }] },
        { conversations: [{ ...summary, updatedAt: 1.5 }] },
        { conversations: [{ ...summary, updatedAt: Number.MAX_SAFE_INTEGER + 1 }] },
        { conversations: [{ ...summary, lastStatus: 'done' }] },
        { conversations: [{ ...summary, lastStatus: null }] },
        { conversations: Array(101).fill(summary) },
    ])('rejects malformed or oversized summaries: %#', async value => {
        await expect(setup(json(value)).client.list()).rejects.toMatchObject({ kind: 'invalid_response' });
    });

    it.each([
        null, {}, { ...conversation, id: otherId }, { ...conversation, updatedAt: 'yesterday' },
        { ...conversation, turns: null }, { ...conversation, turns: [null] },
        { ...conversation, turns: Array(101).fill(conversation.turns[0]) },
        { ...conversation, turns: [conversation.turns[0], conversation.turns[0]] },
        { ...conversation, turns: [{ ...conversation.turns[0], id: 'not-a-uuid' }] },
        { ...conversation, turns: [{ ...conversation.turns[0], user: ' ' }] },
        { ...conversation, turns: [{ ...conversation.turns[0], user: 'x'.repeat(16001) }] },
        { ...conversation, turns: [{ ...conversation.turns[0], assistant: 2 }] },
        { ...conversation, turns: [{ ...conversation.turns[0], assistant: 'x'.repeat(262145) }] },
        { ...conversation, turns: [{ ...conversation.turns[0], status: 'done' }] },
    ])('rejects malformed conversation details and mismatched IDs: %#', async value => {
        await expect(setup(json(value)).client.get(id)).rejects.toMatchObject({ kind: 'invalid_response' });
    });

    it.each([
        null, {}, { ...usage, inputTokens: -1 }, { ...usage, outputTokens: 1.5 }, { ...usage, model: '' },
        { ...usage, requestId: 'unsafe id' }, { ...usage, requestId: 'x'.repeat(129) },
        { ...usage, accounting: undefined }, { ...usage, mock: true }, { ...usage, billable: false },
        { ...usage, coreRequestId: 'unsafe id' }, { ...usage, coreRequestId: 'x'.repeat(129) },
    ])('rejects malformed or non-display usage fields: %#', async value => {
        const { client, fetch } = setup(json({ ...conversation, turns: [{ ...conversation.turns[0], usage: value }] }));
        await expect(client.get(id)).rejects.toMatchObject({ kind: 'invalid_response' });
        await expect(client.importConversation({ ...conversation, turns: [{ ...conversation.turns[0], usage: value }] } as unknown as PlatformConversationImport))
            .rejects.toMatchObject({ kind: 'invalid_request' });
        expect(fetch).toHaveBeenCalledOnce();
    });

    it.each([null, {}, { deleted: false }, { deleted: 'true' }])('requires an explicit successful deletion response', async value => {
        await expect(setup(json(value)).client.remove(id)).rejects.toMatchObject({ kind: 'invalid_response' });
    });

    it('checks import content locally and rejects a response for another conversation', async () => {
        const { client, fetch } = setup(json({ ...conversation, id: otherId }));
        await expect(client.importConversation({ ...conversation, turns: [{ ...conversation.turns[0], id: undefined }] } as unknown as PlatformConversationImport))
            .rejects.toMatchObject({ kind: 'invalid_request' });
        expect(fetch).not.toHaveBeenCalled();
        await expect(client.importConversation(conversation)).rejects.toMatchObject({ kind: 'invalid_response' });
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('never imports empty or actively streaming history', async () => {
        const { client, fetch } = setup();
        await expect(client.importConversation({ ...conversation, turns: [] })).rejects.toMatchObject({ kind: 'invalid_request' });
        await expect(client.importConversation({ ...conversation, turns: [{ ...conversation.turns[0], status: 'streaming' }] }))
            .rejects.toMatchObject({ kind: 'invalid_request' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('bounds aggregate history characters and encoded import bytes before transport', async () => {
        const { client, fetch } = setup();
        const turns = [id, turnId, otherId].map(id => ({ id, user: 'hello', assistant: '\u0000'.repeat(220000), status: 'complete' as const }));
        await expect(client.importConversation({ ...conversation, turns })).rejects.toMatchObject({ kind: 'invalid_request' });
        const tooManyCharacters = [...turns.map(turn => ({ ...turn, assistant: 'x'.repeat(260000) })),
            { ...turns[0], id: '44444444-4444-4444-8444-444444444444', assistant: 'x'.repeat(260000) }];
        await expect(client.importConversation({ ...conversation, turns: tooManyCharacters })).rejects.toMatchObject({ kind: 'invalid_request' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('normalizes UUID case consistently with the server', async () => {
        const upperId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
        const lowerId = upperId.toLowerCase();
        const { client, fetch } = setup(json({ ...conversation, id: lowerId }));
        await expect(client.get(upperId)).resolves.toMatchObject({ id: lowerId });
        expect(fetch.mock.calls[0][0]).toBe(origin + '/v1/tokenhub/platform/conversations/' + lowerId);
        fetch.mockResolvedValue(json({ ...conversation, id: lowerId }));
        await client.importConversation({ ...conversation, id: upperId });
        expect(JSON.parse(fetch.mock.calls[1][1].body as string).id).toBe(lowerId);
    });

    it('rejects incorrect content type, malformed JSON, malformed UTF-8 and redirects', async () => {
        for (const response of [new Response('{}', { headers: { 'content-type': 'text/html' } }),
            new Response('{', { headers: { 'content-type': 'application/json' } }),
            new Response(new Uint8Array([255, 254]), { headers: { 'content-type': 'application/json' } })]) {
            await expect(setup(response).client.list()).rejects.toMatchObject({ kind: 'invalid_response' });
        }
        const response = json({ conversations: [] });
        Object.defineProperty(response, 'redirected', { value: true });
        await expect(setup(response).client.list()).rejects.toMatchObject({ kind: 'invalid_response' });
    });

    it('bounds declared and actual bytes before returning or retaining history', async () => {
        const response = json(conversation);
        response.headers.set('content-length', String(PLATFORM_CONVERSATION_MAX_RESPONSE_BYTES + 1));
        await expect(setup(response).client.get(id)).rejects.toMatchObject({ kind: 'response_limit' });
        const { response: streamed, source, cancel } = openStream();
        source.enqueue(new Uint8Array(PLATFORM_CONVERSATION_MAX_RESPONSE_BYTES + 1));
        await expect(setup(streamed).client.get(id)).rejects.toMatchObject({ kind: 'response_limit' });
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('does not dispatch any operation after pre-abort', async () => {
        const { client, fetch } = setup();
        const controller = new AbortController(); controller.abort();
        for (const operation of [() => client.list(controller.signal), () => client.get(id, controller.signal),
            () => client.remove(id, controller.signal), () => client.importConversation(conversation, controller.signal)]) {
            await expect(operation()).rejects.toMatchObject({ kind: 'aborted' });
        }
        expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects stale results promptly when transport ignores abort and cancels its late body', async () => {
        const { client, fetch } = setup();
        let resolve!: (response: Response) => void;
        fetch.mockReturnValue(new Promise<Response>(done => { resolve = done; }));
        const controller = new AbortController();
        const result = client.list(controller.signal);
        controller.abort();
        await expect(result).rejects.toMatchObject({ kind: 'aborted' });
        expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
        const { response, cancel } = openStream();
        resolve(response);
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    });

    it('rejects an abort between transport resolution and body consumption', async () => {
        const { client, fetch } = setup();
        const controller = new AbortController();
        const { response, cancel } = openStream();
        fetch.mockImplementation(async () => { controller.abort(); return response; });
        await expect(client.get(id, controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    });

    it('aborts pending body reads and cancels history streams immediately', async () => {
        const { response, source, cancel } = openStream();
        const { client } = setup(response);
        const controller = new AbortController();
        const result = client.get(id, controller.signal);
        source.enqueue(new TextEncoder().encode('{"id":'));
        await vi.waitFor(() => expect(response.body?.locked).toBe(true));
        controller.abort();
        await expect(result).rejects.toMatchObject({ kind: 'aborted' });
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('does not let an old aborted request replace a new account request', async () => {
        const { client, fetch } = setup();
        let resolveOld!: (response: Response) => void;
        fetch.mockReturnValueOnce(new Promise<Response>(done => { resolveOld = done; }));
        const old = new AbortController(), oldResult = client.list(old.signal);
        old.abort();
        await expect(oldResult).rejects.toMatchObject({ kind: 'aborted' });
        const fresh = { ...summary, id: otherId };
        fetch.mockResolvedValueOnce(json({ conversations: [fresh] }));
        await expect(client.list()).resolves.toEqual([fresh]);
        resolveOld(json({ conversations: [summary] }));
        await expect(oldResult).rejects.toMatchObject({ kind: 'aborted' });
    });

    it('times out a stalled fetch without background retries', async () => {
        vi.useFakeTimers();
        const { client, fetch } = setup();
        fetch.mockReturnValue(new Promise(() => {}));
        const rejection = expect(client.list()).rejects.toMatchObject({ kind: 'timeout' });
        await vi.advanceTimersByTimeAsync(PLATFORM_CONVERSATION_REQUEST_TIMEOUT_MS);
        await rejection;
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
    });

    it('times out and cancels a stalled response body', async () => {
        vi.useFakeTimers();
        const { response, cancel } = openStream();
        const { client } = setup(response);
        const rejection = expect(client.get(id)).rejects.toMatchObject({ kind: 'timeout' });
        await vi.advanceTimersByTimeAsync(PLATFORM_CONVERSATION_REQUEST_TIMEOUT_MS);
        await rejection;
        expect(cancel).toHaveBeenCalledOnce();
    });
});
