export interface Identity { issuer: string; subject: string }
/** The existing Happy public-key identity is authoritative for encrypted data. */
export async function bindIdentity(database: any, authority: string, identity: Identity, publicKey: string): Promise<string> {
    try { return await database.$transaction(async (tx: any) => {
        const existing = await tx.tokenHubIdentity.findUnique({ where: { authority_subject: { authority, subject: identity.subject } }, include: { account: true } });
        if (existing) {
            if (existing.issuer !== identity.issuer || existing.account.publicKey !== publicKey) throw new Error('identity_key_mismatch');
            return existing.accountId;
        }
        const account = await tx.account.upsert({ where: { publicKey }, update: {}, create: { publicKey } });
        const other = await tx.tokenHubIdentity.findUnique({ where: { authority_accountId: { authority, accountId: account.id } } });
        if (other) {
            if (other.subject === identity.subject && other.issuer === identity.issuer) return account.id;
            throw new Error('identity_key_mismatch');
        }
        await tx.tokenHubIdentity.create({ data: { authority, issuer: identity.issuer, subject: identity.subject, accountId: account.id } }); return account.id;
    }); } catch (error) {
        // The losing transaction rolls back first. Re-read a concurrent winner;
        // same identity/key is idempotent, a different key must never replace it.
        if ((error as { code?: string })?.code === 'P2002') {
            const winner = await database.tokenHubIdentity.findUnique({ where: { authority_subject: { authority, subject: identity.subject } }, include: { account: true } });
            if (winner?.issuer === identity.issuer && winner.account.publicKey === publicKey) return winner.accountId;
            throw new Error('identity_key_mismatch');
        }
        throw error;
    }
}
