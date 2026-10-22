# TokenHub web integration — work in progress

Intermediate source snapshot, committed at the user's request before full
validation and web export. It has not been deployed.

Implemented source includes a public display contract, same-origin configuration
proxy, validated cache/offline fallback, web landing page, consent redirect and
callback, short-lived state/cookie/PKCE handling, RS256 assertion verification,
and a proposed external-subject-to-native-public-key binding migration.
External assertions are not Happy session tokens. Happy's existing signer issues
its own session only after identity proof and binding. A mismatched public key
requires restoring the original Happy identity; local encryption keys are not
sent to the external provider.

Focused validation now passes: 18 relay tests across six files and 39 client
tests across three files. These cover URL/SSRF boundaries,
issuer/audience/nonce/expiry, state consumption, public-key proof, replay,
cancellation, concurrent binding conflict recovery, stale callback isolation,
and display cache fallback. The additive migration was applied twice to a real
isolated PGlite database and both identity uniqueness constraints were checked.
Client contract tests resolve the shared display source directly; production
workspace package resolution still needs its build check.

Locked dependency installation, Prisma generation, shared-wire build, application
full typecheck, server full typecheck and production server typecheck now pass.
The server uses the standard TypeScript DOM definitions for the WebAssembly and
Web APIs available in Node 24, with ambient package types limited to Node.
Production web export and runtime smoke checks remain required.
Passing isolated tests is not proof of production account federation. No live
user or test encryption identity has been created.

The only bootstrap provider destination is TOKENHUB_URL, an explicitly trusted
HTTPS origin. Do not accept that value from a URL query or provider response.
HAPPY_PUBLIC_ORIGIN fixes the self-host callback origin. TOKENHUB_SSO_ENABLED
remains off unless the deployment has explicitly authorized the client and
persistent account binding. Never commit credentials or production state.

This development branch is separate from upstream main. Publishing native/OTA
or CLI packages is outside this work.

## Work unified authorization (cloud development, not deployed)

Launch-time `TOKENHUB_UNIFIED_AUTH=true` switches both authenticated HTTP routes
and Socket.IO to the same live authorization gate. Set
`TOKENHUB_AUTHCENTER_URL=http://127.0.0.1:28084`; only an explicit literal IPv4
loopback HTTP origin is accepted. The trust configuration is captured before
listening, not taken from incoming requests. `TOKENHUB_URL` still identifies the
trusted HTTPS account origin and persisted identity authority. An invalid
configuration fails startup rather than silently enabling legacy login.

The SSO exchange must include a Core-issued, Work-only `authorization_token`
beside its existing RS256 `id_token`. Before binding an account, Happy asks
Authcenter `POST /v1/session/verify` with bearer authorization and the body
`{"application":"work"}`. Authcenter returns a bare JSON identity with
`active: true`, `application: "work"`, `issuer: "tokenapi"`, decimal `subject`,
nonempty `session_id`, future Unix-seconds `expires_at`, and
`permissions: ["work:access"]`. The Core endpoint's success envelope is unwrapped
by Authcenter, not accepted by Work. Core remains responsible for HS256 checks,
session/refresh-family revocation, token version, disabled users and current
policy. No second user registry or signing secret is added to Happy.

Happy's existing signer embeds that Work grant, trusted origin, issuer, subject
and proved public key in its session extras. Every protected request rechecks
the SSO issuer against the persisted binding; this configurable identity issuer
is distinct from the authorization service's fixed `tokenapi` issuer. It rechecks
the Happy signature without using its legacy token cache, then calls Authcenter
and checks the current persisted TokenHub identity/account/public-key binding.
There is no successful-authorization cache. Missing extras, revoked/disabled
sessions, mismatched identities, network failures and a two-second verification
deadline all deny access. Authority response bodies are bounded and redirects
are forbidden. Legacy `/v1/auth` and all terminal/account pairing endpoints
return 403 in unified mode; they remain unchanged when unified mode is off.

Socket.IO checks before connection, before every inbound application event,
and every 15 seconds while idle. A separate expiry timer disconnects exactly at
the known expiry; an idle revocation/failure is detected within 15 + 2 seconds.
Disconnect cleans both timers, and an in-flight result cannot revive a socket
or dispatch a queued event afterward. Existing per-object ownership checks are
not replaced by the unified identity gate.

An API registration boundary additionally attaches the shared gate to any new
`/vN/...` route that omitted it. Only the explicit version and TokenHub
config/start/complete bootstrap endpoints are exempt, alongside static web and
CORS preflight. Raw `/files/*` reads are disabled because they lack per-object
ownership checks; use authenticated attachment/avatar endpoints instead. Legacy
debug log ingestion and GitHub OAuth params/callback/webhook are disabled in
unified mode pending a separately bound integration. Browser images backed by
raw file URLs will therefore no longer load in that mode; no bearer token is
placed in a URL as a workaround.

Happy forwards only Fastify's resolved `request.ip` or the Socket.IO peer address
(normalizing IPv4-mapped IPv6) and the request User-Agent. It does not copy client
`X-Forwarded-For` or `X-Client-IP`. The local slice leaves Fastify's proxy trust
disabled; a separately reviewed trusted-ingress design is a deployment
prerequisite when Core IP/UA binding is enabled. Do not weaken Core binding to
make a proxy deployment pass. This slice has no refresh/re-issuance UI: when the
bounded Work grant expires, the client must sign in again.

Focused tests use isolated keys, mocked authority responses, in-memory storage
and real loopback HTTP/WebSocket transports. They do not create a live Core
session, call a real model/API provider, or prove a production federation login.
