# Work gateway experiment: local mock only

This isolated slice connects a model selector in `/tokenhub/work-mock` to Happy
Work's authenticated HTTP routes, a fixed loopback mock gateway, streamed text,
cancellation, upstream-error handling and attributable synthetic usage. **It is
not a production Core gateway integration, real model inference or billing.**
Existing Happy provider/model selectors and inference routes are unchanged.

## Enable explicitly for local development

Start the fixture from the Happy repository:

```sh
pnpm --filter happy-server exec node --import tsx scripts/tokenhub-mock-gateway.ts
```

The fixture binds only `127.0.0.1:3099`. Set `TOKENHUB_MOCK_PORT` to choose another
local port. It contains no provider SDKs or credentials and makes no outbound
requests. It does not log prompt text, authentication data or user identities.

In the **Happy server** launch environment, use the already configured unified
Work authorization and explicitly add:

```sh
TOKENHUB_GATEWAY_MODE=mock
TOKENHUB_MOCK_GATEWAY_URL=http://127.0.0.1:3099
```

`TOKENHUB_UNIFIED_AUTH=true` and its existing trusted Authcenter/Core settings
are required. Do not supply real provider keys. An absent/empty gateway mode or
`disabled` leaves the feature unavailable. Any other mode fails startup. The
URL must be a literal HTTP `127.0.0.1:port` origin with no path, credentials,
query or fragment; DNS aliases and redirects are rejected. It is captured once
at route construction, never selected by browser input. For local-only testing,
bind the Happy server itself to loopback too. No deployment is required.

Open the web app's `/tokenhub/work-mock` route after completing the existing
unified login. The experiment is web-only and requires browser Fetch streaming.
Three clearly labelled models are available:

- `mock-echo`: deterministic echo chunks.
- `mock-slow`: delayed chunks for exercising cancellation.
- `mock-error`: deliberate upstream HTTP failure.

This is a separate direct-link experiment, not a replacement for normal session
creation or the existing provider/model picker.


### Isolated standalone launch (not service-manager integration)

The existing service manager does **not** automatically pass these new gateway
variables or start the fixture. Its defaults remain disabled. This change does
not claim that a managed Work service is already connected to a gateway.

Use a separate terminal with the already prepared **test-only** unified Work
environment, including a non-production `HANDY_MASTER_SECRET`, trusted
`TOKENHUB_URL`, loopback `TOKENHUB_AUTHCENTER_URL`, and a dedicated test database
whose account/identity binding matches the test login. Then explicitly launch:

```sh
# From the Happy repository; never reuse production data or credentials.
: "${WORK_MOCK_DATA_DIR:?Set a dedicated isolated test data directory}"
: "${HANDY_MASTER_SECRET:?Load the existing test-only Happy secret}"
: "${TOKENHUB_URL:?Load the trusted test authority origin}"
: "${TOKENHUB_AUTHCENTER_URL:?Load the loopback test Authcenter origin}"
export DATA_DIR="$WORK_MOCK_DATA_DIR"
export PGLITE_DIR="$DATA_DIR/pglite"
export HOST=127.0.0.1 PORT=13005
export TOKENHUB_UNIFIED_AUTH=true
export TOKENHUB_GATEWAY_MODE=mock
export TOKENHUB_MOCK_GATEWAY_URL=http://127.0.0.1:3099
pnpm --filter happy-server exec node --import tsx sources/standalone.ts migrate
pnpm --filter happy-server exec node --import tsx sources/standalone.ts serve
```

Point the development web app's existing server setting at
`http://127.0.0.1:13005`. The mock fixture must be running separately. A fresh
empty database does not contain the required verified identity binding; this
feature does not create an account, invent a session or bypass login. Either
use the established isolated unified-login test setup or run the self-contained
tests below, which do not need real credentials, live services or browser login.

## Contract and trust boundary

- `GET /v1/tokenhub/work/models`: existing Happy bearer authentication; returns
  `mode: "mock"`, `billable: false` and the fixed mock catalog.
- `POST /v1/tokenhub/work/stream`: same authentication; accepts only `{ model,
  prompt }`. Prompt length is 1–4,000 characters; JSON body is capped at 32 KiB.
  Unknown fields (including identity, usage, URL and keys) are rejected.
- Response is newline-delimited JSON: `delta` events, one `usage`, then explicit
  `done`; failures yield a sanitized `error`. EOF without `done` is a failure.
  Headers identify mock mode and disable caching/proxy buffering.
- The loopback fixture receives only model, prompt and a server-generated UUID.
  No Happy bearer token, Core authorization token, user/subject/session identity
  or browser-supplied destination is forwarded.
- A process-local bounded diagnostic ledger (maximum 1,000 completed records)
  binds each successful usage record to the middleware's live-verified Happy
  user and Core authority/issuer/subject/session ID. These come only from
  `request.workSession`, after signature, live authorization and current
  database-binding verification. Browser fields and upstream identity claims
  never become attribution. Public events expose only the request ID/model/
  synthetic counts, not internal identities or session IDs.
- Counts are synthetic character-based estimates emitted by the mock fixture.
  They are **not real tokenizer results or chargeable usage**. There is no
  billing mutation, quota debit, payment call or persistent accounting table.
  Cancelled, invalid, failed and truncated streams produce no completed usage
  record. This intentionally is not partial-consumption billing logic.
- Disconnect or browser AbortController cancellation aborts the upstream fetch.
  Streams stop at verified session expiry and revalidate authorization every
  15 seconds through the existing two-second-bounded verifier; revocation,
  changed identity or authority failure stops further deltas and cancels the
  provider. Revalidation does not extend the original request's expiry.
- Each provider stream has a 30-second whole-request timeout and 64 KiB maximum
  response. Parsing validates event shapes and order, rejects forged fields,
  duplicate/out-of-order usage and trailing events, and never exposes upstream
  error bodies. A provider response must also carry `X-TokenHub-Mock: true`;
  an unmarked local service is rejected. No transport redirect is followed.

## Verification

```sh
pnpm --filter happy-server exec vitest run sources/app/tokenhub/mockGateway.spec.ts sources/app/api/routes/tokenHubWorkRoutes.spec.ts
pnpm --filter happy-server typecheck
pnpm --filter happy-server typecheck:prod
pnpm --filter happy-app exec vitest run --config vitest.tokenhub.config.ts
pnpm --filter happy-app typecheck
CI=1 EXPO_OFFLINE=1 EXPO_NO_TELEMETRY=1 pnpm --filter happy-app exec expo export --platform web --max-workers 2 --output-dir /tmp/work-mock-web
```

Server tests exercise actual local HTTP listeners for model transmission,
chunking, authenticated attribution, browser abort propagation, authorization
revocation/expiry and simulated errors. Protocol/configuration tests cover
fail-closed defaults, pinned loopback origins and malformed/truncated streams.
Frontend client and real-screen component interaction tests live beside the
client under `packages/happy-app/sources/integrations/tokenhub/`. Component tests
use the installed React test renderer with mocked platform/auth/router boundaries
and the real screen, client, hooks and event handlers. They are not a screenshot
or a claim of an authenticated production-browser end-to-end test.

Before any production inference integration, independently implement and review
the actual Core gateway contract, server credential provisioning, provider/model
catalog, quotas, authoritative usage persistence, idempotency, partial usage,
pricing and reconciliation. This mock slice does not claim any of those are
complete and must not be pointed at a production provider.
