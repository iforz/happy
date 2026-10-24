import { workClientContext } from '@/app/tokenhub/clientContext';
import { Fastify } from "../types";
import { debug } from "@/utils/log";
import { getWorkAuthorization, type WorkAuthorization } from '@/app/tokenhub/workAuthorization';

export function enableAuthentication(app: Fastify, authorization: WorkAuthorization = getWorkAuthorization()) {
    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            const authHeader = request.headers.authorization;
            const route = request.routeOptions?.url || '<unmatched>';
            debug({ module: 'auth' }, `auth:check route=${route} hasHeader=${!!authHeader}`);
            if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
                debug({ module: 'auth' }, 'auth:failed reason=missing-or-invalid-header');
                return reply.code(401).send({ error: 'Missing authorization header' });
            }

            const token = authHeader.substring(7);
            const verified = await authorization.verifyToken(token, workClientContext(request.raw));
            if (!verified) {
                debug({ module: 'auth' }, 'auth:failed reason=invalid-token');
                return reply.code(401).send({ error: 'Invalid token' });
            }

            debug({ module: 'auth' }, `auth:success userId=${verified.userId}`);
            request.userId = verified.userId;
            request.workSession = verified;
        } catch (error) {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });

    if (authorization.enabled) {
        const publicEndpoints = new Set([
            'GET /v1/tokenhub/config', 'HEAD /v1/tokenhub/config',
            'POST /v1/tokenhub/start', 'POST /v1/tokenhub/complete', 'POST /v1/version',
            'POST /v1/tokenhub/native/start', 'POST /v1/tokenhub/native/complete', 'POST /v1/tokenhub/native/handoff',
            'POST /v1/tokenhub/logout',
            // Seedless platform BFF owns its own cookie/CSRF/live-Core validators.
            // Do not extend this into a prefix exemption or legacy data access.
            'POST /v1/tokenhub/platform/start', 'POST /v1/tokenhub/platform/complete',
            'GET /v1/tokenhub/platform/session', 'HEAD /v1/tokenhub/platform/session',
            'POST /v1/tokenhub/platform/logout',
            'GET /v1/tokenhub/platform/models', 'HEAD /v1/tokenhub/platform/models',
            'POST /v1/tokenhub/platform/stream',
        ]);
        const unsupported = new Set([
            '/v1/connect/github/params', '/v1/connect/github/callback', '/v1/connect/github/webhook',
            '/logs-combined-from-cli-and-mobile-for-simple-ai-debugging',
        ]);
        // Future API routes must opt into the explicit bootstrap list, not accidentally omit auth.
        app.addHook('onRoute', options => {
            const methods = Array.isArray(options.method) ? options.method : [options.method];
            if (methods.every(method => method === 'OPTIONS' || publicEndpoints.has(`${method} ${options.url}`))) return;
            if (options.url.startsWith('/files/') || options.url === '/v1/auth' || options.url.startsWith('/v1/auth/') || unsupported.has(options.url)) {
                // Raw local files have no per-object ownership check. Never turn an arbitrary file URL
                // into a bearer-token download URL; use the owner-scoped attachment/avatar APIs instead.
                options.preHandler = async (_request, reply) => reply.code(403).send({ error: 'This endpoint is unavailable with unified authorization' });
                return;
            }
            if (!/^\/v[0-9]+(?:\/|$)/.test(options.url)) return;
            const handlers = options.preHandler ? (Array.isArray(options.preHandler) ? options.preHandler : [options.preHandler]) : [];
            if (!handlers.includes(app.authenticate)) options.preHandler = [app.authenticate, ...handlers];
        });
    }
}
