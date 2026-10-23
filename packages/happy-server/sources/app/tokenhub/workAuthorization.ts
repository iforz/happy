import { trustedTokenHubOrigin } from './trusted';
import { isIP } from 'node:net';

export const AUTHCENTER_TIMEOUT_MS = 2_000;
export const WORK_REVALIDATE_MS = 15_000;

export interface TokenHubSession {
    authorizationToken: string;
    /** The configured TokenHub origin, also used by the persisted identity binding. */
    authority: string;
    /** Verified SSO assertion issuer, which can differ from Core's fixed tokenapi issuer. */
    issuer: string;
    subject: string;
    publicKey: string;
}
export interface VerifiedWorkSession {
    userId: string;
    expiresAt?: number;
    /** Server-verified attribution only, populated after live authority and persisted binding checks. */
    tokenhub?: { authority: string; issuer: string; subject: string; sessionId: string };
}
interface VerifiedGrant {
    expiresAt: number;
    tokenhub: NonNullable<VerifiedWorkSession['tokenhub']>;
}
export interface WorkClientContext { ip?: string; userAgent?: string }
export interface WorkAuthorization {
    readonly enabled: boolean;
    verifyToken(token: string, context?: WorkClientContext): Promise<VerifiedWorkSession | null>;
    verifyGrant(grant: TokenHubSession, context?: WorkClientContext): Promise<number | null>;
    /** Server-only grant extraction after all live identity checks. Never serialize this result. */
    resolveGatewayGrant?(token: string, context?: WorkClientContext): Promise<{ session: VerifiedWorkSession; authorizationToken: string } | null>;
}
export type WorkRevocationResult = 'revoked' | 'invalid' | 'unavailable';
export interface WorkSessionRevocation {
    readonly enabled: boolean;
    /** Relinquishes only the session embedded in a cryptographically verified Happy token. */
    revokeToken(token: string): Promise<WorkRevocationResult>;
}
interface Binding {
    authority: string;
    issuer: string;
    subject: string;
    accountId: string;
    account: { id: string; publicKey: string };
}
interface Dependencies {
    env?: NodeJS.ProcessEnv;
    transport?: typeof fetch;
    now?: () => number;
    verifyHappyToken?: (token: string) => Promise<{ userId: string; extras?: unknown } | null>;
    findBinding?: (authority: string, subject: string) => Promise<Binding | null>;
}

/** No DNS, alternative IP spellings, credentials, paths, redirects or request-derived URLs. */
export function authcenterOrigin(raw: string): string {
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(raw)) throw new Error('Authcenter must use a literal loopback origin');
    const url = new URL(raw);
    if (Number(url.port || 80) > 65535) throw new Error('Invalid Authcenter port');
    return url.origin;
}

function isGrant(value: unknown, authority: string): value is TokenHubSession {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const grant = value as TokenHubSession;
    return grant.authority === authority && typeof grant.issuer === 'string' && grant.issuer.length > 0 && grant.issuer.length <= 200
        && typeof grant.subject === 'string' && /^[1-9][0-9]*$/.test(grant.subject)
        && typeof grant.publicKey === 'string' && /^[a-f0-9]{64}$/.test(grant.publicKey)
        && typeof grant.authorizationToken === 'string' && grant.authorizationToken.length > 0
        && grant.authorizationToken.length <= 8192 && !/[\r\n]/.test(grant.authorizationToken);
}

/** This is only a purpose/identity filter, not JWT verification. Core alone verifies
 * the Work signature. Never decode a caller token before verifying its signed Happy wrapper. */
function isOwnWorkRevocationToken(grant: TokenHubSession, now: number): boolean {
    try {
        const parts = grant.authorizationToken.split('.');
        if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part)
            || Buffer.from(part, 'base64url').toString('base64url') !== part)
            || Buffer.from(parts[2], 'base64url').length !== 32) return false;
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
        const claims = JSON.parse(payload);
        // Core versions are int64 password fingerprints, often above JS's safe integer
        // range. Preserve JSON number lexemes while skipping every quoted JSON string.
        // This second parse is only a lossless shape check; the original signed JWT is
        // forwarded byte-for-byte and Core performs exact int64/signature/ownership checks.
        const numberLiterals = JSON.parse(payload.replace(
            /"(?:\\.|[^"\\])*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g,
            literal => literal.startsWith('"') ? literal : JSON.stringify(literal),
        ));
        const version = numberLiterals.token_version;
        if (!header || header.alg !== 'HS256' || !claims || claims.iss !== 'tokenapi'
            || !Array.isArray(claims.aud) || claims.aud.length !== 1 || claims.aud[0] !== 'work'
            || claims.sub !== grant.subject || BigInt(grant.subject) > 9223372036854775807n
            || typeof claims.sid !== 'string' || !claims.sid || claims.sid.length > 256 || /\s/.test(claims.sid)
            || typeof claims.token_version !== 'number' || typeof version !== 'string'
            || !/^(?:0|[1-9][0-9]*)$/.test(version) || BigInt(version) > 9223372036854775807n) return false;
        if (![claims.exp, claims.iat, claims.nbf].every(date => Number.isSafeInteger(date) && date > 0)
            || claims.exp < claims.iat || claims.exp < claims.nbf
            || claims.iat > Math.floor(now / 1000) || claims.nbf > Math.floor(now / 1000)) return false;
        // exp may be in the past: logout relinquishes authority, never grants access.
        return true;
    } catch { return false; }
}

function matchesBinding(binding: Binding | null, grant: TokenHubSession, userId: string): boolean {
    return !!binding && binding.authority === grant.authority && binding.issuer === grant.issuer && binding.subject === grant.subject
        && binding.accountId === userId && binding.account?.id === userId && binding.account.publicKey === grant.publicKey;
}

async function readResponse(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Authority unavailable');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Authority response missing');
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            if (signal.aborted) throw new Error('Authority response aborted');
            const next = await reader.read();
            if (next.done) break;
            size += next.value.length;
            if (size > 16384) throw new Error('Authority response too large');
            chunks.push(next.value);
        }
    } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
    } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid authority response');
    return result as Record<string, unknown>;
}

/** Construct once at API startup. Only cryptographic identity is local; authorization is never cached. */
export function createWorkAuthorization(dependencies: Dependencies = {}): WorkAuthorization & WorkSessionRevocation {
    const env = dependencies.env ?? process.env;
    if (env.TOKENHUB_UNIFIED_AUTH && !['true', 'false'].includes(env.TOKENHUB_UNIFIED_AUTH)) throw new Error('Invalid TOKENHUB_UNIFIED_AUTH');
    const enabled = env.TOKENHUB_UNIFIED_AUTH === 'true';
    const authcenter = enabled ? authcenterOrigin(env.TOKENHUB_AUTHCENTER_URL ?? '') : '';
    const endpoint = authcenter + '/v1/session/verify';
    const authority = enabled ? trustedTokenHubOrigin(env.TOKENHUB_URL) : '';
    const now = dependencies.now ?? Date.now;
    const transport = dependencies.transport ?? fetch;
    const verifyHappyToken = dependencies.verifyHappyToken ?? (async (token) =>
        (await import('@/app/auth/auth')).auth.verifyToken(token, { cache: !enabled }));
    const findBinding = dependencies.findBinding ?? (async (origin, subject) =>
        (await import('@/storage/db')).db.tokenHubIdentity.findUnique({
            where: { authority_subject: { authority: origin, subject } }, include: { account: true },
        }));

    async function verifyGrantDetails(grant: TokenHubSession, context: WorkClientContext = {}): Promise<VerifiedGrant | null> {
        if (!enabled || !isGrant(grant, authority)) return null;
        // Only framework-resolved peer addresses, never arbitrary forwarded request headers.
        const ip = context.ip?.startsWith('::ffff:') && isIP(context.ip.slice(7)) === 4 ? context.ip.slice(7) : context.ip;
        const contextHeaders: Record<string, string> = {};
        if (ip && isIP(ip)) contextHeaders['X-Client-IP'] = ip;
        if (typeof context.userAgent === 'string' && context.userAgent.length <= 2048 && !/[\r\n]/.test(context.userAgent)) contextHeaders['User-Agent'] = context.userAgent;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            // Race the entire fetch/body operation, not just headers. A hung authority fails closed.
            const timeout = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new Error('Authority timeout')); }, AUTHCENTER_TIMEOUT_MS);
            });
            const result = await Promise.race([
                transport(endpoint, {
                    method: 'POST', credentials: 'omit', redirect: 'error', signal: controller.signal,
                    headers: { Authorization: `Bearer ${grant.authorizationToken}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Cache-Control': 'no-store', ...contextHeaders },
                    body: JSON.stringify({ application: 'work' }),
                }).then(response => readResponse(response, controller.signal)), timeout,
            ]);
            if (result.active !== true || result.application !== 'work'
                || result.subject !== grant.subject || result.issuer !== 'tokenapi'
                || typeof result.session_id !== 'string' || !result.session_id || result.session_id.length > 256
                || !Array.isArray(result.permissions) || !result.permissions.includes('work:access')
                || typeof result.expires_at !== 'number' || !Number.isSafeInteger(result.expires_at)
                || !Number.isSafeInteger(result.expires_at * 1000)
                || result.expires_at * 1000 <= now()) return null;
            return {
                expiresAt: result.expires_at * 1000,
                tokenhub: { authority, issuer: result.issuer, subject: result.subject, sessionId: result.session_id },
            };
        } catch { return null; }
        finally { if (timer) clearTimeout(timer); controller.abort(); }
    }

    async function verifyGrant(grant: TokenHubSession, context?: WorkClientContext): Promise<number | null> {
        return (await verifyGrantDetails(grant, context))?.expiresAt ?? null;
    }

    async function resolveToken(token: string, context?: WorkClientContext): Promise<{ session: VerifiedWorkSession; authorizationToken?: string } | null> {
        const verify = async (): Promise<{ session: VerifiedWorkSession; authorizationToken?: string } | null> => {
            try {
                if (typeof token !== 'string' || !token || token.length > 32768) return null;
                const happy = await verifyHappyToken(token);
                if (!happy || typeof happy.userId !== 'string' || !happy.userId) return null;
                if (!enabled) return { session: { userId: happy.userId } };
                const grant = (happy.extras as { tokenhub?: unknown } | undefined)?.tokenhub;
                if (!isGrant(grant, authority)) return null;
                const verifiedGrant = await verifyGrantDetails(grant, context);
                if (verifiedGrant === null) return null;
                const { expiresAt, tokenhub } = verifiedGrant;
                const binding = await findBinding(authority, grant.subject);
                if (!matchesBinding(binding, grant, happy.userId) || expiresAt <= now()) return null;
                return { session: { userId: happy.userId, expiresAt, tokenhub }, authorizationToken: grant.authorizationToken };
            } catch { return null; }
        };
        if (!enabled) return verify();
        // Also bound local crypto/database stalls so idle rechecks cannot get stuck forever.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([verify(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), AUTHCENTER_TIMEOUT_MS); })]);
        } finally { if (timer) clearTimeout(timer); }
    }

    const service: WorkAuthorization & WorkSessionRevocation = {
        enabled, verifyGrant,
        async resolveGatewayGrant(token, context) {
            if (!enabled) return null;
            const result = await resolveToken(token, context);
            return result?.authorizationToken ? { session: result.session, authorizationToken: result.authorizationToken } : null;
        },
        async revokeToken(token): Promise<WorkRevocationResult> {
            if (!enabled) return 'unavailable'; // Never downgrade into non-unified Happy logout.
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const revoke = async (): Promise<WorkRevocationResult> => {
                if (typeof token !== 'string' || !token || token.length > 32768 || /\s/.test(token)) return 'invalid';
                // Default verifier disables Happy's positive cache in unified mode. Persistent
                // Happy token validity (including any library time checks) is never bypassed.
                const happy = await verifyHappyToken(token);
                if (controller.signal.aborted) return 'unavailable';
                if (!happy || typeof happy.userId !== 'string' || !happy.userId) return 'invalid';
                const grant = (happy.extras as { tokenhub?: unknown } | undefined)?.tokenhub;
                if (!isGrant(grant, authority) || !isOwnWorkRevocationToken(grant, now())) return 'invalid';
                const binding = await findBinding(authority, grant.subject);
                if (controller.signal.aborted) return 'unavailable';
                if (!matchesBinding(binding, grant, happy.userId)) return 'invalid';
                // No live /verify call: disabled users, expired grants, and an already revoked
                // session must still be able to relinquish the same signed SID at Core.
                const response = await transport(authcenter + '/v1/session/revoke', {
                    method: 'POST', credentials: 'omit', redirect: 'error', signal: controller.signal,
                    headers: { Authorization: `Bearer ${grant.authorizationToken}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Cache-Control': 'no-store' },
                    body: JSON.stringify({ application: 'work' }),
                });
                if (response.status === 401 || response.status === 403) {
                    void response.body?.cancel().catch(() => {});
                    return 'invalid';
                }
                if (response.status !== 200) {
                    void response.body?.cancel().catch(() => {});
                    return 'unavailable';
                }
                const result = await readResponse(response, controller.signal);
                return !controller.signal.aborted && Object.keys(result).length === 2
                    && result.revoked === true && result.application === 'work' ? 'revoked' : 'unavailable';
            };
            try {
                return await Promise.race([revoke(), new Promise<WorkRevocationResult>(resolve => {
                    timer = setTimeout(() => { controller.abort(); resolve('unavailable'); }, AUTHCENTER_TIMEOUT_MS);
                })]);
            } catch { return 'unavailable'; }
            finally { if (timer) clearTimeout(timer); controller.abort(); }
        },
        async verifyToken(token, context) { return (await resolveToken(token, context))?.session ?? null; },
    };
    return service;
}

let authorization: (WorkAuthorization & WorkSessionRevocation) | undefined;
export function getWorkAuthorization(): WorkAuthorization & WorkSessionRevocation {
    return authorization ??= createWorkAuthorization();
}
