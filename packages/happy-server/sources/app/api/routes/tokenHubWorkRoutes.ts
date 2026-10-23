import { workClientContext } from '@/app/tokenhub/clientContext';
import { createCoreGateway, type CoreGateway } from '@/app/tokenhub/coreGateway';
import { tokenHubCoreWorkRoutes } from './tokenHubCoreWorkRoutes';
import { Readable } from 'node:stream';
import { type Fastify } from '../types';
import { createMockGateway, MOCK_MODELS, mockInput, type MockGateway, type MockIdentity } from '@/app/tokenhub/mockGateway';
import { getWorkAuthorization, WORK_REVALIDATE_MS, type WorkAuthorization, type VerifiedWorkSession } from '@/app/tokenhub/workAuthorization';

interface Dependencies { coreGateway?: CoreGateway; gateway?: MockGateway; authorization?: WorkAuthorization; revalidateMs?: number }
function identity(session: VerifiedWorkSession | undefined, userId: string): MockIdentity | null {
    if (!session?.tokenhub || session.userId !== userId || !session.expiresAt || session.expiresAt <= Date.now()) return null;
    return { userId, ...session.tokenhub };
}

/** Isolated experimental surface; never changes Happy's ordinary providers or inference routes. */
export function tokenHubWorkRoutes(app: Fastify, dependencies: Dependencies = {}) {
    if (dependencies.coreGateway || process.env.TOKENHUB_GATEWAY_MODE === 'real') {
        if (dependencies.gateway) throw new Error('Mock and real gateways are mutually exclusive');
        return tokenHubCoreWorkRoutes(app, dependencies.coreGateway ?? createCoreGateway(), dependencies.authorization ?? getWorkAuthorization(), dependencies.revalidateMs);
    }
    const gateway = dependencies.gateway ?? createMockGateway();
    const authorization = dependencies.authorization ?? getWorkAuthorization();
    app.get('/v1/tokenhub/work/models', { preHandler: app.authenticate }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!gateway.enabled || !authorization.enabled) return reply.code(503).send({ error: 'Mock gateway is disabled' });
        if (!identity(request.workSession, request.userId)) return reply.code(403).send({ error: 'Verified Work session required' });
        return { mode: 'mock', billable: false, models: MOCK_MODELS };
    });
    app.post('/v1/tokenhub/work/stream', { preHandler: app.authenticate, bodyLimit: 32768, schema: { body: mockInput } }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!gateway.enabled || !authorization.enabled) return reply.code(503).send({ error: 'Mock gateway is disabled' });
        const verifiedIdentity = identity(request.workSession, request.userId);
        if (!verifiedIdentity) return reply.code(403).send({ error: 'Verified Work session required' });
        const controller = new AbortController();
        const abort = () => controller.abort('client_disconnected');
        request.raw.once('aborted', abort);
        reply.raw.once('close', abort);
        if (request.raw.aborted || reply.raw.destroyed) abort();
        let checking = false;
        const token = request.headers.authorization!.slice(7);
        const timer = setInterval(async () => {
            if (checking || controller.signal.aborted) return;
            checking = true;
            try {
                const current = await authorization.verifyToken(token, workClientContext(request.raw));
                const currentIdentity = identity(current ?? undefined, request.userId);
                if (!currentIdentity || Object.keys(verifiedIdentity).some(key => currentIdentity[key as keyof MockIdentity] !== verifiedIdentity[key as keyof MockIdentity])) controller.abort('authorization_revoked');
            } catch { controller.abort('authorization_revoked'); }
            finally { checking = false; }
        }, dependencies.revalidateMs ?? WORK_REVALIDATE_MS);
        const expires = setTimeout(() => controller.abort('authorization_revoked'), Math.min(request.workSession!.expiresAt! - Date.now(), 2_147_483_647));
        const cleanup = () => {
            clearInterval(timer); clearTimeout(expires);
            request.raw.removeListener('aborted', abort); reply.raw.removeListener('close', abort);
            controller.abort();
        };
        const stream = Readable.from((async function* () {
            try {
                for await (const event of gateway.stream(request.body, verifiedIdentity, controller.signal)) {
                    if (reply.raw.destroyed) break;
                    yield JSON.stringify(event) + '\n';
                }
            } finally {
                cleanup();
            }
        })());
        stream.once('close', cleanup);
        return reply.type('application/x-ndjson').header('X-TokenHub-Mock', 'true').header('X-Accel-Buffering', 'no').send(stream);
    });
}
