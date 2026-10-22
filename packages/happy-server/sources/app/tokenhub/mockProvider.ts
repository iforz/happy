import { createServer } from 'node:http';
import { z } from 'zod';
import { mockInput } from './mockGateway';

const inputSchema = mockInput.extend({ requestId: z.string().uuid() }).strict();
/** Offline fixture only. No provider SDKs, credentials, networking, persistence or charging. */
export function createMockProvider(hooks: {
    onRequest?: (input: z.infer<typeof inputSchema>) => void;
    onCancel?: () => void;
    chunkDelayMs?: number;
} = {}) {
    return createServer(async (request, response) => {
        if (request.method !== 'POST' || request.url !== '/v1/mock/completions') { response.writeHead(404).end(); return; }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let complete = false, closed = false;
        response.on('close', () => { closed = true; if (timer) clearTimeout(timer); if (!complete) hooks.onCancel?.(); });
        try {
            const bodyChunks: Buffer[] = [];
            let bytes = 0;
            for await (const chunk of request) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                bytes += buffer.length;
                if (bytes > 32768) { response.writeHead(413).end(); return; }
                bodyChunks.push(buffer);
            }
            const input = inputSchema.parse(JSON.parse(Buffer.concat(bodyChunks).toString('utf8')));
            hooks.onRequest?.(input);
            if (input.model === 'mock-error') { complete = true; response.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":"Simulated mock provider failure"}'); return; }
            response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-TokenHub-Mock': 'true' });
            const chunks = [`[${input.model}] `, 'This is a local mock, not an AI provider. ', 'You wrote: ', input.prompt];
            const delay = hooks.chunkDelayMs ?? (input.model === 'mock-slow' ? 700 : 100);
            const writeNext = (index: number) => {
                if (closed) return;
                if (index < chunks.length) {
                    response.write(JSON.stringify({ type: 'delta', text: chunks[index] }) + '\n');
                    timer = setTimeout(() => writeNext(index + 1), delay);
                } else {
                    // Deliberately synthetic character-based counts, not model tokenization.
                    response.write(JSON.stringify({ type: 'usage', inputTokens: Math.ceil(input.prompt.length / 4), outputTokens: Math.ceil(chunks.join('').length / 4) }) + '\n');
                    complete = true;
                    response.end('{"type":"done"}\n');
                }
            };
            writeNext(0);
        } catch { complete = true; if (!response.headersSent) response.writeHead(400); response.end(); }
    });
}
