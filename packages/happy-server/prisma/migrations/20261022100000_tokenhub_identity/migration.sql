CREATE TABLE "TokenHubIdentity" (
 "authority" TEXT NOT NULL,
 "issuer" TEXT NOT NULL,
 "subject" TEXT NOT NULL,
 "accountId" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "TokenHubIdentity_pkey" PRIMARY KEY ("authority", "subject"),
 CONSTRAINT "TokenHubIdentity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TokenHubIdentity_authority_accountId_key" ON "TokenHubIdentity"("authority", "accountId");
