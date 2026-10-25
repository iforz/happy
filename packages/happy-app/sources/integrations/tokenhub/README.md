# Optional TokenHub client integration

This directory contains the optional read-only TokenHub client and the isolated
Work experiment client. These do not replace Happy Server, the normal session
composer, or existing provider selectors. The experiment is disabled by default.

`client.ts` provides read-only balance, usage-summary and model-list operations
for an explicitly configured application. It does not execute models, perform
payments or deploy a service. Its tests use synthetic data.

`workMockClient.ts` supports the separate `/tokenhub/work-mock` experiment screen
on web and native platforms. The screen labels mock and real modes separately.
Mock usage is synthetic and non-billable. Real requests may incur charges even
when a response is interrupted or cancelled. Neither client automatically retries
model requests or performs refunds. Displayed usage is not a charge receipt.

See the minimal usage guides:

- [Local mock](../../../../../docs/TOKENHUB-WORK-MOCK.md)
- [Optional real gateway adapter](../../../../../docs/TOKENHUB-WORK-CORE.md)

## Verification

From the repository root:

```sh
pnpm --filter happy-app exec vitest run --config vitest.tokenhub.config.ts
pnpm --filter happy-app typecheck
```

Tests cover the client parser and screen interactions using local synthetic
fixtures. They do not call paid models, validate production billing, or approve
a deployment. Signing in to a live service and native-device acceptance remain
separate checks.

## Ordinary Work account history

`PlatformAccountConversation.tsx` uses cookie/CSRF-authenticated account history
from `platformConversationClient.ts`. The server is authoritative: every new
platform stream carries a conversation UUID and a stable request/turn UUID, and
its result is read back after success, failure, or cancellation. Read-only
reconciliation waits for saved terminal status, including streams on other
devices. Model inference is never retried automatically. Focus, reload, and
account/session boundaries invalidate stale requests.

The old browser-encrypted records and their data keys remain unchanged. They are
shown separately as browser-only records; continuing one requires an explicit
per-conversation import confirmation naming the Work server and TokenHub account.
Imports are idempotent and retain the browser copy. Confirmed deletion affects
only server account history. Device/native history and gateway request shapes
remain separate and unchanged.
