import { coreDiagnostic } from './coreDiagnostic';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { authcenterOrigin, type WorkClientContext } from './workAuthorization';

export const conversationMessages = z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(16000) }).strict()).min(1).max(49).refine(messages => messages.length % 2 === 1 && messages.every((m, i) => m.role === (i % 2 ? 'assistant' : 'user') && m.content.trim()) && messages.reduce((n, m) => n + m.content.length, 0) <= 16000);
export const coreInput = z.object({ model: z.string().trim().min(1).max(200).refine(model=>model!=='default'), prompt: z.string().trim().min(1).max(4000).optional(), messages: conversationMessages.optional(), requestId: z.string().uuid().optional() }).strict().refine(input => (input.prompt !== undefined) !== (input.messages !== undefined));
export type CoreInput = z.infer<typeof coreInput>;
export type CoreEvent = { type: 'delta'; text: string } | { type: 'usage'; requestId: string; coreRequestId?: string; model: string; inputTokens: number; outputTokens: number; mock: false; billable: true; accounting: 'core' }
    | { type: 'done' } | { type: 'error'; code: string; message: string };
class CoreReconciliationRequired extends Error {}
export class CoreGatewayError extends Error {
    constructor(public readonly status: number, public readonly code?: string) { super('Core gateway request failed'); }
}

export function coreGatewayConfig(env: NodeJS.ProcessEnv = process.env) {
    const mode = env.TOKENHUB_GATEWAY_MODE;
    if (!mode || mode === 'disabled' || mode === 'mock') return { enabled: false, origin: '' };
    if (mode !== 'real') throw new Error('Invalid TOKENHUB_GATEWAY_MODE');
    if (env.TOKENHUB_UNIFIED_AUTH !== 'true') throw new Error('Real gateway requires unified authorization');
    return { enabled: true, origin: authcenterOrigin(env.TOKENHUB_CORE_GATEWAY_URL ?? '') };
}

/** Only framework-resolved IP and bounded user agent; never copy incoming headers wholesale. */
function headers(grant: string, context: WorkClientContext): Record<string, string> {
    if (!grant || grant.length > 8192 || /\s/.test(grant)) throw new Error('Invalid Work grant');
    const result: Record<string, string> = { Authorization: `Bearer ${grant}`, 'Cache-Control': 'no-store' };
    const ip = context.ip?.startsWith('::ffff:') ? context.ip.slice(7) : context.ip;
    if (ip && isIP(ip)) result['X-Client-IP'] = ip;
    if (context.userAgent && context.userAgent.length <= 2048 && !/[\r\n]/.test(context.userAgent)) result['User-Agent'] = context.userAgent;
    return result;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

async function* chunks(response: Response, signal: AbortSignal, limit: number) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing response');
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    try {
        for (;;) {
            if (signal.aborted) throw new Error('Aborted');
            const next = await reader.read();
            if (signal.aborted) throw new Error('Aborted');
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > limit) throw new Error('Response too large');
            yield decoder.decode(next.value, { stream: true });
        }
        yield decoder.decode();
    } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}

interface Dependencies { env?: NodeJS.ProcessEnv; transport?: typeof fetch; timeoutMs?: number }
/** No provider credentials, key creation, accounting state or automatic inference retries. */
export function createCoreGateway(dependencies: Dependencies = {}) {
    const config = coreGatewayConfig(dependencies.env);
    const transport = dependencies.transport ?? fetch;
    const timeoutMs = dependencies.timeoutMs ?? 120_000;
    function deadline(signal: AbortSignal) {
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        const timer = setTimeout(() => controller.abort('gateway_timeout'), timeoutMs);
        return { controller, close: () => { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); } };
    }
    async function request(path: string, grant: string, context: WorkClientContext, signal: AbortSignal, body?: unknown, requestId?: string) {
        if (!config.enabled) throw new CoreGatewayError(503);
        if (signal.aborted) throw new Error('Aborted');
        const response = await transport(config.origin + path, {
            method: body ? 'POST' : 'GET', credentials: 'omit', redirect: 'error', signal,
            headers: { ...headers(grant, context), ...(requestId ? { 'X-Work-Request-ID': requestId } : {}), Accept: body ? 'text/event-stream' : 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) {
            let diagnostic: string | undefined;
            if (!body && response.status === 503) {
                try { let raw = ''; for await (const chunk of chunks(response, signal, 4096)) raw += chunk; diagnostic = coreDiagnostic(response.status, raw); } catch { /* Bounded diagnostics are optional. */ }
            } else { void response.body?.cancel().catch(() => {}); }
            throw new CoreGatewayError([400, 401, 402, 403, 409, 429, 503].includes(response.status) ? response.status : 502, diagnostic);
        }
        return response;
    }
    return {
        enabled: config.enabled,
        async models(grant: string, context: WorkClientContext, signal: AbortSignal) {
            const d = deadline(signal);
            try {
                const response = await request('/api/v1/work/models', grant, context, d.controller.signal);
                if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') { void response.body?.cancel().catch(() => {}); throw new Error('Invalid response'); }
                let data = ''; for await (const chunk of chunks(response, d.controller.signal, 256 * 1024)) data += chunk;
                const value: unknown = JSON.parse(data);
                if (!record(value) || !Array.isArray(value.data) || value.data.length > 1000) throw new Error('Invalid model catalog');
                const ids = new Set<string>();
                const models = value.data.map((model: unknown) => {
                    if (!record(model) || typeof model.id !== 'string' || !model.id.trim() || model.id.length > 200 || ids.has(model.id)) throw new Error('Invalid model');
                    ids.add(model.id);
                    return { id: model.id, name: model.id };
                });
                return { mode: 'real' as const, billable: true as const, models:models.filter(model=>model.id!=='default') };
            } finally { d.close(); }
        },
        async *stream(input: CoreInput, grant: string, context: WorkClientContext, signal: AbortSignal): AsyncGenerator<CoreEvent> {
            const d = deadline(signal);
            let requestId: string = randomUUID();
            try {
                const safe = coreInput.parse(input);
                requestId = safe.requestId ?? requestId;
                const response = await request('/api/v1/work/chat/completions', grant, context, d.controller.signal, {
                    model: safe.model, messages: safe.messages ?? [{ role: 'user', content: safe.prompt! }], stream: true, stream_options: { include_usage: true },
                }, requestId);
                const coreRequestId = response.headers.get('x-request-id');
                const correlation = coreRequestId && /^[A-Za-z0-9_-]{1,128}$/.test(coreRequestId) ? coreRequestId : undefined;
                if (response.headers.get('content-type')?.split(';')[0].trim() !== 'text/event-stream') { void response.body?.cancel().catch(() => {}); throw new Error('Invalid response'); }
                let buffer = '', eventData: string[] = [], done = false, usage: { inputTokens: number; outputTokens: number } | undefined;
                function parseEvent(): CoreEvent | undefined {
                    if (!eventData.length) return;
                    const data = eventData.join('\n'); eventData = [];
                    if (done) throw new Error('Data after done');
                    if (data === '[DONE]') { done = true; return; }
                    const event: unknown = JSON.parse(data);
                    if (record(event) && record(event.error) && event.error.type === 'work_reconciliation_required') throw new CoreReconciliationRequired();
                    if (!record(event) || event.error || !Array.isArray(event.choices)) throw new Error('Invalid chunk');
                    if (event.usage !== undefined && event.usage !== null) {
                        if (usage || !record(event.usage) || !count(event.usage.prompt_tokens) || !count(event.usage.completion_tokens)) throw new Error('Invalid usage');
                        usage = { inputTokens: event.usage.prompt_tokens, outputTokens: event.usage.completion_tokens };
                    }
                    let text = '';
                    for (const choice of event.choices) {
                        if (!record(choice) || !record(choice.delta)) throw new Error('Invalid choice');
                        if (choice.delta.content !== undefined && choice.delta.content !== null) {
                            if (typeof choice.delta.content !== 'string' || usage) throw new Error('Invalid delta');
                            text += choice.delta.content;
                        }
                    }
                    if (text) return { type: 'delta', text };
                }
                for await (const chunk of chunks(response, d.controller.signal, 8 * 1024 * 1024)) {
                    buffer += chunk;
                    let newline: number;
                    while ((newline = buffer.indexOf('\n')) >= 0) {
                        const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
                        if (line.length > 65536) throw new Error('Event too large');
                        if (!line) { const event = parseEvent(); if (event) yield event; }
                        else if (line.startsWith('data:')) { eventData.push(line.slice(5).replace(/^ /, '')); if (eventData.join('\n').length > 65536) throw new Error('Event too large'); }
                    }
                    if (buffer.length > 65536) throw new Error('Event too large');
                }
                if (buffer.trim() || eventData.length || !done) throw new Error('Truncated stream');
                if (!usage) { yield { type: 'error', code: 'usage_unavailable', message: 'Usage is unavailable. Core accounting remains authoritative; do not automatically retry.' }; return; }
                // Provider counts are display data, not evidence that Core settlement completed.
                yield { type: 'usage', requestId, ...(correlation ? { coreRequestId: correlation } : {}), model: safe.model, ...usage, mock: false, billable: true, accounting: 'core' };
                yield { type: 'done' };
            } catch (error) {
                const reason = d.controller.signal.reason;
                const code = error instanceof CoreReconciliationRequired ? 'work_reconciliation_required' : reason === 'authorization_revoked' ? 'authorization_revoked' : reason === 'gateway_timeout' ? 'gateway_timeout' : signal.aborted ? 'cancelled'
                    : error instanceof CoreGatewayError && error.status === 409 ? 'request_conflict' : error instanceof CoreGatewayError && error.status === 429 ? 'rate_limited' : error instanceof CoreGatewayError && error.status === 402 ? 'quota_exceeded' : error instanceof CoreGatewayError && error.status === 403 ? 'access_or_quota_denied' : error instanceof CoreGatewayError && error.status === 401 ? 'authorization_revoked' : 'core_gateway_error';
                yield { type: 'error', code, message: 'The request did not complete. Core accounting remains authoritative; do not automatically retry.' };
            } finally { d.close(); }
        },
    };
}
export type CoreGateway = ReturnType<typeof createCoreGateway>;
