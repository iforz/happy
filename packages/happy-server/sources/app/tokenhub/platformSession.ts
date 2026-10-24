import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { authcenterOrigin, AUTHCENTER_TIMEOUT_MS, type WorkClientContext } from './workAuthorization';

export const PLATFORM_SESSION_COOKIE = '__Host-tokenhub-platform';
export const PLATFORM_FLOW_COOKIE = '__Host-tokenhub-platform-flow';
export const PLATFORM_CSRF_HEADER = 'x-tokenhub-csrf';
const FLOW_LIFETIME_MS = 5 * 60_000;
const MAX_SESSION_LIFETIME_MS = 24 * 60 * 60_000;
const opaque = () => randomBytes(32).toString('base64url');
export const validOpaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export function equalOpaque(left: unknown, right: unknown): boolean {
    return validOpaque(left) && validOpaque(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export interface PlatformPrincipal {
    kind: 'platform'; authority: string; issuer: string; subject: string; sessionId: string; expiresAt: number;
}
export interface PlatformRecord {
    principal: PlatformPrincipal;
    /** Server-only. Never put this record in a response, log or browser storage. */
    grant: string;
    csrf: string;
    streams: Set<AbortController>;
}
export interface PlatformFlow { state: string; nonce: string; verifier: string; binding: string; expiresAt: number }
export class PlatformCapacityError extends Error {}

/** Deliberately independent of Happy account IDs, public keys and identity bindings. */
export class PlatformSessionStore {
    private sessions = new Map<string, PlatformRecord>();
    private flows = new Map<string, PlatformFlow>();
    private activeFlows = new Map<string, PlatformFlow>();
    constructor(private now = Date.now, private maxSessions = 5000, private maxFlows = 5000) {}
    private prune() {
        for (const [key, value] of this.sessions) if (value.principal.expiresAt <= this.now()) this.removeHashed(key);
        for (const [key, value] of this.activeFlows) if (value.expiresAt <= this.now()) this.cancelFlow(key);
    }
    start(): PlatformFlow {
        this.prune();
        if (this.activeFlows.size >= this.maxFlows) throw new PlatformCapacityError('Platform flow capacity reached');
        const flow = { state: opaque(), nonce: opaque(), verifier: opaque(), binding: opaque(), expiresAt: this.now() + FLOW_LIFETIME_MS };
        this.flows.set(flow.state, flow);
        this.activeFlows.set(flow.binding, flow);
        return flow;
    }
    consume(state: string, binding: string): PlatformFlow {
        this.prune();
        const flow = this.flows.get(state);
        if (!flow || !equalOpaque(binding, flow.binding)) throw new Error('Invalid platform login state');
        this.flows.delete(state);
        return flow;
    }
    isCurrentFlow(flow: PlatformFlow) { this.prune(); return this.activeFlows.get(flow.binding) === flow; }
    cancelFlow(binding: string) {
        const flow = this.activeFlows.get(binding);
        if (flow) this.flows.delete(flow.state);
        this.activeFlows.delete(binding);
    }
    create(principal: PlatformPrincipal, grant: string): { id: string; record: PlatformRecord } {
        this.prune();
        if (this.sessions.size >= this.maxSessions) throw new PlatformCapacityError('Platform session capacity reached');
        const id = opaque(), record = {
            principal: { ...principal, expiresAt: Math.min(principal.expiresAt, this.now() + MAX_SESSION_LIFETIME_MS) },
            grant, csrf: opaque(), streams: new Set<AbortController>(),
        };
        this.sessions.set(createHash('sha256').update(id).digest('hex'), record);
        return { id, record };
    }
    get(id: string): PlatformRecord | undefined {
        this.prune();
        return validOpaque(id) ? this.sessions.get(createHash('sha256').update(id).digest('hex')) : undefined;
    }
    remove(id: string) {
        if (validOpaque(id)) this.removeHashed(createHash('sha256').update(id).digest('hex'));
    }
    private removeHashed(key: string) {
        const record = this.sessions.get(key);
        this.sessions.delete(key);
        for (const controller of record?.streams ?? []) controller.abort('authorization_revoked');
        record?.streams.clear();
    }
    clear() {
        for (const key of this.sessions.keys()) this.removeHashed(key);
        this.flows.clear();
        this.activeFlows.clear();
    }
}

/** Ambiguous duplicate cookies are rejected rather than selecting an attacker-controlled value. */
export function readPlatformCookie(header: string | undefined, name: string): string {
    const values = (header ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
    const value = values.length === 1 ? values[0].slice(name.length + 1) : '';
    return validOpaque(value) ? value : '';
}
export function platformCookie(name: string, value: string, maxAge: number): string {
    return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}
export function publicPlatformSession(record: PlatformRecord) {
    const { authority, issuer, subject, sessionId, expiresAt } = record.principal;
    return { authority, issuer, subject, sessionId, expiresAt, csrf: record.csrf };
}

export class PlatformAuthorityError extends Error {
    constructor(public readonly status: 401 | 503) { super('Platform authorization unavailable'); }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new PlatformAuthorityError(503);
    const reader = response.body?.getReader();
    if (!reader) throw new PlatformAuthorityError(503);
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    let length = 0; const chunks: Uint8Array[] = [];
    try {
        for (;;) {
            if (signal.aborted) throw new PlatformAuthorityError(503);
            const next = await reader.read();
            if (next.done) break;
            length += next.value.length;
            if (length > 16384) throw new PlatformAuthorityError(503);
            chunks.push(next.value);
        }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlatformAuthorityError(503);
        return value as Record<string, unknown>;
    } finally { signal.removeEventListener('abort', abort); abort(); reader.releaseLock(); }
}

export function createPlatformAuthority(options: { env: NodeJS.ProcessEnv; transport?: typeof fetch; now?: () => number }) {
    const origin = authcenterOrigin(options.env.TOKENHUB_AUTHCENTER_URL ?? '');
    const transport = options.transport ?? fetch, now = options.now ?? Date.now;
    return {
        async verify(grant: string, authority: string, expectedSubject: string, context: WorkClientContext): Promise<PlatformPrincipal> {
            if (!grant || grant.length > 8192 || /\s/.test(grant)) throw new PlatformAuthorityError(401);
            const ip = context.ip?.startsWith('::ffff:') ? context.ip.slice(7) : context.ip;
            if (!ip || !isIP(ip) || typeof context.userAgent !== 'string' || !context.userAgent || context.userAgent.length > 2048 || /[\r\n]/.test(context.userAgent)) throw new PlatformAuthorityError(401);
            const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const result = await Promise.race([
                    (async () => {
                        const response = await transport(origin + '/v1/session/verify', {
                            method: 'POST', credentials: 'omit', redirect: 'error', signal: controller.signal,
                            headers: { Authorization: `Bearer ${grant}`, Accept: 'application/json', 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Client-IP': ip, 'User-Agent': context.userAgent! },
                            body: JSON.stringify({ application: 'work' }),
                        });
                        if (response.status === 401 || response.status === 403) { void response.body?.cancel().catch(() => {}); throw new PlatformAuthorityError(401); }
                        return boundedJson(response, controller.signal);
                    })(),
                    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new PlatformAuthorityError(503)); }, AUTHCENTER_TIMEOUT_MS); }),
                ]);
                if (result.active !== true || result.application !== 'work' || result.issuer !== 'tokenapi'
                    || result.subject !== expectedSubject || !/^[1-9][0-9]{0,18}$/.test(expectedSubject) || BigInt(expectedSubject) > 9223372036854775807n
                    || typeof result.session_id !== 'string' || !result.session_id || result.session_id.length > 200 || /\s/.test(result.session_id)
                    || !Array.isArray(result.permissions) || result.permissions.length !== 1 || result.permissions[0] !== 'work:access'
                    || typeof result.expires_at !== 'number' || !Number.isSafeInteger(result.expires_at) || !Number.isSafeInteger(result.expires_at * 1000)
                    || result.expires_at * 1000 <= now()) throw new PlatformAuthorityError(401);
                return { kind: 'platform', authority, issuer: 'tokenapi', subject: expectedSubject, sessionId: result.session_id, expiresAt: result.expires_at * 1000 };
            } catch (error) {
                if (error instanceof PlatformAuthorityError) throw error;
                throw new PlatformAuthorityError(503);
            } finally { if (timer) clearTimeout(timer); controller.abort(); }
        },
    };
}
