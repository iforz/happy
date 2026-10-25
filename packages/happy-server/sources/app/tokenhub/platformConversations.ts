import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { conversationMessages } from './coreGateway';
import type { PlatformPrincipal } from './platformSession';

/** Account history is deliberately unrelated to device Account/Session identities. */
export type PlatformConversationOwner = Pick<PlatformPrincipal, 'authority' | 'issuer' | 'subject'>;
export type PlatformTurnStatus = 'streaming' | 'complete' | 'failed' | 'cancelled';
export interface PlatformConversationUsage {
    requestId: string; coreRequestId?: string; model: string; inputTokens: number; outputTokens: number;
    mock: false; billable: true; accounting: 'core';
}
export interface PlatformConversationTurn {
    id: string; user: string; assistant: string; status: PlatformTurnStatus; usage?: PlatformConversationUsage;
}
export interface PlatformConversation {
    id: string; model: string; turns: PlatformConversationTurn[]; updatedAt: number;
}
export interface PlatformConversationSummary {
    id: string; model: string; title: string; updatedAt: number; lastStatus: PlatformTurnStatus;
}
export interface BeginPlatformConversation {
    conversationId: string; requestId: string; model: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
}
export type PlatformConversationCheckpoint = Pick<PlatformConversationTurn, 'id' | 'assistant' | 'status' | 'usage'>;
export interface ImportPlatformConversation { id: string; model: string; turns: PlatformConversationTurn[] }
export interface PlatformConversations {
    list(owner: PlatformConversationOwner): Promise<PlatformConversationSummary[]>;
    get(owner: PlatformConversationOwner, id: string): Promise<PlatformConversation | null>;
    begin(owner: PlatformConversationOwner, input: BeginPlatformConversation): Promise<{
        created: boolean; conversation: PlatformConversation; turn: PlatformConversationTurn;
    }>;
    checkpoint(owner: PlatformConversationOwner, id: string, turn: PlatformConversationCheckpoint): Promise<PlatformConversation | null>;
    remove(owner: PlatformConversationOwner, id: string): Promise<void>;
    import(owner: PlatformConversationOwner, input: ImportPlatformConversation): Promise<PlatformConversation>;
}
export class PlatformConversationError extends Error {
    constructor(public readonly status: number, public readonly code: string) { super(code); }
}

export const MAX_PLATFORM_CONVERSATIONS = 100;
export const MAX_PLATFORM_TURNS = 100;
export const MAX_PLATFORM_ASSISTANT_CHARS = 262144;
export const PLATFORM_STREAM_LEASE_MS = 180_000;
// The gateway caps an entire submitted context at 16,000 characters. A history can
// contain failed/partial turns too, but a single document remains bounded.
const MAX_CONVERSATION_CHARS = 1_000_000;
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const model = z.string().trim().min(1).max(200).refine(value => value !== 'default');
const usageSchema = z.object({
    requestId: uuid, coreRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(), model,
    inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    mock: z.literal(false), billable: z.literal(true), accounting: z.literal('core'),
}).strict();
const checkpointSchema = z.object({
    id: uuid, assistant: z.string().max(MAX_PLATFORM_ASSISTANT_CHARS),
    status: z.enum(['streaming', 'complete', 'failed', 'cancelled']), usage: usageSchema.optional(),
}).strict();
const importedTurnSchema = checkpointSchema.extend({ user: z.string().min(1).max(16000).refine(value => !!value.trim()) })
    .refine(turn => turn.status !== 'streaming');
const beginSchema = z.object({ conversationId: uuid, requestId: uuid, model, messages: conversationMessages }).strict();
const importSchema = z.object({ id: uuid, model, turns: z.array(importedTurnSchema).min(1).max(MAX_PLATFORM_TURNS) }).strict();
const ownerSchema = z.object({
    // Bound UTF-8 bytes so owner-prefixed PostgreSQL indexes stay below the B-tree limit.
    authority: z.string().min(1).refine(value => Buffer.byteLength(value) <= 2048),
    issuer: z.string().min(1).refine(value => Buffer.byteLength(value) <= 128),
    subject: z.string().min(1).refine(value => Buffer.byteLength(value) <= 128),
});
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new PlatformConversationError(400, 'invalid_history');
    return result.data;
}
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
interface StoredTurn extends PlatformConversationTurn { fingerprint?: string }
type StoredConversation = {
    id: string; model: string; title: string; turns: Prisma.JsonValue; requestIds: string[];
    updatedAt: Date; activeUntil: Date | null; deletedAt: Date | null; importDigest: string | null; lastStatus: PlatformTurnStatus;
};
function turnsOf(row: StoredConversation): StoredTurn[] { return row.turns as unknown as StoredTurn[]; }
function publicTurn(turn: StoredTurn): PlatformConversationTurn {
    return { id: turn.id, user: turn.user, assistant: turn.assistant, status: turn.status, ...(turn.usage ? { usage: { ...turn.usage } } : {}) };
}
function publicConversation(row: StoredConversation): PlatformConversation {
    return { id: row.id, model: row.model, turns: turnsOf(row).map(publicTurn), updatedAt: row.updatedAt.getTime() };
}
function titleOf(turns: StoredTurn[]) { return (turns[0]?.user ?? '').replace(/\s+/g, ' ').trim().slice(0, 120); }
function checkSize(turns: StoredTurn[]) {
    if (turns.length > MAX_PLATFORM_TURNS || turns.reduce((size, turn) => size + turn.user.length + turn.assistant.length, 0) > MAX_CONVERSATION_CHARS) {
        throw new PlatformConversationError(413, 'history_limit');
    }
}
function checkUsage(turn: PlatformConversationCheckpoint, conversationModel: string) {
    if (turn.usage && (turn.usage.requestId !== turn.id || turn.usage.model !== conversationModel)) {
        throw new PlatformConversationError(400, 'invalid_history');
    }
}

/** A database owner-row lock, not a process mutex, serializes request claiming,
 * account caps, deletion and checkpoints across server processes/devices. Locks
 * live only inside a short transaction, never across inference. Every lookup and
 * write includes the verified authority/issuer/subject. */
export function createPlatformConversations(database: Pick<PrismaClient, '$transaction'>, now: () => number = Date.now): PlatformConversations {
    type Tx = Prisma.TransactionClient;
    // Raw parameterized statements intentionally use the existing generated client:
    // deployment only needs this additive migration, not a regenerated Prisma engine/client.
    async function read(tx: Tx, owner: PlatformConversationOwner, id: string): Promise<StoredConversation | null> {
        const rows = await tx.$queryRaw<StoredConversation[]>`SELECT * FROM "PlatformConversation"
            WHERE "authority" = ${owner.authority} AND "issuer" = ${owner.issuer} AND "subject" = ${owner.subject} AND "id" = ${id}::uuid`;
        return rows[0] ?? null;
    }
    async function write(tx: Tx, owner: PlatformConversationOwner, row: StoredConversation, exists: boolean): Promise<StoredConversation> {
        const json = JSON.stringify(row.turns);
        if (exists) {
            await tx.$executeRaw`UPDATE "PlatformConversation" SET "model" = ${row.model}, "title" = ${row.title},
                "turns" = ${json}::jsonb, "requestIds" = ${row.requestIds}::uuid[], "importDigest" = ${row.importDigest},
                "lastStatus" = ${row.lastStatus}, "activeUntil" = ${row.activeUntil}, "deletedAt" = ${row.deletedAt}, "updatedAt" = ${row.updatedAt}
                WHERE "authority" = ${owner.authority} AND "issuer" = ${owner.issuer} AND "subject" = ${owner.subject} AND "id" = ${row.id}::uuid`;
        } else {
            await tx.$executeRaw`INSERT INTO "PlatformConversation"
                ("authority", "issuer", "subject", "id", "model", "title", "turns", "requestIds", "importDigest", "lastStatus", "activeUntil", "deletedAt", "updatedAt")
                VALUES (${owner.authority}, ${owner.issuer}, ${owner.subject}, ${row.id}::uuid, ${row.model}, ${row.title},
                    ${json}::jsonb, ${row.requestIds}::uuid[], ${row.importDigest}, ${row.lastStatus}, ${row.activeUntil}, ${row.deletedAt}, ${row.updatedAt})`;
        }
        return row;
    }
    async function locked<T>(suppliedOwner: PlatformConversationOwner, action: (tx: Tx, owner: PlatformConversationOwner) => Promise<T>): Promise<T> {
        const owner = parsed(ownerSchema, suppliedOwner);
        return database.$transaction(async tx => {
            await tx.$executeRaw`INSERT INTO "PlatformConversationOwner" ("authority", "issuer", "subject")
                VALUES (${owner.authority}, ${owner.issuer}, ${owner.subject}) ON CONFLICT DO NOTHING`;
            await tx.$queryRaw`SELECT "subject" FROM "PlatformConversationOwner"
                WHERE "authority" = ${owner.authority} AND "issuer" = ${owner.issuer} AND "subject" = ${owner.subject} FOR UPDATE`;
            return action(tx, owner);
        }, { maxWait: 5000, timeout: 10000 });
    }
    async function expire(tx: Tx, owner: PlatformConversationOwner, row: StoredConversation): Promise<StoredConversation> {
        if (row.deletedAt || !row.activeUntil || row.activeUntil.getTime() > now()) return row;
        const turns = turnsOf(row).map(turn => turn.status === 'streaming' ? { ...turn, status: 'failed' as const } : turn);
        return write(tx, owner, { ...row, turns: turns as unknown as Prisma.JsonValue,
            lastStatus: turns.at(-1)?.status ?? 'failed', activeUntil: null, updatedAt: new Date(now()),
        }, true);
    }
    async function capacity(tx: Tx, owner: PlatformConversationOwner) {
        const [result] = await tx.$queryRaw<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM "PlatformConversation"
            WHERE "authority" = ${owner.authority} AND "issuer" = ${owner.issuer} AND "subject" = ${owner.subject} AND "deletedAt" IS NULL`;
        if (result.count >= MAX_PLATFORM_CONVERSATIONS) {
            throw new PlatformConversationError(413, 'history_limit');
        }
    }
    async function conflictingRequest(tx: Tx, owner: PlatformConversationOwner, ids: string[], conversationId: string) {
        const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "PlatformConversation"
            WHERE "authority" = ${owner.authority} AND "issuer" = ${owner.issuer} AND "subject" = ${owner.subject}
                AND "id" != ${conversationId}::uuid AND "requestIds" && ${ids}::uuid[] LIMIT 1`;
        return rows.length > 0;
    }
    return {
        async list(owner) {
            return locked(owner, async (tx, safeOwner) => {
                const rows = await tx.$queryRaw<Pick<StoredConversation, 'id' | 'model' | 'title' | 'updatedAt' | 'activeUntil' | 'lastStatus'>[]>`
                    SELECT "id", "model", "title", "updatedAt", "activeUntil", "lastStatus" FROM "PlatformConversation"
                    WHERE "authority" = ${safeOwner.authority} AND "issuer" = ${safeOwner.issuer} AND "subject" = ${safeOwner.subject} AND "deletedAt" IS NULL
                    ORDER BY "updatedAt" DESC, "id" ASC LIMIT ${MAX_PLATFORM_CONVERSATIONS}`;
                const summaries: PlatformConversationSummary[] = [];
                for (const row of rows) {
                    let current = row;
                    if (row.activeUntil && row.activeUntil.getTime() <= now()) {
                        const full = (await read(tx, safeOwner, row.id))!;
                        const expired = await expire(tx, safeOwner, full);
                        current = { ...row, updatedAt: expired.updatedAt, activeUntil: null, lastStatus: turnsOf(expired).at(-1)?.status ?? 'failed' };
                    }
                    summaries.push({ id: current.id, model: current.model, title: current.title, updatedAt: current.updatedAt.getTime(), lastStatus: current.lastStatus as PlatformTurnStatus });
                }
                return summaries.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
            });
        },
        async get(owner, id) {
            id = parsed(uuid, id);
            return locked(owner, async (tx, safeOwner) => {
                const row = await read(tx, safeOwner, id);
                return row && !row.deletedAt ? publicConversation(await expire(tx, safeOwner, row)) : null;
            });
        },
        async begin(owner, input) {
            const safe = parsed(beginSchema, input);
            const fingerprint = digest({ model: safe.model, messages: safe.messages });
            return locked(owner, async (tx, safeOwner) => {
                let row = await read(tx, safeOwner, safe.conversationId);
                if (row?.deletedAt) throw new PlatformConversationError(410, 'conversation_deleted');
                if (row) row = await expire(tx, safeOwner, row) as typeof row;
                const turns = row ? turnsOf(row) : [];
                const existing = turns.find(turn => turn.id === safe.requestId);
                if (existing) {
                    if (existing.fingerprint !== fingerprint) throw new PlatformConversationError(409, 'conversation_conflict');
                    return { created: false, conversation: publicConversation(row!), turn: publicTurn(existing) };
                }
                if (row && turns.some(turn => turn.status === 'streaming')) throw new PlatformConversationError(409, 'conversation_conflict');
                if (await conflictingRequest(tx, safeOwner, [safe.requestId], safe.conversationId)) throw new PlatformConversationError(409, 'conversation_conflict');
                const savedContext = turns.filter(turn => turn.status === 'complete').flatMap(turn => [
                    { role: 'user' as const, content: turn.user }, { role: 'assistant' as const, content: turn.assistant },
                ]);
                if (JSON.stringify(savedContext) !== JSON.stringify(safe.messages.slice(0, -1))) throw new PlatformConversationError(409, 'conversation_conflict');
                const turn: StoredTurn = { id: safe.requestId, user: safe.messages.at(-1)!.content, assistant: '', status: 'streaming', fingerprint };
                turns.push(turn); checkSize(turns);
                const data: StoredConversation = { id: safe.conversationId, model: safe.model, title: titleOf(turns), turns: turns as unknown as Prisma.JsonValue,
                    requestIds: turns.map(turn => turn.id), lastStatus: 'streaming', activeUntil: new Date(now() + PLATFORM_STREAM_LEASE_MS),
                    deletedAt: null, importDigest: row?.importDigest ?? null, updatedAt: new Date(now()) };
                if (!row) await capacity(tx, safeOwner);
                row = await write(tx, safeOwner, data, !!row);
                return { created: true, conversation: publicConversation(row), turn: publicTurn(turn) };
            });
        },
        async checkpoint(owner, id, update) {
            id = parsed(uuid, id); const safe = parsed(checkpointSchema, update);
            return locked(owner, async (tx, safeOwner) => {
                const stored = await read(tx, safeOwner, id);
                if (!stored || stored.deletedAt) return null;
                const row = await expire(tx, safeOwner, stored), turns = turnsOf(row), turn = turns.at(-1);
                // A stale stream cannot modify a terminal turn or any newer request.
                if (!turn || turn.id !== safe.id || turn.status !== 'streaming') return publicConversation(row);
                // Checkpoints are append-only; a delayed smaller snapshot cannot truncate output.
                if (!safe.assistant.startsWith(turn.assistant)) return publicConversation(row);
                checkUsage(safe, row.model);
                if (safe.status === 'complete' && !safe.usage) throw new PlatformConversationError(400, 'invalid_history');
                Object.assign(turn, safe); checkSize(turns);
                const updated = await write(tx, safeOwner, { ...row,
                    turns: turns as unknown as Prisma.JsonValue, lastStatus: safe.status, updatedAt: new Date(now()),
                    // Never extend the lease. It is longer than the bounded gateway run.
                    activeUntil: safe.status === 'streaming' ? row.activeUntil : null,
                }, true);
                return publicConversation(updated);
            });
        },
        async remove(owner, id) {
            id = parsed(uuid, id);
            return locked(owner, async (tx, safeOwner) => {
                const stored = await read(tx, safeOwner, id);
                if (stored && !stored.deletedAt) {
                    const current = await expire(tx, safeOwner, stored);
                    if (turnsOf(current).some(turn => turn.status === 'streaming')) throw new PlatformConversationError(409, 'conversation_conflict');
                }
                // Even delete-before-begin creates a tombstone, closing that race without
                // revealing whether the UUID belongs to another account.
                await write(tx, safeOwner, { id, model: '', title: '', turns: [], requestIds: stored?.requestIds ?? [], lastStatus: 'failed',
                    importDigest: null, activeUntil: null, deletedAt: new Date(now()), updatedAt: new Date(now()),
                }, !!stored);
            });
        },
        async import(owner, input) {
            const safe = parsed(importSchema, input); checkSize(safe.turns);
            const ids = safe.turns.map(turn => turn.id);
            if (new Set(ids).size !== ids.length) throw new PlatformConversationError(400, 'invalid_history');
            for (const turn of safe.turns) checkUsage(turn, turn.usage?.model ?? safe.model);
            const importDigest = digest(safe);
            return locked(owner, async (tx, safeOwner) => {
                const existing = await read(tx, safeOwner, safe.id);
                if (existing?.deletedAt) throw new PlatformConversationError(410, 'conversation_deleted');
                if (existing) {
                    if (existing.importDigest !== importDigest) throw new PlatformConversationError(409, 'conversation_conflict');
                    return publicConversation(await expire(tx, safeOwner, existing));
                }
                await capacity(tx, safeOwner);
                if (await conflictingRequest(tx, safeOwner, ids, safe.id)) throw new PlatformConversationError(409, 'conversation_conflict');
                const row = await write(tx, safeOwner, { id: safe.id, model: safe.model,
                    title: titleOf(safe.turns), turns: safe.turns as unknown as Prisma.JsonValue, requestIds: ids,
                    importDigest, lastStatus: safe.turns.at(-1)!.status, activeUntil: null, deletedAt: null, updatedAt: new Date(now()),
                }, false);
                return publicConversation(row);
            });
        },
    };
}

let defaultRepository: Promise<PlatformConversations> | undefined;
/** Keep route registration/auth-only tests independent of database initialization. */
export function getPlatformConversations(): Promise<PlatformConversations> {
    return defaultRepository ??= import('../../storage/db').then(({ db }) => createPlatformConversations(db)).catch(error => {
        defaultRepository = undefined; throw error;
    });
}
