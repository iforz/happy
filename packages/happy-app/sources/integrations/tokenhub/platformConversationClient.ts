import { WorkMockError, type WorkMockUsage } from './workMockClient';

export interface PlatformTurn {
    id: string;
    user: string;
    assistant: string;
    status: 'streaming' | 'complete' | 'cancelled' | 'failed';
    usage?: WorkMockUsage;
}
export interface PlatformConversation {
    id: string;
    model: string;
    turns: PlatformTurn[];
    updatedAt: number;
}
export interface PlatformConversationSummary {
    id: string;
    model: string;
    title: string;
    updatedAt: number;
    lastStatus?: PlatformTurn['status'];
}
export interface PlatformConversationClientOptions {
    /** Configured same-origin Happy server, not a caller-supplied gateway. */
    baseUrl: string;
    csrf: string;
    origin: string;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
}
export type PlatformConversationImport = Pick<PlatformConversation, 'id' | 'model' | 'turns'>;

export const PLATFORM_CONVERSATION_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const PLATFORM_CONVERSATION_REQUEST_TIMEOUT_MS = 30_000;
const MAX_LIST_BYTES = 512 * 1024;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_TURNS = 100;
const MAX_ASSISTANT_CHARS = 262144;
const MAX_CONVERSATION_CHARS = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRELATION_ID = /^[a-zA-Z0-9_-]{1,128}$/;
type ValidationKind = 'invalid_request' | 'invalid_response';

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function uuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function model(value: unknown): value is string {
    return typeof value === 'string' && !!value.trim() && value.trim() !== 'default' && value.length <= 200;
}
function count(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function status(value: unknown): value is PlatformTurn['status'] {
    return value === 'streaming' || value === 'complete' || value === 'cancelled' || value === 'failed';
}
function assertActive(signal: AbortSignal): void {
    if (signal.aborted) throw new WorkMockError('aborted');
}
function cancelBody(response: Response): void { void response.body?.cancel().catch(() => {}); }

/** Reject promptly and suppress stale results even when a transport ignores abort. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const cleanup = () => signal.removeEventListener('abort', aborted);
        const aborted = () => { cleanup(); reject(new WorkMockError('aborted')); };
        pending.then(value => {
            cleanup();
            if (signal.aborted) reject(new WorkMockError('aborted'));
            else resolve(value);
        }, error => { cleanup(); reject(error); });
        if (signal.aborted) aborted();
        else signal.addEventListener('abort', aborted, { once: true });
    });
}

async function readJSON(response: Response, signal: AbortSignal, limit: number): Promise<unknown> {
    const length = response.headers.get('content-length');
    if (length && /^\d+$/.test(length) && Number(length) > limit) {
        cancelBody(response);
        throw new WorkMockError('response_limit');
    }
    if (!response.body) throw new WorkMockError('invalid_response');
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, text = '';
    try {
        while (true) {
            const { value, done } = await abortable(reader.read(), signal);
            assertActive(signal);
            if (done) break;
            bytes += value.byteLength;
            if (bytes > limit) throw new WorkMockError('response_limit');
            try { text += decoder.decode(value, { stream: true }); }
            catch { throw new WorkMockError('invalid_response'); }
        }
        try { text += decoder.decode(); return JSON.parse(text); }
        catch { throw new WorkMockError('invalid_response'); }
    } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

function parseUsage(value: unknown, kind: ValidationKind): WorkMockUsage {
    if (!record(value) || !count(value.inputTokens) || !count(value.outputTokens) || !model(value.model)
        || !uuid(value.requestId) || value.mock !== false || value.billable !== true || value.accounting !== 'core'
        || (value.coreRequestId !== undefined && (typeof value.coreRequestId !== 'string' || !CORRELATION_ID.test(value.coreRequestId)))) {
        throw new WorkMockError(kind);
    }
    // Display counts and bounded correlation fields only. Never retain identity or credentials.
    return { inputTokens: value.inputTokens, outputTokens: value.outputTokens, model: value.model,
        requestId: value.requestId.toLowerCase(), mock: false, billable: true, accounting: 'core',
        ...(typeof value.coreRequestId === 'string' ? { coreRequestId: value.coreRequestId } : {}) };
}

function parseContent(value: unknown, kind: ValidationKind): PlatformConversationImport {
    if (!record(value) || !uuid(value.id) || !model(value.model) || !Array.isArray(value.turns) || value.turns.length > MAX_TURNS) {
        throw new WorkMockError(kind);
    }
    const ids = new Set<string>();
    let chars = 0;
    const turns = value.turns.map((turn: unknown): PlatformTurn => {
        if (!record(turn) || !uuid(turn.id) || ids.has(turn.id.toLowerCase()) || typeof turn.user !== 'string'
            || !turn.user.trim() || turn.user.length > 16000 || typeof turn.assistant !== 'string'
            || turn.assistant.length > MAX_ASSISTANT_CHARS || !status(turn.status)) throw new WorkMockError(kind);
        chars += turn.user.length + turn.assistant.length;
        if (chars > MAX_CONVERSATION_CHARS) throw new WorkMockError(kind);
        ids.add(turn.id.toLowerCase());
        const usage = turn.usage === undefined ? undefined : parseUsage(turn.usage, kind);
        if (usage && usage.requestId !== turn.id.toLowerCase()) throw new WorkMockError(kind);
        return { id: turn.id.toLowerCase(), user: turn.user, assistant: turn.assistant, status: turn.status,
            ...(usage === undefined ? {} : { usage }) };
    });
    return { id: value.id.toLowerCase(), model: value.model, turns };
}
function parseConversation(value: unknown, expectedId: string): PlatformConversation {
    const parsed = parseContent(value, 'invalid_response');
    if (!record(value) || !count(value.updatedAt) || parsed.id !== expectedId) throw new WorkMockError('invalid_response');
    return { ...parsed, updatedAt: value.updatedAt };
}
function parseList(value: unknown): PlatformConversationSummary[] {
    if (!record(value) || !Array.isArray(value.conversations) || value.conversations.length > 100) throw new WorkMockError('invalid_response');
    const ids = new Set<string>();
    return value.conversations.map((item: unknown): PlatformConversationSummary => {
        if (!record(item) || !uuid(item.id) || ids.has(item.id.toLowerCase()) || !model(item.model)
            || typeof item.title !== 'string' || item.title.length > 120 || !count(item.updatedAt)
            || (item.lastStatus !== undefined && !status(item.lastStatus))) throw new WorkMockError('invalid_response');
        ids.add(item.id.toLowerCase());
        return { id: item.id.toLowerCase(), model: item.model, title: item.title, updatedAt: item.updatedAt,
            ...(item.lastStatus === undefined ? {} : { lastStatus: item.lastStatus }) };
    });
}

/** Account scope comes exclusively from the BFF cookie. No local history is uploaded implicitly. */
export function createPlatformConversationClient(options: PlatformConversationClientOptions) {
    let base: URL;
    try {
        base = new URL(options.baseUrl);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
        if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) || base.username || base.password
            || base.search || base.hash || base.origin !== options.origin
            || typeof options.csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(options.csrf)) throw new Error();
    } catch { throw new WorkMockError('configuration'); }
    const baseUrl = base.toString().replace(/\/+$/, ''), csrf = options.csrf;
    const transport = options.fetch ?? globalThis.fetch;
    if (typeof transport !== 'function') throw new WorkMockError('configuration');

    async function request<T>(path: string, method: 'GET' | 'POST' | 'DELETE', body: string | undefined,
        callerSignal: AbortSignal | undefined, limit: number, parse: (value: unknown) => T): Promise<T> {
        if (callerSignal?.aborted) throw new WorkMockError('aborted');
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        callerSignal?.addEventListener('abort', onAbort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, PLATFORM_CONVERSATION_REQUEST_TIMEOUT_MS);
        try {
            assertActive(controller.signal);
            const pending = transport(`${baseUrl}/v1/tokenhub/platform/conversations${path}`, {
                method, credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal,
                headers: { Accept: 'application/json', 'x-tokenhub-csrf': csrf,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body }),
            });
            void pending.then(response => { if (controller.signal.aborted) cancelBody(response); }, () => {});
            const response = await abortable(pending, controller.signal);
            assertActive(controller.signal);
            if (!response.ok) {
                cancelBody(response);
                const kind = response.status === 401 ? 'authentication' : response.status === 403 ? 'forbidden'
                    : response.status === 409 ? 'request_conflict' : response.status === 429 ? 'rate_limit'
                        : response.status === 503 ? 'unavailable' : 'http';
                throw new WorkMockError(kind, response.status);
            }
            if (response.redirected || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
                cancelBody(response);
                throw new WorkMockError('invalid_response');
            }
            const value = await readJSON(response, controller.signal, limit);
            assertActive(controller.signal);
            const result = parse(value);
            assertActive(controller.signal);
            return result;
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
        list(signal?: AbortSignal): Promise<PlatformConversationSummary[]> {
            return request('', 'GET', undefined, signal, MAX_LIST_BYTES, parseList);
        },
        async get(id: string, signal?: AbortSignal): Promise<PlatformConversation> {
            if (!uuid(id)) throw new WorkMockError('invalid_request');
            id = id.toLowerCase();
            return request(`/${id}`, 'GET', undefined, signal, PLATFORM_CONVERSATION_MAX_RESPONSE_BYTES, value => parseConversation(value, id));
        },
        async remove(id: string, signal?: AbortSignal): Promise<{ deleted: true }> {
            if (!uuid(id)) throw new WorkMockError('invalid_request');
            id = id.toLowerCase();
            return request(`/${id}`, 'DELETE', undefined, signal, 1024, value => {
                if (!record(value) || value.deleted !== true) throw new WorkMockError('invalid_response');
                return { deleted: true };
            });
        },
        async importConversation(value: PlatformConversationImport, signal?: AbortSignal): Promise<PlatformConversation> {
            if (signal?.aborted) throw new WorkMockError('aborted');
            // Construct an allowlisted body, never forward caller identity, timestamps, or snapshots.
            const content = parseContent(value, 'invalid_request'), body = JSON.stringify(content);
            if (!content.turns.length || content.turns.some(turn => turn.status === 'streaming')
                || new TextEncoder().encode(body).byteLength > MAX_IMPORT_BYTES) throw new WorkMockError('invalid_request');
            return request('/import', 'POST', body, signal, PLATFORM_CONVERSATION_MAX_RESPONSE_BYTES, result => parseConversation(result, content.id));
        },
    };
}
