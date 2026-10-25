/** Isolated Work gateway. Mode and billing come from the selected Happy server catalog. */
export const WORK_MOCK_MAX_PROMPT_LENGTH = 4000;
export const WORK_MOCK_MAX_RESPONSE_BYTES = 256 * 1024;
export const WORK_MOCK_REQUEST_TIMEOUT_MS = 30_000;
export const WORK_REAL_REQUEST_TIMEOUT_MS = 120_000;
export const WORK_REAL_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const WORK_REAL_MAX_LINE_LENGTH = 256 * 1024;
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_LINE_LENGTH = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_IDS = ['mock-echo', 'mock-slow', 'mock-error'] as const;
export type WorkMockModelId = typeof MODEL_IDS[number];
export interface WorkMessage { role: 'user' | 'assistant'; content: string }
export interface WorkChatInput { model: string; prompt?: string; messages?: WorkMessage[]; requestId?: string; conversationId?: string }
export interface WorkMockModel { id: string; name: string }
export interface WorkModelCatalog { mode: 'mock' | 'real'; billable: boolean; models: WorkMockModel[] }
export interface WorkMockUsage {
    inputTokens: number;
    outputTokens: number;
    model: string;
    requestId: string;
    mock: boolean;
    billable: boolean;
    accounting?: 'core';
    coreRequestId?: string;
}
export type WorkMockErrorKind = 'configuration' | 'authentication' | 'forbidden' | 'rate_limit'
    | 'unavailable' | 'http' | 'network' | 'aborted' | 'timeout' | 'invalid_request'
    | 'invalid_response' | 'response_limit' | 'truncated_stream' | 'upstream'
    | 'usage_unavailable' | 'request_conflict' | 'core_gateway_error' | 'quota_exceeded' | 'work_reconciliation_required';
export class WorkMockError extends Error {
    constructor(public readonly kind: WorkMockErrorKind, public readonly status?: number) {
        // Never expose response bodies, prompt, auth tokens, URLs, or upstream diagnostics.
        super(`Work mock request failed (${kind})`);
        this.name = 'WorkMockError';
    }
}
export interface WorkMockClientOptions {
    /** The existing application's selected Happy server, never a browser-entered gateway URL. */
    baseUrl: string;
    requireRealCatalog?: boolean;
    /** Existing Happy auth token only. Never pass the encryption secret or a TokenHub API key. */
    tokenProvider: () => Promise<string | null>;
    /** Independent same-origin BFF session. No bearer token or device identity is sent. */
    platformSession?: { csrf: string; origin: string };
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validModel(value: unknown): value is WorkMockModelId {
    return typeof value === 'string' && (MODEL_IDS as readonly string[]).includes(value);
}
function tokenCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function parseJSON(text: string): unknown {
    try { return JSON.parse(text); } catch { throw new WorkMockError('invalid_response'); }
}
function cancelBody(response: Response) {
    void response.body?.cancel().catch(() => {});
}

/** Resolve/reject promptly on abort even if a transport or credential provider stalls. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const aborted = () => { cleanup(); reject(new WorkMockError('aborted')); };
        const cleanup = () => signal.removeEventListener('abort', aborted);
        // Attach handlers even when already aborted, so later rejections are still consumed.
        promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        if (signal.aborted) aborted();
        else signal.addEventListener('abort', aborted, { once: true });
    });
}

/** Bounded UTF-8 chunks. The reader is canceled on every exit, including navigation and errors. */
async function* textChunks(response: Response, signal: AbortSignal, limit: number): AsyncGenerator<string> {
    if (!response.body) throw new WorkMockError('invalid_response');
    const declaredLength = response.headers.get('content-length');
    if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) {
        cancelBody(response);
        throw new WorkMockError('response_limit');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    try {
        while (true) {
            const { value, done } = await abortable(reader.read(), signal);
            if (signal.aborted) throw new WorkMockError('aborted');
            if (done) break;
            bytes += value.byteLength;
            if (bytes > limit) throw new WorkMockError('response_limit');
            let text: string;
            try { text = decoder.decode(value, { stream: true }); }
            catch { throw new WorkMockError('invalid_response'); }
            yield text;
        }
        try { yield decoder.decode(); }
        catch { throw new WorkMockError('invalid_response'); }
    } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export function createWorkMockClient(options: WorkMockClientOptions) {
    let base: URL;
    try {
        base = new URL(options.baseUrl);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
        if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))
            || base.username || base.password || base.search || base.hash) throw new Error();
    } catch { throw new WorkMockError('configuration'); }
    const baseUrl = base.toString().replace(/\/+$/, '');
    if (options.platformSession && (base.origin !== options.platformSession.origin || !/^[A-Za-z0-9_-]{43}$/.test(options.platformSession.csrf))) throw new WorkMockError('configuration');
    const transport = options.fetch ?? globalThis.fetch;
    if (typeof transport !== 'function' || typeof options.tokenProvider !== 'function') throw new WorkMockError('configuration');

    let catalog: WorkModelCatalog | undefined;

    async function request<T>(path: string, body: WorkChatInput | undefined,
        callerSignal: AbortSignal | undefined, consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
        if (callerSignal?.aborted) throw new WorkMockError('aborted');
        const controller = new AbortController();
        let timedOut = false;
        const onAbort = () => controller.abort();
        callerSignal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, body && catalog?.mode === 'real' ? WORK_REAL_REQUEST_TIMEOUT_MS : WORK_MOCK_REQUEST_TIMEOUT_MS);
        try {
            let token: string | null = null;
            try { if (!options.platformSession) token = await abortable(options.tokenProvider(), controller.signal); }
            catch { throw new WorkMockError(controller.signal.aborted ? 'aborted' : 'authentication'); }
            if (!options.platformSession && (typeof token !== 'string' || !token || /\s/.test(token))) throw new WorkMockError('authentication');
            if (controller.signal.aborted) throw new WorkMockError('aborted');
            const pending = transport(`${baseUrl}/v1/tokenhub/${options.platformSession ? 'platform' : 'work'}/${path}`, {
                method: body ? 'POST' : 'GET',
                headers: {
                    ...(options.platformSession ? { 'x-tokenhub-csrf': options.platformSession.csrf } : { Authorization: `Bearer ${token}` }),
                    Accept: body ? 'application/x-ndjson' : 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                credentials: options.platformSession ? 'include' : 'omit', redirect: 'error', cache: 'no-store',
                // The request shape is constructed here, never spread from caller-owned input.
                ...(body ? { body: JSON.stringify({ model: body.model, ...(body.messages ? { messages: body.messages.map(({role, content}) => ({role, content})) } : { prompt: body.prompt }), ...(body.requestId ? { requestId: body.requestId } : {}), ...(options.platformSession && body.conversationId ? { conversationId: body.conversationId } : {}) }) } : {}),
                signal: controller.signal,
            });
            // A nonconforming transport might resolve after abort. Do not leave its body open.
            void pending.then(response => { if (controller.signal.aborted) cancelBody(response); }, () => {});
            const response = await abortable(pending, controller.signal);
            if (!response.ok) {
                cancelBody(response);
                const kind = response.status === 401 ? 'authentication' : response.status === 403 ? 'forbidden'
                    : response.status === 402 ? 'quota_exceeded' : response.status === 409 ? 'request_conflict' : response.status === 429 ? 'rate_limit' : response.status === 503 ? 'unavailable' : 'http';
                throw new WorkMockError(kind, response.status);
            }
            const expectedType = body ? 'application/x-ndjson' : 'application/json';
            if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== expectedType) {
                cancelBody(response);
                throw new WorkMockError('invalid_response');
            }
            return await consume(response, controller.signal);
        } catch (error) {
            if (controller.signal.aborted) throw new WorkMockError(timedOut ? 'timeout' : 'aborted');
            if (error instanceof WorkMockError) throw error;
            throw new WorkMockError('network');
        } finally {
            clearTimeout(timer);
            callerSignal?.removeEventListener('abort', onAbort);
        }
    }

    async function getCatalog(signal?: AbortSignal): Promise<WorkModelCatalog> {
        catalog = undefined;
        catalog = undefined;
        return request('models', undefined, signal, async (response, requestSignal) => {
            let text = '';
            for await (const chunk of textChunks(response, requestSignal, MAX_CATALOG_BYTES)) text += chunk;
            const value = parseJSON(text);
            if (record(value) && value.mode === 'mock' && new TextEncoder().encode(text).byteLength > MAX_LINE_LENGTH) {
                throw new WorkMockError('response_limit');
            }
            if (!record(value) || !((value.mode === 'mock' && value.billable === false) || (value.mode === 'real' && value.billable === true))
                || !Array.isArray(value.models) || (value.mode === 'mock' && value.models.length < 1) || value.models.length > (value.mode === 'mock' ? MODEL_IDS.length : 1000)) {
                throw new WorkMockError('invalid_response');
            }
            const ids = new Set<string>();
            const models = value.models.map((model: unknown) => {
                if (!record(model) || typeof model.id !== 'string' || (value.mode === 'mock' ? !validModel(model.id) : !model.id.trim() || model.id.length > 200) || ids.has(model.id)
                    || typeof model.name !== 'string' || !model.name.trim() || model.name.length > (value.mode === 'real' ? 200 : 120)) {
                    throw new WorkMockError('invalid_response');
                }
                ids.add(model.id);
                return { id: model.id, name: model.name };
            });
            catalog = { mode: value.mode as 'mock' | 'real', billable: value.billable as boolean, models: models.filter(model => model.id !== 'default') };
            return catalog;
        });
    }
    return {
        getCatalog,
        async listModels(signal?: AbortSignal): Promise<WorkMockModel[]> { return (await getCatalog(signal)).models; },
        async stream(input: WorkChatInput, onDelta: (text: string) => void, signal?: AbortSignal): Promise<WorkMockUsage> {
            if (options.requireRealCatalog && (!catalog || catalog.mode !== 'real')) throw new WorkMockError('configuration');
            const real = catalog?.mode === 'real';
            const lineLimit = real ? WORK_REAL_MAX_LINE_LENGTH : MAX_LINE_LENGTH;
            const responseLimit = real ? WORK_REAL_MAX_RESPONSE_BYTES : WORK_MOCK_MAX_RESPONSE_BYTES;
            const validHistory = real && Array.isArray(input.messages) && input.messages.length > 0 && input.messages.length <= 49 && input.messages.length % 2 === 1 && input.messages.every((m, i) => m.role === (i % 2 ? 'assistant' : 'user') && typeof m.content === 'string' && m.content.trim()) && input.messages.reduce((n, m) => n + m.content.length, 0) <= 16000
            const validPrompt = typeof input.prompt === 'string' && !!input.prompt.trim() && input.prompt.length <= WORK_MOCK_MAX_PROMPT_LENGTH
            if (!(catalog ? catalog.models.some(model => model.id === input.model) : validModel(input.model))
                || (real && (typeof input.requestId !== 'string' || !UUID.test(input.requestId)))
                || (options.platformSession && input.conversationId !== undefined && (typeof input.conversationId !== 'string' || !UUID.test(input.conversationId)))
                || (input.messages !== undefined ? !validHistory || input.prompt !== undefined : !validPrompt)) throw new WorkMockError('invalid_request');
            return request('stream', { model: input.model, ...(input.messages ? { messages: input.messages } : { prompt: input.prompt }), ...(real ? { requestId: input.requestId } : {}), ...(options.platformSession && input.conversationId ? { conversationId: input.conversationId } : {}) }, signal, async (response, requestSignal) => {
                let buffer = '';
                let usage: WorkMockUsage | undefined;
                let done = false;
                function consumeLine(line: string) {
                    if (line.length > lineLimit) throw new WorkMockError('response_limit');
                    if (!line.trim()) return;
                    const event = parseJSON(line);
                    if (done || !record(event)) throw new WorkMockError('invalid_response');
                    switch (event.type) {
                        case 'delta':
                            if (usage || typeof event.text !== 'string') throw new WorkMockError('invalid_response');
                            onDelta(event.text);
                            break;
                        case 'usage':
                            if (usage || !tokenCount(event.inputTokens) || !tokenCount(event.outputTokens)
                                || event.model !== input.model || typeof event.requestId !== 'string'
                                || (real && event.coreRequestId !== undefined && (typeof event.coreRequestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(event.coreRequestId)))
                                || (real ? event.requestId !== input.requestId || event.mock !== false || event.billable !== true || event.accounting !== 'core'
                                    : !/^[a-zA-Z0-9_-]{1,128}$/.test(event.requestId) || event.mock !== true || event.billable !== false)) {
                                throw new WorkMockError('invalid_response');
                            }
                            // Project only safe display fields. Never expose identity/session metadata.
                            usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens,
                                model: input.model, requestId: event.requestId, mock: !real, billable: real, ...(real ? { accounting: 'core' as const, ...(typeof event.coreRequestId === 'string' ? { coreRequestId: event.coreRequestId } : {}) } : {}) };
                            break;
                        case 'done':
                            if (!usage) throw new WorkMockError('invalid_response');
                            done = true;
                            break;
                        case 'error':
                            if (typeof event.code !== 'string' || typeof event.message !== 'string') throw new WorkMockError('invalid_response');
                            throw new WorkMockError(event.code === 'authorization_revoked' ? 'authentication'
                                : event.code === 'gateway_timeout' ? 'timeout'
                                    : event.code === 'cancelled' ? 'aborted'
                                        : (event.code === 'forbidden' || event.code === 'access_or_quota_denied') ? 'forbidden'
                                        : event.code === 'quota_exceeded' ? 'quota_exceeded'
                                        : (event.code === 'rate_limit' || event.code === 'rate_limited') ? 'rate_limit'
                                            : event.code === 'work_reconciliation_required' ? 'work_reconciliation_required'
                                            : event.code === 'usage_unavailable' ? 'usage_unavailable'
                                                : event.code === 'request_conflict' ? 'request_conflict'
                                                    : event.code === 'core_gateway_error' ? 'core_gateway_error' : 'upstream');
                        default: throw new WorkMockError('invalid_response');
                    }
                }
                for await (const chunk of textChunks(response, requestSignal, responseLimit)) {
                    buffer += chunk;
                    let newline: number;
                    while ((newline = buffer.indexOf('\n')) >= 0) {
                        consumeLine(buffer.slice(0, newline));
                        buffer = buffer.slice(newline + 1);
                        if (requestSignal.aborted) throw new WorkMockError('aborted');
                    }
                    if (buffer.length > lineLimit) throw new WorkMockError('response_limit');
                }
                // NDJSON may end in a complete JSON record without a trailing newline.
                if (buffer.trim()) consumeLine(buffer);
                if (!done || !usage) throw new WorkMockError('truncated_stream');
                return usage;
            });
        },
    };
}
