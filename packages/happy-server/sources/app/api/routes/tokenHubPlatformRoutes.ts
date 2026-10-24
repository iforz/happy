import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Fastify } from '../types';
import { coreInput, CoreGatewayError, createCoreGateway, type CoreGateway } from '@/app/tokenhub/coreGateway';
import { workClientContext } from '@/app/tokenhub/clientContext';
import { verifyIdentity } from '@/app/tokenhub/flow';
import { loadPageConfig } from '@/app/tokenhub/pageConfig';
import { trustedJson, trustedTokenHubOrigin, unwrap } from '@/app/tokenhub/trusted';
import { WORK_REVALIDATE_MS } from '@/app/tokenhub/workAuthorization';
import {
    createPlatformAuthority, equalOpaque, platformCookie, PlatformAuthorityError, PlatformCapacityError, PlatformSessionStore,
    PLATFORM_CSRF_HEADER, PLATFORM_SESSION_COOKIE, publicPlatformSession, readPlatformCookie,
    type PlatformFlow, type PlatformPrincipal, type PlatformRecord,
} from '@/app/tokenhub/platformSession';

/** Exact methods only. The independent validators below replace legacy auth here,
 * not on arbitrary future /platform/* or device/Happy endpoints. */
export const PLATFORM_ROUTE_METHODS = new Set([
    'POST /v1/tokenhub/platform/start', 'POST /v1/tokenhub/platform/complete',
    'GET /v1/tokenhub/platform/session', 'HEAD /v1/tokenhub/platform/session',
    'POST /v1/tokenhub/platform/logout',
    'GET /v1/tokenhub/platform/models', 'HEAD /v1/tokenhub/platform/models',
    'POST /v1/tokenhub/platform/stream',
]);
interface Dependencies {
    env?: NodeJS.ProcessEnv; transport?: typeof fetch; pageConfig?: typeof loadPageConfig;
    gateway?: CoreGateway; now?: () => number; maxSessions?: number; maxFlows?: number; revalidateMs?: number;
}
const empty = z.object({}).strict();
const callback = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().min(1).max(128).optional(), error: z.literal('access_denied').optional() }).strict()
    .refine(value => (value.code !== undefined) !== (value.error !== undefined));
function samePrincipal(left: PlatformPrincipal, right: PlatformPrincipal) {
    return left.kind === 'platform' && right.kind === 'platform' && left.authority === right.authority
        && left.issuer === right.issuer && left.subject === right.subject && left.sessionId === right.sessionId;
}

/** Seedless platform auth. No Happy account, key proof, credential or database binding. */
export function tokenHubPlatformRoutes(app: Fastify, dependencies: Dependencies = {}) {
    const env = dependencies.env ?? process.env, now = dependencies.now ?? Date.now, transport = dependencies.transport ?? fetch;
    const store = new PlatformSessionStore(now, dependencies.maxSessions, dependencies.maxFlows);
    let enabled = false, self = '', authority = '';
    let verifier: ReturnType<typeof createPlatformAuthority> | undefined;
    let gateway: CoreGateway | undefined;
    try {
        if (env.TOKENHUB_PLATFORM_AUTH === 'true' && env.TOKENHUB_UNIFIED_AUTH === 'true' && env.TOKENHUB_SSO_ENABLED === 'true' && env.TOKENHUB_GATEWAY_MODE === 'real') {
            const origin = new URL(env.HAPPY_PUBLIC_ORIGIN ?? '');
            if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
            self = origin.origin;
            authority = trustedTokenHubOrigin(env.TOKENHUB_URL);
            verifier = createPlatformAuthority({ env, transport, now });
            gateway = dependencies.gateway ?? createCoreGateway({ env, transport });
            enabled = gateway.enabled;
        }
    } catch { /* Explicitly unavailable, never fall back to Happy identity creation. */ }
    const config = dependencies.pageConfig ?? loadPageConfig;
    const context = (request: FastifyRequest) => workClientContext(request.raw, env.TOKENHUB_TRUST_LOOPBACK_PROXY);
    const fail = (reply: FastifyReply, status: number, message = 'Platform session unavailable') => reply.code(status).send({ error: message, platform: true, enabled });
    const metadata = (reply: FastifyReply) => reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie, Origin').header('X-Content-Type-Options', 'nosniff');
    function available(reply: FastifyReply) { metadata(reply); if (!enabled) { fail(reply, 503, 'Platform login is unavailable'); return false; } return true; }
    function sameOrigin(request: FastifyRequest, reply: FastifyReply, write: boolean) {
        const origin = request.headers.origin, site = request.headers['sec-fetch-site'];
        if ((write && origin !== self) || (origin !== undefined && origin !== self) || (site !== undefined && !['same-origin', 'none'].includes(String(site)))) {
            fail(reply, 403, 'Invalid platform request origin'); return false;
        }
        return true;
    }
    function localSession(request: FastifyRequest, reply: FastifyReply, csrf: boolean): { id: string; record: PlatformRecord } | undefined {
        const id = readPlatformCookie(request.headers.cookie, PLATFORM_SESSION_COOKIE), record = store.get(id);
        if (!record) { fail(reply, 401, 'Platform sign-in required'); return; }
        if (csrf && !equalOpaque(request.headers[PLATFORM_CSRF_HEADER], record.csrf)) { fail(reply, 403, 'Platform session changed; reload before continuing'); return; }
        return { id, record };
    }
    async function authenticate(request: FastifyRequest, reply: FastifyReply, csrf: boolean) {
        const session = localSession(request, reply, csrf);
        if (!session) return;
        try {
            const live = await verifier!.verify(session.record.grant, authority, session.record.principal.subject, context(request));
            if (!samePrincipal(session.record.principal, live) || store.get(session.id) !== session.record) throw new PlatformAuthorityError(401);
            session.record.principal.expiresAt = Math.min(session.record.principal.expiresAt, live.expiresAt);
            return session;
        } catch (error) {
            const status = error instanceof PlatformAuthorityError ? error.status : 503;
            if (status === 401) {
                store.remove(session.id, session.record);
                // A late read from an old tab must not clear a newer login's cookie.
                // Only its captured principal is revoked, never a newer channel login.
            }
            fail(reply, status);
        }
    }
    async function metadataForLogin() {
        const metadata = unwrap(await trustedJson(authority, '/api/v1/auth/happy/metadata', {}, transport));
        if (metadata.enabled !== true || metadata.audience !== 'happy-web' || typeof metadata.issuer !== 'string' || !metadata.issuer || metadata.issuer.length > 200) throw new Error('Invalid login metadata');
        return metadata as Record<string, unknown> & { issuer: string };
    }
    app.addHook('onClose', async () => store.clear());
    app.post('/v1/tokenhub/platform/start', { bodyLimit: 1024, schema: { body: empty } }, async (request, reply) => {
        if (!available(reply) || !sameOrigin(request, reply, true)) return;
        let pending: ReturnType<PlatformSessionStore['start']> | undefined;
        try {
            // Allocate the generation before awaits so a slower old start cannot
            // supersede a newer start for the same browser channel.
            pending = store.start(readPlatformCookie(request.headers.cookie, PLATFORM_SESSION_COOKIE));
            const [page] = await Promise.all([config(transport, true), metadataForLogin()]);
            if (!page.showLogin || !page.ssoReady) throw new Error('Platform login is unavailable');
            const url = new URL(page.loginUrl);
            if (url.origin !== authority || url.pathname !== '/happy/authorize' || url.search || url.hash || url.username || url.password) throw new Error('Invalid login target');
            const { flow } = pending;
            if (!store.isCurrentFlow(flow)) throw new Error('Platform login was superseded');
            url.search = new URLSearchParams({ client_id: 'happy-web', redirect_uri: self + '/tokenhub/callback', state: flow.state, nonce: flow.nonce,
                code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
            // Only a fresh anonymous channel writes a cookie. Completion and logout
            // never do, so a delayed successful callback cannot switch accounts.
            if (pending.created) reply.header('Set-Cookie', platformCookie(PLATFORM_SESSION_COOKIE, pending.id, (pending.expiresAt - now()) / 1000));
            return { authorizeUrl: url.toString(), state: flow.state, tokenHubOrigin: authority };
        } catch {
            if (pending) store.cancelFlow(pending.id, pending.flow);
            return fail(reply, 503, 'Platform login is unavailable');
        }
    });
    app.post('/v1/tokenhub/platform/complete', { bodyLimit: 8192, schema: { body: callback } }, async (request, reply) => {
        if (!available(reply) || !sameOrigin(request, reply, true)) return;
        let activeFlow: PlatformFlow | undefined;
        try {
            const flow = store.consume(request.body.state, readPlatformCookie(request.headers.cookie, PLATFORM_SESSION_COOKIE));
            activeFlow = flow;
            if (request.body.error) return fail(reply, 400, 'Platform login cancelled');
            const [metadata, jwks] = await Promise.all([metadataForLogin(), trustedJson(authority, '/api/v1/auth/sso/jwks', {}, transport)]);
            if (!store.isCurrentFlow(flow)) throw new Error('Platform login was cancelled');
            const result = unwrap(await trustedJson(authority, '/api/v1/auth/happy/exchange', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: request.body.code, code_verifier: flow.verifier, client_id: 'happy-web', redirect_uri: self + '/tokenhub/callback' }),
            }, transport));
            if (!store.isCurrentFlow(flow)) throw new Error('Platform login was cancelled');
            if (typeof result.id_token !== 'string' || typeof result.authorization_token !== 'string') throw new Error('Invalid login response');
            const identity = verifyIdentity(result.id_token, jwks, metadata.issuer, flow.nonce, now(), 'happy-web');
            const principal = await verifier!.verify(result.authorization_token, authority, identity.subject, context(request));
            const record = store.complete(flow, principal, result.authorization_token);
            return publicPlatformSession(record);
        } catch (error) {
            // No callback writes cookies, even errors, and only its own generation
            // can be cancelled. Stale responses cannot disturb a newer login.
            if (!activeFlow) return fail(reply, 400, 'Invalid or expired platform login');
            return fail(reply, error instanceof PlatformAuthorityError ? error.status : error instanceof PlatformCapacityError ? 503 : 400, 'Platform login could not be verified');
        } finally { if (activeFlow) store.cancelFlow(activeFlow.binding, activeFlow); }
    });
    app.get('/v1/tokenhub/platform/session', async (request, reply) => {
        if (!available(reply) || !sameOrigin(request, reply, false)) return;
        const session = await authenticate(request, reply, false);
        if (session) return publicPlatformSession(session.record);
    });
    app.post('/v1/tokenhub/platform/logout', { bodyLimit: 1024, schema: { body: empty } }, async (request, reply) => {
        if (!available(reply) || !sameOrigin(request, reply, true)) return;
        const session = localSession(request, reply, true);
        if (!session) return;
        // Local Work sign-out only. Core revocation would terminate the originating
        // refresh family, affecting other applications and requiring separate intent.
        store.remove(session.id, session.record);
        store.cancelFlow(session.id);
        // No cookie write: a delayed logout response must not erase another tab's
        // newer login. The channel now has no grant and only a short-lived marker.
        return { loggedOut: true, scope: 'work', coreSessionRevoked: false };
    });
    app.get('/v1/tokenhub/platform/models', async (request, reply) => {
        if (!available(reply) || !sameOrigin(request, reply, false)) return;
        const session = await authenticate(request, reply, true);
        if (!session) return;
        if (store.get(session.id) !== session.record) return fail(reply, 401, 'Platform session ended');
        const controller = new AbortController(), abort = () => controller.abort('client_disconnected');
        session.record.streams.add(controller);
        request.raw.once('aborted', abort); reply.raw.once('close', abort);
        if (request.raw.aborted || reply.raw.destroyed) abort();
        try { return await gateway!.models(session.record.grant, context(request), controller.signal); }
        catch (error) { return fail(reply, error instanceof CoreGatewayError ? error.status : 502, 'Platform model catalog unavailable'); }
        finally { controller.abort(); session.record.streams.delete(controller); request.raw.removeListener('aborted', abort); reply.raw.removeListener('close', abort); }
    });
    app.post('/v1/tokenhub/platform/stream', { bodyLimit: 32768, schema: { body: coreInput } }, async (request, reply) => {
        if (!available(reply) || !sameOrigin(request, reply, true)) return;
        const session = await authenticate(request, reply, true);
        if (!session) return;
        if (store.get(session.id) !== session.record) return fail(reply, 401, 'Platform session ended');
        const controller = new AbortController(), abort = () => controller.abort('client_disconnected'), client = context(request);
        session.record.streams.add(controller);
        request.raw.once('aborted', abort); reply.raw.once('close', abort);
        if (request.raw.aborted || reply.raw.destroyed) abort();
        let checking = false, expiry: ReturnType<typeof setTimeout>;
        const resetExpiry = () => { if (expiry) clearTimeout(expiry); expiry = setTimeout(() => controller.abort('authorization_revoked'), Math.max(0, Math.min(session.record.principal.expiresAt - now(), 2147483647))); };
        resetExpiry();
        const timer = setInterval(async () => {
            if (checking || controller.signal.aborted) return;
            checking = true;
            try {
                if (store.get(session.id) !== session.record) throw new Error('Platform session ended');
                const live = await verifier!.verify(session.record.grant, authority, session.record.principal.subject, client);
                if (!samePrincipal(session.record.principal, live) || store.get(session.id) !== session.record) throw new Error('Platform session changed');
                session.record.principal.expiresAt = Math.min(session.record.principal.expiresAt, live.expiresAt);
                resetExpiry();
            } catch { controller.abort('authorization_revoked'); }
            finally { checking = false; }
        }, dependencies.revalidateMs ?? WORK_REVALIDATE_MS);
        const cleanup = () => { clearInterval(timer); clearTimeout(expiry); controller.abort(); session.record.streams.delete(controller); request.raw.removeListener('aborted', abort); reply.raw.removeListener('close', abort); };
        const stream = Readable.from((async function* () {
            try { for await (const event of gateway!.stream(request.body, session.record.grant, client, controller.signal)) { if (reply.raw.destroyed) break; yield JSON.stringify(event) + '\n'; } }
            finally { cleanup(); }
        })());
        stream.once('close', cleanup);
        return reply.type('application/x-ndjson').header('X-TokenHub-Gateway', 'core').header('X-Accel-Buffering', 'no').send(stream);
    });
}
