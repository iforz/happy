# Optional TokenHub client interface

This is an opt-in, read-only transport module, not a replacement for Happy Server.
It adds no startup requests, UI, login flow, storage, account binding, model
execution, payment operation, or deployment configuration. Happy identity,
encrypted session synchronization, and existing usage-report handling are unchanged.

## Contract

`createTokenHubClient({ baseUrl, tokenProvider, fetch? })` exposes:

| Method | GET endpoint | Credential scope | Result |
| --- | --- | --- | --- |
| `getBalance(signal?)` | `/api/v1/user/profile` | `panel` | `{ balance: number }` |
| `getUsageSummary(signal?)` | `/api/v1/usage/stats` | `panel` | Server summary object |
| `listModels(signal?)` | `/v1/models` | `gateway` | `{ id: string }[]` |

Panel endpoints are expected to return `{ code: 0, data: { ... } }`. The model
catalog is expected to return `{ data: [{ id: "..." }] }`. These are mocked
contract expectations, not a claim of live deployment compatibility. Usage
summary fields intentionally remain unknown until a consumer validates its
required fields. No currency, time window, model capability, or mapping from
backend usage to a Happy session is inferred. Balance is a display observation,
not an amount safe for client-side financial calculations.

The HTTPS base URL is an origin or deployment prefix, not an API endpoint.
For example, `https://gateway.example.test` or
`https://gateway.example.test/deployment`. The calling application must select
and verify this destination before supplying credentials. Do not take a base URL
from untrusted content. There is no default production host.

The token provider supplies an existing user-panel bearer token for `panel` and
an existing user gateway key for `gateway`. It must not supply a Happy auth token,
an administrator token, or an upstream provider key. Each request resolves its
credential anew; the adapter neither persists nor creates credentials. A host
application is responsible for authorized credential provisioning and refresh.

Requests omit cookies, reject redirects, disable caching, and never retry
automatically. Each operation accepts an AbortSignal; callers should use it to
bound request duration and cancel on navigation. Errors expose only a typed kind
and HTTP status, not upstream bodies, tokens, or URLs. No authentication failure
triggers login, renewal, or mutation automatically. Native fetch implementations
must honor the redirect and credential settings before enabling this transport.

## Trust boundary and future wiring

Backend usage is the source for account billing. Happy client-reported usage is
an estimate and must never become an instruction to deduct backend balance.
This interface performs no billing writes and sends no prompts or session data.
Displaying a gateway model ID does not prove Claude Code or Codex compatibility.

Later UI/provider wiring needs explicit feature configuration, validated summary
fields and units, user-scoped credentials, and deployment contract testing.
Account binding and SSO, if added later, must preserve Happy's public-key identity
and E2EE rather than equating an email login with encryption-key possession.

## Verification

From `packages/happy-app`, run:

```
pnpm exec vitest run sources/integrations/tokenhub/client.test.ts
```

All tests use injected fetch mocks and synthetic credential strings. They make no
network requests, generate no keys, and do not exercise a live model or payment.
