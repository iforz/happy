export interface Identity { issuer: string; subject: string }
/** The existing Happy public-key identity is authoritative for encrypted data. */
export async function bindIdentity(database: any, authority: string, identity: Identity, publicKey: string): Promise<string> {
    return database.$transaction(async (tx: any) => {
        const existing = await tx.tokenHubIdentity.findUnique({ where: { authority_subject: { authority, subject: identity.subject } }, include: { account: true } });
        if (existing) {
            if (existing.issuer !== identity.issuer || existing.account.publicKey !== publicKey) throw new Error('identity_key_mismatch');
            return existing.accountId;
        }
        const account = await tx.account.upsert({ where: { publicKey }, update: {}, create: { publicKey } });
        const other = await tx.tokenHubIdentity.findUnique({ where: { authority_accountId: { authority, accountId: account.id } } });
        if (other) throw new Error('identity_key_mismatch');
        await tx.tokenHubIdentity.create({ data: { authority, issuer: identity.issuer, subject: identity.subject, accountId: account.id } }); return account.id;
    });
}
