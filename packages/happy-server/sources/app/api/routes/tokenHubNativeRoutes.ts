import { z } from 'zod';
import type { Fastify } from '../types';
import type { TokenHubRouteDependencies } from './tokenHubRoutes';
import { NativeLoginFlows, NATIVE_LOGIN_CALLBACK, nativeRequestBinding, canonicalNativeIP } from '@/app/tokenhub/nativeFlow';
import { authorizationUrl, verifyHappyProof, verifyIdentity } from '@/app/tokenhub/flow';
import { trustedJson, trustedTokenHubOrigin, unwrap } from '@/app/tokenhub/trusted';
import { loadPageConfig } from '@/app/tokenhub/pageConfig';
import { bindIdentity } from '@/app/tokenhub/binding';
import { getWorkAuthorization, type TokenHubSession } from '@/app/tokenhub/workAuthorization';

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const callbackBody = z.object({ state: opaque, code: z.string().min(1).max(128).optional(), error: z.literal('access_denied').optional() }).strict();

export function tokenHubNativeRoutes(app: Fastify, dependencies: TokenHubRouteDependencies & { nativeFlows?: NativeLoginFlows } = {}) {
    const flows = dependencies.nativeFlows ?? new NativeLoginFlows();
    const transport = dependencies.transport ?? fetch;
    const config = dependencies.pageConfig ?? loadPageConfig;
    const authorization = dependencies.authorization ?? getWorkAuthorization();
    function selfOrigin() {
        const u = new URL(process.env.HAPPY_PUBLIC_ORIGIN ?? '');
        if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('Invalid Happy origin');
        return u.origin;
    }
    const enabled = () => process.env.TOKENHUB_SSO_ENABLED === 'true';

    app.post('/v1/tokenhub/native/start', { bodyLimit: 8192, schema: { body: z.object({ publicKey: z.string().max(64) }).strict() } }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!enabled() || !authorization.enabled) return reply.code(503).send({ error: 'Unified login is not enabled' });
        // Native requests have no Origin. Browser clients must continue to use the cookie-bound flow.
        if (request.headers.origin !== undefined) return reply.code(403).send({ error: 'Native transport required' });
        try {
            const binding = nativeRequestBinding(request.ip, request.headers['user-agent']);
            const page = await config(transport, true), origin = trustedTokenHubOrigin();
            if (!page.ssoReady || !page.showLogin) return reply.code(503).send({ error: 'Unified login is unavailable' });
            const metadata = unwrap(await trustedJson(origin, '/api/v1/auth/happy/metadata', {}, transport));
            if (metadata.enabled !== true || metadata.native_audience !== 'happy-native' || metadata.native_binding_method !== 'ip-ua-sha256-128-v1') return reply.code(503).send({ error: 'Native unified login is unavailable' });
            const flow = flows.start(request.body.publicKey, binding, canonicalNativeIP(request.ip));
            const authorizeUrl = authorizationUrl(page.loginUrl, origin, selfOrigin() + '/tokenhub/callback', flow, binding);
            return { authorizeUrl, state: flow.state, binding: flow.binding, proof: flow.proof, expiresAt: flow.expires, tokenHubOrigin: origin };
        } catch (error) {
            if (error instanceof Error && error.message === 'native_context_changed') return reply.code(412).send({ error: 'Network environment changed; start login again' });
            return reply.code(400).send({ error: 'Could not start login' });
        }
    });

    app.post('/v1/tokenhub/native/handoff', { bodyLimit: 2048, schema: { body: callbackBody } }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!enabled() || !authorization.enabled) return reply.code(503).send({ error: 'Unified login is not enabled' });
        try {
            if (request.headers.origin !== selfOrigin()) return reply.code(403).send({ error: 'Invalid origin' });
            const { state, code, error } = request.body;
            if (!flows.has(state) || Boolean(code) === Boolean(error)) throw new Error();
            const url = new URL(NATIVE_LOGIN_CALLBACK);
            url.search = new URLSearchParams({ state, ...(error ? { error } : { code: code! }) }).toString();
            // Never include the device binding, PKCE verifier, identity proof or a session token.
            return { callbackUrl: url.toString() };
        } catch { return reply.code(400).send({ error: 'Not a pending native login' }); }
    });

    app.post('/v1/tokenhub/native/complete', { bodyLimit: 8192, schema: { body: callbackBody.extend({ binding: opaque, signature: z.string().max(100).optional() }).strict() } }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!enabled() || !authorization.enabled) return reply.code(503).send({ error: 'Unified login is not enabled' });
        if (request.headers.origin !== undefined) return reply.code(403).send({ error: 'Native transport required' });
        try {
            const { state, binding, code, error, signature } = request.body;
            if (Boolean(code) === Boolean(error)) throw new Error();
            const flow = flows.consume(state, binding, nativeRequestBinding(request.ip, request.headers['user-agent']));
            if (error) return reply.code(400).send({ error: 'Login cancelled' });
            if (!signature || !verifyHappyProof(flow, signature)) return reply.code(401).send({ error: 'Happy identity proof rejected' });
            const origin = trustedTokenHubOrigin();
            const [metadata, jwks] = await Promise.all([
                trustedJson(origin, '/api/v1/auth/happy/metadata', {}, transport).then(unwrap),
                trustedJson(origin, '/api/v1/auth/sso/jwks', {}, transport),
            ]);
            if (metadata.enabled !== true || metadata.native_audience !== 'happy-native' || metadata.native_binding_method !== 'ip-ua-sha256-128-v1' || typeof metadata.issuer !== 'string' || !metadata.issuer || metadata.issuer.length > 200) throw new Error();
            const result = unwrap(await trustedJson(origin, '/api/v1/auth/happy/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, code_verifier: flow.verifier, client_id: 'happy-native', native_binding_hash: flow.nativeBindingHash, native_client_ip: flow.nativeClientIP, redirect_uri: selfOrigin() + '/tokenhub/callback' }) }, transport));
            if (typeof result.id_token !== 'string') throw new Error();
            const identity = verifyIdentity(result.id_token, jwks, metadata.issuer, flow.nonce, Date.now(), 'happy-native');
            const publicKeyHex = Buffer.from(flow.publicKey, 'base64').toString('hex');
            let extras: { tokenhub: TokenHubSession } | undefined;
            let expiresAt: number | null = null;
            if (authorization.enabled) {
                if (typeof result.authorization_token !== 'string') throw new Error();
                const grant = { authorizationToken: result.authorization_token, authority: origin, ...identity, publicKey: publicKeyHex };
                expiresAt = await authorization.verifyGrant(grant, { ip: flow.nativeClientIP, userAgent: request.headers['user-agent'] });
                if (expiresAt === null) throw new Error();
                extras = { tokenhub: grant };
            }
            const accountId = dependencies.bind ? await dependencies.bind(origin, identity, publicKeyHex)
                : await bindIdentity((await import('@/storage/db')).db, origin, identity, publicKeyHex);
            const token = dependencies.token ? await dependencies.token(accountId, extras)
                : await (await import('@/app/auth/auth')).auth.createToken(accountId, extras);
            return { token, expiresAt, refresh: 'reauthenticate' as const };
        } catch (error) {
            if (error instanceof Error && error.message === 'native_context_changed') return reply.code(412).send({ error: 'Network environment changed; start login again' });
            if (error instanceof Error && error.message === 'identity_key_mismatch' || (error as { code?: string })?.code === 'P2002') return reply.code(409).send({ error: 'Restore the original Happy encryption identity before linking this account' });
            return reply.code(400).send({ error: 'Login expired or could not be verified; start again' });
        }
    });

    // This checks the existing authority. It never creates or refreshes a session.
    app.get('/v1/tokenhub/native/session', async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!enabled() || !authorization.enabled) return reply.code(401).send({ error: 'Session authority is unavailable' });
        const header = request.headers.authorization;
        const session = request.workSession ?? (typeof header === 'string' && header.startsWith('Bearer ')
            ? await authorization.verifyToken(header.slice(7), { ip: request.ip, userAgent: request.headers['user-agent'] }) : null);
        if (!session) return reply.code(401).send({ error: 'Session expired or revoked' });
        return { active: true, expiresAt: session.expiresAt ?? null, refresh: 'reauthenticate' as const };
    });
}
