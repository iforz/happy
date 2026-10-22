import { isIP } from 'node:net';

export function trustedTokenHubOrigin(raw = process.env.TOKENHUB_URL ?? ''): string {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/' || (u.port && u.port !== '443') || isIP(u.hostname.replace(/^\[|\]$/g, '')) || u.hostname === 'localhost' || u.hostname.endsWith('.localhost')) {
        throw new Error('Invalid TokenHub origin');
    }
    return u.origin;
}
const allowedPaths = new Set(['/api/v1/settings/happy', '/api/v1/auth/happy/metadata', '/api/v1/auth/sso/jwks', '/api/v1/auth/happy/exchange']);
export async function trustedJson(origin: string, path: string, init: RequestInit = {}, transport: typeof fetch = fetch): Promise<unknown> {
    if (!allowedPaths.has(path)) throw new Error('Untrusted endpoint');
    trustedTokenHubOrigin(origin);
    const response = await transport(origin + path, { ...init, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json', ...init.headers } });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('TokenHub unavailable');
    const reader = response.body?.getReader(); if (!reader) throw new Error('Missing body');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 65536) throw new Error('Oversized response'); chunks.push(next.value); }
    } catch (error) { await reader.cancel(); throw error; }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function unwrap(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response');
    const root = value as Record<string, unknown>;
    if (root.code !== 0 || !root.data || typeof root.data !== 'object' || Array.isArray(root.data)) throw new Error('Invalid response');
    return root.data as Record<string, unknown>;
}
