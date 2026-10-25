import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    createPlatformConversations, PLATFORM_STREAM_LEASE_MS, MAX_PLATFORM_TURNS, MAX_PLATFORM_CONVERSATIONS,
    type PlatformConversations, type PlatformConversationOwner, type PlatformConversationTurn,
    type BeginPlatformConversation, type PlatformConversationUsage,
} from './platformConversations';

const owner = { authority: 'https://accounts.example.test', issuer: 'tokenapi', subject: '42' };
const prompt = (conversationId = randomUUID(), requestId = randomUUID()): BeginPlatformConversation => ({
    conversationId, requestId, model: 'test-model', messages: [{ role: 'user', content: 'hello' }],
});
function usage(id: string): PlatformConversationUsage {
    return { requestId: id, model: 'test-model', inputTokens: 2, outputTokens: 3, mock: false, billable: true, accounting: 'core' };
}
const importedTurn = (id = randomUUID()): PlatformConversationTurn => ({ id, user: 'hello', assistant: 'world', status: 'complete' });

describe('platform account history using the real PostgreSQL-compatible store', () => {
    let pg: PGlite, client: PrismaClient, otherClient: PrismaClient, repository: PlatformConversations, time: number;
    beforeAll(async () => {
        pg = new PGlite();
        const migration = await readFile(resolve('prisma/migrations/20261025120000_platform_conversations/migration.sql'), 'utf8');
        await pg.exec(migration);
        await pg.exec(migration); // Standalone migrations can be safely replayed.
        client = new PrismaClient({ adapter: new PrismaPGlite(pg) } as any);
        otherClient = new PrismaClient({ adapter: new PrismaPGlite(pg) } as any);
    }, 30000);
    beforeEach(async () => {
        await pg.exec('TRUNCATE TABLE "PlatformConversation", "PlatformConversationOwner" CASCADE');
        time = 1_700_000_000_000;
        repository = createPlatformConversations(client, () => time);
    });
    afterAll(async () => { await otherClient?.$disconnect(); await client?.$disconnect(); await pg?.close(); });

    it('isolates the full authority/issuer/subject and works across sessions/devices for the same owner', async () => {
        const input = prompt();
        await repository.begin({ ...owner, sessionId: 'device-a' } as PlatformConversationOwner, input);
        const secondDevice = createPlatformConversations(otherClient, () => time);
        expect((await secondDevice.get({ ...owner, sessionId: 'device-b' } as PlatformConversationOwner, input.conversationId))?.turns[0].user).toBe('hello');
        const others = [{ ...owner, subject: '43' }, { ...owner, issuer: 'other' }, { ...owner, authority: 'https://different.example.test' }];
        for (const other of others) {
            expect(await repository.list(other)).toEqual([]);
            expect(await repository.get(other, input.conversationId)).toBeNull();
            expect(await repository.checkpoint(other, input.conversationId, { id: input.requestId, assistant: 'stolen', status: 'failed' })).toBeNull();
            expect((await repository.begin(other, input)).created).toBe(true);
            await repository.checkpoint(other, input.conversationId, { id: input.requestId, assistant: 'other account content', status: 'failed' });
            await repository.remove(other, input.conversationId);
        }
        expect((await repository.get(owner, input.conversationId))?.turns[0].status).toBe('streaming');
    });

    it('claims a stable request exactly once and never reruns it after completion or later turns', async () => {
        const input = prompt();
        expect((await repository.begin(owner, input)).created).toBe(true);
        expect((await repository.begin(owner, input)).created).toBe(false);
        await repository.checkpoint(owner, input.conversationId, { id: input.requestId, assistant: 'world', status: 'complete', usage: usage(input.requestId) });
        const next = { ...prompt(input.conversationId), model: 'different-model', messages: [
            ...input.messages, { role: 'assistant' as const, content: 'world' }, { role: 'user' as const, content: 'next' },
        ] };
        await repository.begin(owner, next);
        const retried = await repository.begin(owner, input);
        expect(retried.created).toBe(false);
        expect(retried.turn.status).toBe('complete');
        expect(retried.conversation.turns).toHaveLength(2);
        expect(retried.turn).not.toHaveProperty('fingerprint');
        await expect(repository.begin(owner, { ...input, messages: [{ role: 'user', content: 'changed' }] })).rejects.toMatchObject({ status: 409 });
        await expect(repository.begin(owner, { ...input, model: 'other' })).rejects.toMatchObject({ status: 409 });
        await expect(repository.begin(owner, { ...input, conversationId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    });

    it('serializes concurrent devices: same request deduplicates and distinct active turns conflict', async () => {
        const input = prompt();
        const another = createPlatformConversations(otherClient, () => time);
        const duplicate = await Promise.all([repository.begin(owner, input), another.begin(owner, input)]);
        expect(duplicate.map(result => result.created).sort()).toEqual([false, true]);
        const newId = randomUUID();
        const contenders = await Promise.allSettled([repository.begin(owner, prompt(newId)), another.begin(owner, prompt(newId))]);
        expect(contenders.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(contenders.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
        expect((await repository.get(owner, newId))?.turns).toHaveLength(1);
    });

    it('rejects invented/truncated contexts and accepts only the saved complete turns', async () => {
        const input = prompt();
        await repository.begin(owner, input);
        await repository.checkpoint(owner, input.conversationId, { id: input.requestId, assistant: 'world', status: 'complete', usage: usage(input.requestId) });
        await expect(repository.begin(owner, prompt(input.conversationId))).rejects.toMatchObject({ status: 409 });
        await expect(repository.begin(owner, { ...prompt(input.conversationId), messages: [
            { role: 'user', content: 'hello' }, { role: 'assistant', content: 'invented' }, { role: 'user', content: 'next' },
        ] })).rejects.toMatchObject({ status: 409 });
        const continued = await repository.begin(owner, { ...prompt(input.conversationId), messages: [
            { role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }, { role: 'user', content: 'next' },
        ] });
        expect(continued.created).toBe(true);
        expect(continued.conversation.turns).toHaveLength(2);
    });

    it('persists interrupted partials, marks lease expiry failed on recovery and never reclaims inference', async () => {
        const input = prompt();
        await repository.begin(owner, input);
        await repository.checkpoint(owner, input.conversationId, { id: input.requestId, assistant: 'partial', status: 'streaming' });
        time += PLATFORM_STREAM_LEASE_MS + 1;
        const restarted = createPlatformConversations(client, () => time);
        expect((await restarted.list(owner))[0].lastStatus).toBe('failed');
        expect((await restarted.get(owner, input.conversationId))?.turns[0]).toMatchObject({ assistant: 'partial', status: 'failed' });
        expect((await restarted.begin(owner, input)).created).toBe(false);
        const late = await repository.checkpoint(owner, input.conversationId, { id: input.requestId, assistant: 'partial late', status: 'complete', usage: usage(input.requestId) });
        expect(late?.turns[0]).toMatchObject({ assistant: 'partial', status: 'failed' });
        expect((await restarted.begin(owner, prompt(input.conversationId))).created).toBe(true);
    });

    it('makes expired requests terminal when get or duplicate begin is the recovery entry point', async () => {
        const first = prompt(), second = prompt();
        await repository.begin(owner, first); await repository.begin(owner, second);
        time += PLATFORM_STREAM_LEASE_MS + 1;
        expect((await repository.get(owner, first.conversationId))?.turns[0].status).toBe('failed');
        expect((await repository.begin(owner, second)).turn.status).toBe('failed');
        expect((await repository.begin(owner, second)).created).toBe(false);
    });

    it('enforces monotonic checkpoints, validated final usage, immutable terminal states and a fixed lease', async () => {
        const input = prompt(); await repository.begin(owner, input);
        await repository.checkpoint(owner, input.conversationId, { id: input.requestId, assistant: 'long partial', status: 'streaming' });
        expect((await repository.checkpoint(owner, input.conversationId, { id: input.requestId, assistant: 'long', status: 'streaming' }))?.turns[0].assistant).toBe('long partial');
        await expect(repository.checkpoint(owner, input.conversationId, { id: input.requestId, assistant: 'long partial', status: 'complete' })).rejects.toMatchObject({ status: 400 });
        await expect(repository.checkpoint(owner, input.conversationId, { id: input.requestId, assistant: 'long partial', status: 'complete', usage: usage(randomUUID()) })).rejects.toMatchObject({ status: 400 });
        time += 1000;
        await repository.checkpoint(owner, input.conversationId, { id: input.requestId, assistant: 'long partial', status: 'streaming' });
        const [lease] = await client.$queryRaw<{ activeUntil: Date | null }[]>`SELECT "activeUntil" FROM "PlatformConversation"
            WHERE "authority" = ${owner.authority} AND "issuer" = ${owner.issuer} AND "subject" = ${owner.subject} AND "id" = ${input.conversationId}::uuid`;
        expect(lease?.activeUntil?.getTime()).toBe(1_700_000_000_000 + PLATFORM_STREAM_LEASE_MS);
        await repository.checkpoint(owner, input.conversationId, { id: input.requestId, assistant: 'long partial done', status: 'complete', usage: usage(input.requestId) });
        expect((await repository.checkpoint(owner, input.conversationId, { id: input.requestId, assistant: 'long partial done evil', status: 'failed' }))?.turns[0].status).toBe('complete');
    });

    it('tombstones deletion, removes content and rejects delayed writes/imports/begins without resurrection', async () => {
        const input = prompt(); await repository.begin(owner, input);
        await repository.checkpoint(owner, input.conversationId, { id: input.requestId, assistant: 'secret partial', status: 'streaming' });
        await expect(repository.remove(owner, input.conversationId)).rejects.toMatchObject({ status: 409 });
        time += PLATFORM_STREAM_LEASE_MS + 1;
        await repository.remove(owner, input.conversationId);
        expect(await repository.get(owner, input.conversationId)).toBeNull();
        expect(await repository.list(owner)).toEqual([]);
        expect(await repository.checkpoint(owner, input.conversationId, { id: input.requestId, assistant: 'secret partial final', status: 'complete', usage: usage(input.requestId) })).toBeNull();
        await expect(repository.begin(owner, input)).rejects.toMatchObject({ status: 410 });
        await expect(repository.import(owner, { id: input.conversationId, model: 'test-model', turns: [importedTurn()] })).rejects.toMatchObject({ status: 410 });
        const [row] = await client.$queryRaw<{ deletedAt: Date | null }[]>`SELECT * FROM "PlatformConversation"
            WHERE "authority" = ${owner.authority} AND "issuer" = ${owner.issuer} AND "subject" = ${owner.subject} AND "id" = ${input.conversationId}::uuid`;
        expect(row).toMatchObject({ model: '', title: '', turns: [], activeUntil: null, importDigest: null });
        expect(row?.deletedAt).not.toBeNull();
        const deleteBeforeBegin = prompt(); await repository.remove(owner, deleteBeforeBegin.conversationId);
        await expect(repository.begin(owner, deleteBeforeBegin)).rejects.toMatchObject({ status: 410 });
    });

    it('imports legacy completed turns without usage explicitly, idempotently and without overwriting', async () => {
        const input = { id: randomUUID(), model: 'test-model', turns: [importedTurn()] };
        const first = await repository.import(owner, input);
        expect(await repository.import(owner, input)).toEqual(first);
        await expect(repository.import(owner, { ...input, turns: [{ ...input.turns[0], assistant: 'different' }] })).rejects.toMatchObject({ status: 409 });
        const next = { ...prompt(input.id), messages: [
            { role: 'user' as const, content: 'hello' }, { role: 'assistant' as const, content: 'world' }, { role: 'user' as const, content: 'new turn' },
        ] };
        await repository.begin(owner, next);
        expect((await repository.import(owner, input)).turns).toHaveLength(2);
        await expect(repository.import(owner, { id: randomUUID(), model: 'test-model', turns: input.turns })).rejects.toMatchObject({ status: 409 });
        expect((await repository.get(owner, input.id))?.turns[0].assistant).toBe('world');
    });

    it('retains cancellation/failure partials and allows only a new explicit request afterwards', async () => {
        for (const status of ['cancelled', 'failed'] as const) {
            const input = prompt(); await repository.begin(owner, input);
            await repository.checkpoint(owner, input.conversationId, { id: input.requestId, assistant: 'retained partial', status });
            const duplicate = await repository.begin(owner, input);
            expect(duplicate.created).toBe(false);
            expect(duplicate.turn).toMatchObject({ assistant: 'retained partial', status });
            expect((await repository.begin(owner, prompt(input.conversationId))).created).toBe(true);
        }
    });

    it('preserves legacy per-turn models and isolates imports for identical UUIDs across accounts', async () => {
        const turn = importedTurn();
        const input = { id: randomUUID(), model: 'new-model', turns: [{ ...turn, usage: usage(turn.id) }] };
        await repository.import(owner, input);
        const other = { ...owner, subject: '99' };
        await repository.import(other, { ...input, turns: [{ ...turn, assistant: 'different account' }] });
        expect((await repository.get(owner, input.id))?.turns[0]).toMatchObject({ assistant: 'world', usage: { model: 'test-model' } });
        expect((await repository.get(other, input.id))?.turns[0].assistant).toBe('different account');
    });

    it('bounds history and rejects oversized/untrusted stored fields', async () => {
        await expect(repository.begin(owner, { ...prompt(), messages: [{ role: 'user', content: 'x'.repeat(16001) }] })).rejects.toMatchObject({ status: 400 });
        await expect(repository.import(owner, { id: randomUUID(), model: 'test-model', turns: Array.from({ length: MAX_PLATFORM_TURNS + 1 }, () => importedTurn()) })).rejects.toMatchObject({ status: 400 });
        await expect(repository.import(owner, { id: randomUUID(), model: 'test-model', turns: [{ ...importedTurn(), status: 'streaming' }] })).rejects.toMatchObject({ status: 400 });
        await expect(repository.import(owner, { id: randomUUID(), model: 'test-model', turns: [{ ...importedTurn(), fingerprint: 'untrusted' }] } as any)).rejects.toMatchObject({ status: 400 });
        const data = Array.from({ length: MAX_PLATFORM_CONVERSATIONS }, () => ({ ...owner, id: randomUUID(), model: 'test-model', title: '', turns: [], requestIds: [] }));
        await pg.query('INSERT INTO "PlatformConversationOwner" ("authority", "issuer", "subject") VALUES ($1, $2, $3)', Object.values(owner));
        for (const row of data) await pg.query('INSERT INTO "PlatformConversation" ("authority", "issuer", "subject", "id", "model", "title") VALUES ($1, $2, $3, $4, $5, $6)', [row.authority, row.issuer, row.subject, row.id, row.model, row.title]);
        await expect(repository.begin(owner, prompt())).rejects.toMatchObject({ status: 413 });
        await repository.remove(owner, data[0].id);
        expect((await repository.begin(owner, prompt())).created).toBe(true);
    });
});
