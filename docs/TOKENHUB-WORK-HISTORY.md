# TokenHub Work account history

Ordinary platform chats use the existing Work PostgreSQL/PGlite database. They are
owned by the live verified TokenHub authority, issuer and subject, not by a
browser-supplied ID or the separate encrypted-device Happy account. Platform
history is server-readable; this does not move, unwrap or weaken device-agent
Session/SessionMessage keys or ciphertext.

The platform cookie pair, current CSRF token, same-origin checks and live Core
session verification protect every history endpoint, including list/load. A
browser/account change invalidates in-flight UI work and old CSRF tokens. History
responses are no-store. A new login for the same account on another browser can
load the same conversations.

- GET `/v1/tokenhub/platform/conversations` lists account summaries.
- GET `/v1/tokenhub/platform/conversations/:id` loads one conversation.
- DELETE `/v1/tokenhub/platform/conversations/:id` removes its server content.
  An active stream must finish first. A content-free tombstone prevents delayed
  writes or retries from resurrecting deleted messages.
- POST `/v1/tokenhub/platform/conversations/import` imports one explicitly chosen
  local conversation. Existing cloud content cannot be overwritten.
- The platform stream accepts `conversationId` and a stable UUID `requestId`.
  It durably claims a user turn before inference, checks the submitted context
  against completed server turns, checkpoints partial text, and commits final
  content before reporting completion. Repeating a recorded request is a conflict,
  never a second inference/billing attempt. Old device gateway routes are unchanged.

Old browser ciphertext and its local key remain intact and read-only in the new
platform surface. There is no automatic migration or bulk upload. The import
confirmation identifies the Work service and TokenHub account; cloud deletion
never removes the old local copy. A failed import may be retried using the same
IDs. A failed model request must be reconciled by reading server history and Core
usage, not by automatic inference retry.

Interrupted streams retain persisted partial text. Their bounded 180-second lease
expires to failed after a process crash; an actively streaming conversation from
another device is read-only until reconciled. Completed usage is display data,
not an independent charge receipt. Current limits are 100 live conversations,
100 turns per conversation, 262144 characters per assistant turn, and 1000000
characters per conversation; model context retains the existing 16000-character
limit. Limits fail visibly rather than evicting old history.

## Required deployment migration

This release is **migration-required**, not a migration-free delta-v1. No package,
lockfile, Node image, native module, Prisma engine or generated-client update is
required. The repository uses parameterized SQL through the existing Prisma
transaction API. The additive schema is also declared in Prisma for future
standard builds.

Only migration `20261025120000_platform_conversations` is added. It creates
`PlatformConversationOwner`, `PlatformConversation`, their account-scoped primary
keys, one owner foreign key and an updated-at index. It does not alter existing
Account, Session, SessionMessage, TokenHubIdentity or Core tables. Its DDL is
transactional and replay-safe; the existing standalone runner records the version
in `_prisma_migrations` after success.

The base-station update must be a separately reviewed migration-capable operation:

1. Pin the current Work source, image, dependency and configuration hashes. Keep
   the existing manager update lock for the entire operation. Stage only the
   reviewed app files and the exact new migration; do not relax delta-v1 checks.
2. Stop the current Work process/container and confirm it is stopped. Back up the
   entire persistent `/data` volume while it is quiescent, retaining the old
   release and configuration. Never open the same PGlite directory from a second
   process while Work is running.
3. In a one-shot process using the unchanged Node image/dependencies, mount the
   staged release at `/app` and the same data at `/data`. Put the reviewed
   migration at `/app/prisma/migrations/20261025120000_platform_conversations/`.
   Run from `/app` with the existing standalone runner:
   `DATA_DIR=/data PGLITE_DIR=/data/pglite node dist/standalone.mjs migrate`.
   The outer base-station lock plus the stopped owner ensures exclusive PGlite
   ownership; the existing migration-version record skips completed migrations.
4. Close the migration process before starting exactly one new Work instance.
   Preserve its original configuration, grants and device-encrypted data. Verify
   health and unauthenticated history endpoints fail closed, then validate account
   isolation and cross-device history with authorized test accounts.
5. On failure retain the backup, old release and diagnostics. An old application
   can ignore these additive tables, but do not automatically delete tables or
   restore a stale backup over new user messages. Data restoration is a separate
   explicit recovery decision.

A successful compile/unit test is not evidence this production migration ran.
