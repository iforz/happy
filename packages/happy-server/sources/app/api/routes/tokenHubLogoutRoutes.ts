import { z } from 'zod';
import type { Fastify } from '../types';
import { getWorkAuthorization, type WorkSessionRevocation } from '@/app/tokenhub/workAuthorization';

/** Intentionally exempt from live Work authorization. The revoker separately verifies
 * Happy's signature and persistent identity binding before relinquishing its embedded SID. */
export function tokenHubLogoutRoutes(app: Fastify, dependencies: { authorization?: WorkSessionRevocation } = {}) {
    const authorization = dependencies.authorization ?? getWorkAuthorization();
    app.post('/v1/tokenhub/logout', {
        bodyLimit: 1024,
        schema: { body: z.object({}).strict(), querystring: z.object({}).strict() },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!authorization.enabled) return reply.code(503).send({ error: 'Unified logout is unavailable' });
        const header = request.headers.authorization;
        const authHeaderCount = request.raw.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
        const bearer = typeof header === 'string' && /^Bearer ([^\s]+)$/i.exec(header);
        if (authHeaderCount !== 1 || !bearer || bearer[1].length > 32768) return reply.code(401).send({ error: 'Invalid logout credentials' });
        try {
            const result = await authorization.revokeToken(bearer[1]);
            if (result === 'revoked') return { revoked: true };
            if (result === 'invalid') return reply.code(401).send({ error: 'Invalid logout credentials' });
        } catch { /* Never expose authority errors, credentials, or identity details. */ }
        return reply.code(503).send({ error: 'Could not confirm session revocation; try again' });
    });
}
