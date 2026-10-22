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
export function createWorkAuthorization(dependencies: Dependencies = {}): WorkAuthorization {
    const env = dependencies.env ?? process.env;
    if (env.TOKENHUB_UNIFIED_AUTH && !['true', 'false'].includes(env.TOKENHUB_UNIFIED_AUTH)) throw new Error('Invalid TOKENHUB_UNIFIED_AUTH');
    const enabled = env.TOKENHUB_UNIFIED_AUTH === 'true';
    const endpoint = enabled ? authcenterOrigin(env.TOKENHUB_AUTHCENTER_URL ?? '') + '/v1/session/verify' : '';
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

    return {
        enabled, verifyGrant,
        async verifyToken(token, context) {
            const verify = async (): Promise<VerifiedWorkSession | null> => {
                try {
                    if (typeof token !== 'string' || !token || token.length > 32768) return null;
                    const happy = await verifyHappyToken(token);
                    if (!happy || typeof happy.userId !== 'string' || !happy.userId) return null;
                    if (!enabled) return { userId: happy.userId };
                    const grant = (happy.extras as { tokenhub?: unknown } | undefined)?.tokenhub;
                    if (!isGrant(grant, authority)) return null;
                    const verifiedGrant = await verifyGrantDetails(grant, context);
                    if (verifiedGrant === null) return null;
                    const { expiresAt, tokenhub } = verifiedGrant;
                    const binding = await findBinding(authority, grant.subject);
                    if (!binding || binding.authority !== authority || binding.issuer !== grant.issuer || binding.subject !== grant.subject
                        || binding.accountId !== happy.userId || binding.account?.id !== happy.userId
                        || binding.account.publicKey !== grant.publicKey || expiresAt <= now()) return null;
                    return { userId: happy.userId, expiresAt, tokenhub };
                } catch { return null; }
            };
            if (!enabled) return verify();
            // Also bound local crypto/database stalls so idle rechecks cannot get stuck forever.
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                return await Promise.race([verify(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), AUTHCENTER_TIMEOUT_MS); })]);
            } finally { if (timer) clearTimeout(timer); }
        },
    };
}

let authorization: WorkAuthorization | undefined;
export function getWorkAuthorization(): WorkAuthorization {
    return authorization ??= createWorkAuthorization();
}
