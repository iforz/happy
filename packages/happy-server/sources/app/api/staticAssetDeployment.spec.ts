import { describe, expect, it } from 'vitest';
import fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Focused static-plugin integration, not a boot of the database/auth stack.
describe('self-hosted static asset deployment contract', () => {
    it('requires restart to register new hashes before switching the active index', async () => {
        const source = await readFile(new URL('./api.ts', import.meta.url), 'utf8');
        expect(source).toMatch(/app\.register\(fastifyStatic,\s*\{[^}]*wildcard:\s*false/s);
        const root = await mkdtemp(path.join(tmpdir(), 'happy-static-deploy-'));
        const oldHtml = '<!DOCTYPE html><script src="/old-hash.js"></script>';
        const newHtml = '<!DOCTYPE html><script src="/new-hash.js"></script>';
        const boot = async () => {
            const app = fastify();
            app.register(fastifyStatic, { root, prefix: '/', decorateReply: false, wildcard: false });
            app.setNotFoundHandler(async (_request, reply) =>
                reply.type('text/html').send(await readFile(path.join(root, 'index.html'), 'utf8')));
            await app.ready();
            return app;
        };
        let app: Awaited<ReturnType<typeof boot>> | undefined;
        try {
            await writeFile(path.join(root, 'index.html'), oldHtml);
            await writeFile(path.join(root, 'old-hash.js'), 'globalThis.oldAsset = true;');
            app = await boot();
            await writeFile(path.join(root, 'new-hash.js'), 'globalThis.newAsset = true;');
            await writeFile(path.join(root, 'index.next'), newHtml);
            const beforeRestart = await app.inject('/new-hash.js');
            expect(beforeRestart.statusCode).toBe(200);
            expect(beforeRestart.headers['content-type']).toContain('text/html');
            expect(beforeRestart.body).toBe(oldHtml);
            await app.close();
            app = await boot();
            expect((await app.inject('/')).body).toBe(oldHtml);
            for (const asset of ['old-hash', 'new-hash']) {
                const response = await app.inject(`/${asset}.js`);
                expect(response.statusCode).toBe(200);
                expect(response.headers['content-type']).toMatch(/javascript/);
                expect(response.body).not.toMatch(/<!doctype|<html/i);
                expect(response.body).toContain('globalThis.');
            }
            await rename(path.join(root, 'index.next'), path.join(root, 'index.html'));
            expect((await app.inject('/')).body).toBe(newHtml);
            expect((await app.inject('/server')).body).toBe(newHtml);
            expect((await app.inject('/old-hash.js')).headers['content-type']).toMatch(/javascript/);
        } finally {
            await app?.close();
            await rm(root, { recursive: true, force: true });
        }
    });
});
