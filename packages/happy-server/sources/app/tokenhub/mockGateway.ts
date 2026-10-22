import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const MOCK_MODELS = Object.freeze([
    { id: 'mock-echo', name: 'Mock echo' },
    { id: 'mock-slow', name: 'Mock slow stream' },
    { id: 'mock-error', name: 'Mock upstream error' },
] as const);
export const mockInput = z.object({ model: z.enum(['mock-echo', 'mock-slow', 'mock-error']), prompt: z.string().trim().min(1).max(4000) }).strict();
export type MockInput = z.infer<typeof mockInput>;
export interface MockIdentity { userId: string; authority: string; issuer: string; subject: string; sessionId: string }
export interface MockUsage extends MockIdentity {
    requestId: string; model: string; inputTokens: number; outputTokens: number;
    mock: true; billable: false;
}
export type MockEvent = { type: 'delta'; text: string }
    | { type: 'usage'; requestId: string; model: string; inputTokens: number; outputTokens: number; mock: true; billable: false }
    | { type: 'done' } | { type: 'error'; code: string; message: string };
const usageSchema = z.object({ type: z.literal('usage'), inputTokens: z.number().int().min(0).max(100000), outputTokens: z.number().int().min(0).max(100000) }).strict();
const upstreamEvent = z.discriminatedUnion('type', [
    z.object({ type: z.literal('delta'), text: z.string().max(8000) }).strict(), usageSchema,
    z.object({ type: z.literal('done') }).strict(),
]);

/** A bounded, process-local diagnostic ledger, never a billing ledger or persistent usage store. */
export class MockUsageLedger {
    private records: MockUsage[] = [];
    append(record: MockUsage) { this.records.push({ ...record }); if (this.records.length > 1000) this.records.shift(); }
    snapshot() { return this.records.map(record => ({ ...record })); }
}

/** Explicit mock mode only. No DNS, real keys, redirects or request-selected upstream URLs. */
export function mockGatewayConfig(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; endpoint?: string } {
    const mode = env.TOKENHUB_GATEWAY_MODE;
    if (mode === undefined || mode === '' || mode === 'disabled') return { enabled: false };
    if (mode !== 'mock') throw new Error('TOKENHUB_GATEWAY_MODE supports only disabled or mock');
    if (env.TOKENHUB_UNIFIED_AUTH !== 'true') throw new Error('Mock gateway requires unified Work authorization');
    const origin = env.TOKENHUB_MOCK_GATEWAY_URL ?? '';
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin)) throw new Error('Mock gateway requires a literal loopback origin');
    const url = new URL(origin);
    if (Number(url.port || 80) > 65535) throw new Error('Invalid mock gateway port');
    return { enabled: true, endpoint: url.origin + '/v1/mock/completions' };
}

interface Dependencies { env?: NodeJS.ProcessEnv; transport?: typeof fetch; ledger?: MockUsageLedger; timeoutMs?: number }
export function createMockGateway(dependencies: Dependencies = {}) {
    const config = mockGatewayConfig(dependencies.env);
    const transport = dependencies.transport ?? fetch;
    const ledger = dependencies.ledger ?? new MockUsageLedger();
    const timeoutMs = dependencies.timeoutMs ?? 30_000;
    return {
        enabled: config.enabled,
        ledger,
        async *stream(input: MockInput, identity: MockIdentity, signal: AbortSignal): AsyncGenerator<MockEvent> {
            if (!config.enabled) throw new Error('Mock gateway disabled');
            const requestId = randomUUID();
            const controller = new AbortController();
            const abort = () => controller.abort(signal.reason);
            if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
            const cancelRead = () => { void reader?.cancel().catch(() => {}); };
            controller.signal.addEventListener('abort', cancelRead, { once: true });
            try {
                // Do not forward a browser token, identity, headers, URL or claimed usage to the mock provider.
                const response = await transport(config.endpoint!, {
                    method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
                    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
                    body: JSON.stringify({ ...mockInput.parse(input), requestId }),
                });
                if (!response.ok || response.headers.get('x-tokenhub-mock') !== 'true'
                    || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-ndjson' || !response.body) {
                    await response.body?.cancel().catch(() => {});
                    throw new Error('upstream');
                }
                reader = response.body.getReader();
                let pending = '', bytes = 0, done = false;
                let usage: z.infer<typeof usageSchema> | undefined;
                const decoder = new TextDecoder('utf-8', { fatal: true });
                for (;;) {
                    if (controller.signal.aborted) throw new Error('aborted');
                    const next = await reader.read();
                    if (controller.signal.aborted) throw new Error('aborted');
                    if (next.done) { pending += decoder.decode(); break; }
                    bytes += next.value.byteLength;
                    if (bytes > 65536) throw new Error('oversized');
                    pending += decoder.decode(next.value, { stream: true });
                    let newline: number;
                    while ((newline = pending.indexOf('\n')) >= 0) {
                        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
                        if (controller.signal.aborted) throw new Error('aborted');
                        if (!line.trim()) continue;
                        if (done) throw new Error('after_done');
                        const event = upstreamEvent.parse(JSON.parse(line));
                        if (event.type === 'delta') { if (usage) throw new Error('after_usage'); yield event; }
                        else if (event.type === 'usage') { if (usage) throw new Error('duplicate_usage'); usage = event; }
                        else { if (!usage) throw new Error('missing_usage'); done = true; }
                    }
                }
                if (pending.trim() || !done || !usage) throw new Error('truncated');
                if (controller.signal.aborted) throw new Error('aborted');
                const record: MockUsage = { ...identity, requestId, model: input.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, mock: true, billable: false };
                ledger.append(record);
                // Public protocol deliberately omits all identity/session fields.
                yield { type: 'usage', requestId, model: record.model, inputTokens: record.inputTokens, outputTokens: record.outputTokens, mock: true, billable: false };
                yield { type: 'done' };
            } catch {
                const revoked = signal.aborted && signal.reason === 'authorization_revoked';
                yield { type: 'error', code: revoked ? 'authorization_revoked' : timedOut ? 'gateway_timeout' : signal.aborted ? 'cancelled' : 'mock_upstream_error',
                    message: revoked ? 'Work authorization expired or was revoked.' : timedOut ? 'Mock gateway timed out.' : signal.aborted ? 'Mock request cancelled.' : 'Mock upstream failed or returned an invalid stream.' };
            } finally {
                clearTimeout(timer);
                signal.removeEventListener('abort', abort);
                controller.signal.removeEventListener('abort', cancelRead);
                controller.abort();
                if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            }
        },
    };
}
export type MockGateway = ReturnType<typeof createMockGateway>;
