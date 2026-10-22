import { z } from 'zod';
import { type Fastify } from '../types';
import { LoginFlows, authorizationUrl, verifyHappyProof, verifyIdentity } from '@/app/tokenhub/flow';
import { trustedJson, trustedTokenHubOrigin, unwrap } from '@/app/tokenhub/trusted';
import { loadPageConfig } from '@/app/tokenhub/pageConfig';
import { bindIdentity, type Identity } from '@/app/tokenhub/binding';

interface Dependencies {
    transport?: typeof fetch;
    flows?: LoginFlows;
    pageConfig?: typeof loadPageConfig;
    bind?: (authority: string, identity: Identity, publicKey: string) => Promise<string>;
    token?: (id: string) => Promise<string>;
}
export function tokenHubRoutes(app: Fastify, dependencies: Dependencies = {}) {
    const flows = dependencies.flows ?? new LoginFlows();
    const transport = dependencies.transport ?? fetch;
    const config = dependencies.pageConfig ?? loadPageConfig;
    const cookieName = '__Host-happy-tokenhub';
    const clearCookie = `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
    function selfOrigin() {
        const u = new URL(process.env.HAPPY_PUBLIC_ORIGIN ?? '');
        if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('Invalid Happy origin');
        return u.origin;
    }
    function enabled() { return process.env.TOKENHUB_SSO_ENABLED === 'true'; }
    app.get('/v1/tokenhub/config', async (_request, reply) => {
        reply.header('Cache-Control', 'no-store');
        try { return { config: await config(transport, true), tokenHubOrigin: trustedTokenHubOrigin() }; }
        catch { return reply.code(503).send({ error: 'Display configuration unavailable' }); }
    });
    app.post('/v1/tokenhub/start', { bodyLimit: 8192, schema: { body: z.object({ publicKey: z.string().max(64) }).strict() } }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!enabled()) return reply.code(503).send({ error: 'Unified login is not enabled' });
        try {
            if (request.headers.origin !== selfOrigin()) return reply.code(403).send({ error: 'Invalid origin' });
            const page = await config(transport, true), origin = trustedTokenHubOrigin();
            if (!page.ssoReady || !page.showLogin) return reply.code(503).send({ error: 'Unified login is unavailable' });
            const flow = flows.start(request.body.publicKey);
            const location = authorizationUrl(page.loginUrl, origin, selfOrigin() + '/tokenhub/callback', flow);
            reply.header('Set-Cookie', `${cookieName}=${flow.binding}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`);
            return { authorizeUrl: location, state: flow.state, proof: flow.proof, tokenHubOrigin: origin };
        } catch { return reply.code(400).send({ error: 'Could not start login' }); }
    });
    app.post('/v1/tokenhub/complete', { bodyLimit: 8192, schema: { body: z.object({ state: z.string().min(43).max(128), code: z.string().max(128).optional(), error: z.literal('access_denied').optional(), signature: z.string().max(100).optional() }).strict() } }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!enabled()) return reply.code(503).send({ error: 'Unified login is not enabled' });
        try {
            if (request.headers.origin !== selfOrigin()) return reply.code(403).send({ error: 'Invalid origin' });
            const cookie = request.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1) ?? '';
            const flow = flows.consume(request.body.state, cookie);
            reply.header('Set-Cookie', clearCookie);
            if (request.body.error) return reply.code(400).send({ error: 'Login cancelled' });
            if (!request.body.code || !request.body.signature || !verifyHappyProof(flow, request.body.signature)) return reply.code(401).send({ error: 'Happy identity proof rejected' });
            const origin = trustedTokenHubOrigin();
            const [metadata, jwks] = await Promise.all([
                trustedJson(origin, '/api/v1/auth/happy/metadata', {}, transport).then(unwrap),
                trustedJson(origin, '/api/v1/auth/sso/jwks', {}, transport),
            ]);
            if (metadata.enabled !== true || metadata.audience !== 'happy-web' || typeof metadata.issuer !== 'string' || !metadata.issuer || metadata.issuer.length > 200) throw new Error('Untrusted metadata');
            const result = unwrap(await trustedJson(origin, '/api/v1/auth/happy/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: request.body.code, code_verifier: flow.verifier, client_id: 'happy-web', redirect_uri: selfOrigin() + '/tokenhub/callback' }) }, transport));
            if (typeof result.id_token !== 'string') throw new Error('Missing assertion');
            const identity = verifyIdentity(result.id_token, jwks, metadata.issuer, flow.nonce);
            const publicKeyHex = Buffer.from(flow.publicKey, 'base64').toString('hex');
            const accountId = dependencies.bind
                ? await dependencies.bind(origin, identity, publicKeyHex)
                : await bindIdentity((await import('@/storage/db')).db, origin, identity, publicKeyHex);
            // Only Happy's existing signer creates the Happy session. External JWTs never become sessions.
            const token = dependencies.token ? await dependencies.token(accountId) : await (await import('@/app/auth/auth')).auth.createToken(accountId);
            return { token };
        } catch (error) {
            // Invalid/stale state must not clear a newer browser-bound transaction.
            if (error instanceof Error && error.message === 'identity_key_mismatch' || (error as { code?: string })?.code === 'P2002') return reply.code(409).send({ error: 'Restore the original Happy encryption identity before linking this account' });
            return reply.code(400).send({ error: 'Login expired or could not be verified; start again' });
        }
    });
}
