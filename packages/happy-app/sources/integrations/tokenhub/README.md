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

## Isolated Work mock experiment

`/tokenhub/work-mock` is an opt-in, Web-only experiment. It does not alter the
existing provider/model selectors or session composer. It uses a separate
`createWorkMockClient` from `workMockClient.ts`, not the read-only client above.
The screen obtains the current Happy token from `useAuth()` and the selected
Happy server URL from `getServerUrl()`. It never sends the encryption secret,
a TokenHub gateway key, a user/session identifier, or client-supplied usage.

- `GET /v1/tokenhub/work/models` requires the existing Happy bearer token and
  returns `{ mode: "mock", billable: false, models: [{ id, name }] }`.
- `POST /v1/tokenhub/work/stream` sends exactly `{ model, prompt }` and the same
  bearer credential. Models are `mock-echo`, `mock-slow`, and `mock-error`.
- NDJSON events are `delta` (`text`), `usage` (`inputTokens`, `outputTokens`,
  `model`, `requestId`, `mock: true`, `billable: false`), and `done`, or `error`.
  A validated usage record and explicit done record are both required for
  success. Error events, malformed JSON/UTF-8, invalid event order and
  premature EOF fail; partial output stays visible but is never called complete.
- Responses are bounded to 256 KiB (catalog: 16 KiB), individual lines to 16 Ki
  UTF-16 code units, prompts to 4,000 characters, and requests to 30 seconds.
  Cancel, leaving the screen, and a changed login abort pending requests.
- HTTPS is required except for local loopback HTTP development. Cookies,
  redirects, cache and retries are disabled. Errors never include response
  bodies or secrets. Catalog and usage values are projected to display fields.
- The backend is disabled by default. A 503 is shown as disabled/unavailable,
  not substituted with local success data. Counts are simulated, not billing.

Run all isolated TokenHub tests without external requests:

```sh
pnpm --filter happy-app exec vitest run --config vitest.tokenhub.config.ts
pnpm --filter happy-app typecheck
```

`workMockClient.test.ts` tests the bounded transport with synthetic fetch
responses. `workMockScreen.test.ts` renders the actual screen with real React
hooks/handlers and the real client; only native view primitives, app auth and
routing are mocked. It verifies model selection, request shape, visible chunks,
repeated starts, cancel/restart, errors, disabled/retry state and abort/cleanup
on authentication changes and unmount. These are component interactions, not a
full browser/Expo navigation or live-auth end-to-end test.
