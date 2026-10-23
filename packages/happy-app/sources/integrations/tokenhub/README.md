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
