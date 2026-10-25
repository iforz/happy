BEGIN;
-- No dependency on device-encrypted Account/Session data or authentication secrets.
CREATE TABLE IF NOT EXISTS "PlatformConversationOwner" (
    "authority" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    CONSTRAINT "PlatformConversationOwner_pkey" PRIMARY KEY ("authority", "issuer", "subject")
);
CREATE TABLE IF NOT EXISTS "PlatformConversation" (
    "authority" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "turns" JSONB NOT NULL DEFAULT '[]',
    "requestIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "importDigest" TEXT,
    "lastStatus" TEXT NOT NULL DEFAULT 'failed',
    "activeUntil" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformConversation_pkey" PRIMARY KEY ("authority", "issuer", "subject", "id"),
    CONSTRAINT "PlatformConversation_owner_fkey" FOREIGN KEY ("authority", "issuer", "subject")
        REFERENCES "PlatformConversationOwner"("authority", "issuer", "subject") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "PlatformConversation_authority_issuer_subject_updatedAt_idx"
    ON "PlatformConversation"("authority", "issuer", "subject", "updatedAt" DESC);
COMMIT;
