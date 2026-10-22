/** Isolated, non-billable Work experiment. Talks only to the selected Happy server. */
export const WORK_MOCK_MAX_PROMPT_LENGTH = 4000;
export const WORK_MOCK_MAX_RESPONSE_BYTES = 256 * 1024;
export const WORK_MOCK_REQUEST_TIMEOUT_MS = 30_000;
const MAX_LINE_LENGTH = 16 * 1024;
const MODEL_IDS = ['mock-echo', 'mock-slow', 'mock-error'] as const;
export type WorkMockModelId = typeof MODEL_IDS[number];
export interface WorkMockModel { id: WorkMockModelId; name: string }
export interface WorkMockUsage {
    inputTokens: number;
    outputTokens: number;
    model: string;
    requestId: string;
    mock: true;
    billable: false;
}
export type WorkMockErrorKind = 'configuration' | 'authentication' | 'forbidden' | 'rate_limit'
    | 'unavailable' | 'http' | 'network' | 'aborted' | 'timeout' | 'invalid_request'
    | 'invalid_response' | 'response_limit' | 'truncated_stream' | 'upstream';
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
    /** Existing Happy auth token only. Never pass the encryption secret or a TokenHub API key. */
    tokenProvider: () => Promise<string | null>;
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
    const transport = options.fetch ?? globalThis.fetch;
    if (typeof transport !== 'function' || typeof options.tokenProvider !== 'function') throw new WorkMockError('configuration');

    async function request<T>(path: string, body: { model: string; prompt: string } | undefined,
        callerSignal: AbortSignal | undefined, consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
        if (callerSignal?.aborted) throw new WorkMockError('aborted');
        const controller = new AbortController();
        let timedOut = false;
        const onAbort = () => controller.abort();
        callerSignal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, WORK_MOCK_REQUEST_TIMEOUT_MS);
        try {
            let token: string | null;
            try { token = await abortable(options.tokenProvider(), controller.signal); }
            catch { throw new WorkMockError(controller.signal.aborted ? 'aborted' : 'authentication'); }
            if (typeof token !== 'string' || !token || /\s/.test(token)) throw new WorkMockError('authentication');
            if (controller.signal.aborted) throw new WorkMockError('aborted');
            const pending = transport(`${baseUrl}/v1/tokenhub/work/${path}`, {
                method: body ? 'POST' : 'GET',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: body ? 'application/x-ndjson' : 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                credentials: 'omit', redirect: 'error', cache: 'no-store',
                // The request shape is constructed here, never spread from caller-owned input.
                ...(body ? { body: JSON.stringify({ model: body.model, prompt: body.prompt }) } : {}),
                signal: controller.signal,
            });
            // A nonconforming transport might resolve after abort. Do not leave its body open.
            void pending.then(response => { if (controller.signal.aborted) cancelBody(response); }, () => {});
            const response = await abortable(pending, controller.signal);
            if (!response.ok) {
                cancelBody(response);
                const kind = response.status === 401 ? 'authentication' : response.status === 403 ? 'forbidden'
                    : response.status === 429 ? 'rate_limit' : response.status === 503 ? 'unavailable' : 'http';
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

    return {
        async listModels(signal?: AbortSignal): Promise<WorkMockModel[]> {
            return request('models', undefined, signal, async (response, requestSignal) => {
                let text = '';
                for await (const chunk of textChunks(response, requestSignal, MAX_LINE_LENGTH)) text += chunk;
                const value = parseJSON(text);
                if (!record(value) || value.mode !== 'mock' || value.billable !== false
                    || !Array.isArray(value.models) || value.models.length < 1 || value.models.length > MODEL_IDS.length) {
                    throw new WorkMockError('invalid_response');
                }
                const ids = new Set<string>();
                return value.models.map((model: unknown) => {
                    if (!record(model) || !validModel(model.id) || ids.has(model.id)
                        || typeof model.name !== 'string' || !model.name.trim() || model.name.length > 120) {
                        throw new WorkMockError('invalid_response');
                    }
                    ids.add(model.id);
                    return { id: model.id, name: model.name };
                });
            });
        },
        async stream(input: { model: string; prompt: string }, onDelta: (text: string) => void, signal?: AbortSignal): Promise<WorkMockUsage> {
            if (!validModel(input.model) || typeof input.prompt !== 'string' || !input.prompt.trim()
                || input.prompt.length > WORK_MOCK_MAX_PROMPT_LENGTH) throw new WorkMockError('invalid_request');
            return request('stream', { model: input.model, prompt: input.prompt }, signal, async (response, requestSignal) => {
                let buffer = '';
                let usage: WorkMockUsage | undefined;
                let done = false;
                function consumeLine(line: string) {
                    if (line.length > MAX_LINE_LENGTH) throw new WorkMockError('response_limit');
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
                                || !/^[a-zA-Z0-9_-]{1,128}$/.test(event.requestId) || event.mock !== true || event.billable !== false) {
                                throw new WorkMockError('invalid_response');
                            }
                            // Project only safe display fields. Never expose identity/session metadata.
                            usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens,
                                model: input.model, requestId: event.requestId, mock: true, billable: false };
                            break;
                        case 'done':
                            if (!usage) throw new WorkMockError('invalid_response');
                            done = true;
                            break;
                        case 'error':
                            if (typeof event.code !== 'string' || typeof event.message !== 'string') throw new WorkMockError('invalid_response');
                            throw new WorkMockError(event.code === 'authorization_revoked' ? 'authentication'
                                : event.code === 'gateway_timeout' ? 'timeout'
                                    : event.code === 'cancelled' ? 'aborted' : 'upstream');
                        default: throw new WorkMockError('invalid_response');
                    }
                }
                for await (const chunk of textChunks(response, requestSignal, WORK_MOCK_MAX_RESPONSE_BYTES)) {
                    buffer += chunk;
                    let newline: number;
                    while ((newline = buffer.indexOf('\n')) >= 0) {
                        consumeLine(buffer.slice(0, newline));
                        buffer = buffer.slice(newline + 1);
                        if (requestSignal.aborted) throw new WorkMockError('aborted');
                    }
                    if (buffer.length > MAX_LINE_LENGTH) throw new WorkMockError('response_limit');
                }
                // NDJSON may end in a complete JSON record without a trailing newline.
                if (buffer.trim()) consumeLine(buffer);
                if (!done || !usage) throw new WorkMockError('truncated_stream');
                return usage;
            });
        },
    };
}
