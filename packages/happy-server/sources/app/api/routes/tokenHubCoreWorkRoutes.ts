import { Readable } from 'node:stream';
import type { Fastify } from '../types';
import { coreInput, CoreGatewayError, type CoreGateway } from '@/app/tokenhub/coreGateway';
import { WORK_REVALIDATE_MS, type WorkAuthorization, type VerifiedWorkSession } from '@/app/tokenhub/workAuthorization';

function sameSession(left: VerifiedWorkSession, right: VerifiedWorkSession | null) {
    return !!left.tokenhub && !!right?.tokenhub && left.userId === right.userId
        && left.tokenhub.authority === right.tokenhub.authority && left.tokenhub.issuer === right.tokenhub.issuer
        && left.tokenhub.subject === right.tokenhub.subject && left.tokenhub.sessionId === right.tokenhub.sessionId;
}
export function tokenHubCoreWorkRoutes(app: Fastify, gateway: CoreGateway, authorization: WorkAuthorization, revalidateMs = WORK_REVALIDATE_MS) {
    app.get('/v1/tokenhub/work/models', { preHandler: app.authenticate }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!gateway.enabled || !authorization.enabled || !authorization.resolveGatewayGrant) return reply.code(503).send({ error: 'Work gateway is disabled' });
        const context = { ip: request.ip, userAgent: request.headers['user-agent'] };
        const grant = await authorization.resolveGatewayGrant(request.headers.authorization!.slice(7), context);
        if (!grant || !request.workSession || !sameSession(request.workSession, grant.session)) return reply.code(401).send({ error: 'Work authorization unavailable' });
        const controller = new AbortController(), abort = () => controller.abort();
        request.raw.once('aborted', abort); reply.raw.once('close', abort);
        if (request.raw.aborted || reply.raw.destroyed) abort();
        try { return await gateway.models(grant.authorizationToken, context, controller.signal); }
        catch (error) { return reply.code(error instanceof CoreGatewayError ? error.status : 502).send({ error: 'Work model catalog unavailable' }); }
        finally { controller.abort(); request.raw.removeListener('aborted', abort); reply.raw.removeListener('close', abort); }
    });
    app.post('/v1/tokenhub/work/stream', { preHandler: app.authenticate, bodyLimit: 32768, schema: { body: coreInput } }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!gateway.enabled || !authorization.enabled || !authorization.resolveGatewayGrant) return reply.code(503).send({ error: 'Work gateway is disabled' });
        const token = request.headers.authorization!.slice(7), context = { ip: request.ip, userAgent: request.headers['user-agent'] };
        const grant = await authorization.resolveGatewayGrant(token, context);
        if (!grant || !request.workSession || !sameSession(request.workSession, grant.session)
            || !grant.session.expiresAt || grant.session.expiresAt <= Date.now()) return reply.code(401).send({ error: 'Work authorization unavailable' });
        const controller = new AbortController(), abort = () => controller.abort('client_disconnected');
        request.raw.once('aborted', abort); reply.raw.once('close', abort);
        if (request.raw.aborted || reply.raw.destroyed) abort();
        let checking = false;
        const timer = setInterval(async () => {
            if (checking || controller.signal.aborted) return;
            checking = true;
            try { if (!sameSession(grant.session, await authorization.verifyToken(token, context))) controller.abort('authorization_revoked'); }
            catch { controller.abort('authorization_revoked'); }
            finally { checking = false; }
        }, revalidateMs);
        const expiry = setTimeout(() => controller.abort('authorization_revoked'), Math.min(grant.session.expiresAt - Date.now(), 2147483647));
        const cleanup = () => {
            clearInterval(timer); clearTimeout(expiry); controller.abort();
            request.raw.removeListener('aborted', abort); reply.raw.removeListener('close', abort);
        };
        const stream = Readable.from((async function* () {
            try {
                for await (const event of gateway.stream(request.body, grant.authorizationToken, context, controller.signal)) {
                    if (reply.raw.destroyed) break;
                    yield JSON.stringify(event) + '\n';
                }
            } finally { cleanup(); }
        })());
        stream.once('close', cleanup);
        return reply.type('application/x-ndjson').header('X-TokenHub-Gateway', 'core').header('X-Accel-Buffering', 'no').send(stream);
    });
}
