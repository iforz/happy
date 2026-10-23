# Happy Work local mock

The Work experiment is disabled by default. Mock mode is a local development
fixture with synthetic usage counts. It does not call a real model or charge an
account. Existing Happy conversations are unchanged.

## Run the mock

From an already configured Happy development environment, start the local fixture:

```sh
pnpm --filter happy-server exec node --import tsx scripts/tokenhub-mock-gateway.ts
```

Set these two Happy development settings before starting the server:

```sh
TOKENHUB_GATEWAY_MODE=mock
TOKENHUB_MOCK_GATEWAY_URL=http://127.0.0.1:3099
```

Open `/tokenhub/work-mock` after signing in normally. The mock offers `mock-echo`,
`mock-slow`, and `mock-error` for successful, delayed, and failed responses.
Use `TOKENHUB_GATEWAY_MODE=disabled` to turn the experiment off. This does not
deploy the service or enable real model calls.

The same experiment page can separately support real mode. See
[Happy gateway adapter](TOKENHUB-WORK-CORE.md). Real-mode requests may incur
charges; the mock's non-billable guarantees do not apply to real mode.

## Tests

```sh
pnpm --filter happy-server exec vitest run sources/app/tokenhub/mockGateway.spec.ts sources/app/api/routes/tokenHubWorkRoutes.spec.ts
pnpm --filter happy-server typecheck
pnpm --filter happy-server typecheck:prod
pnpm --filter happy-app exec vitest run --config vitest.tokenhub.config.ts
pnpm --filter happy-app typecheck
```

These tests use local fixtures, not paid APIs or production account data. Passing
them is not production acceptance or approval to deploy.
