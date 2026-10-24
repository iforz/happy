# Independent TokenHub Work web login

Ordinary Work web login and model chat use a separate TokenHub platform session.
They do not create, restore, rebind, or require a Happy encrypted-device identity.
Existing Happy device credentials, identity bindings, encrypted history, native
login and device/socket authorization remain separate and unchanged.

## Explicit rollout configuration

Both sides default to the existing behavior. Review and enable them together:

- Work server: `TOKENHUB_PLATFORM_AUTH=true`.
- Web build: `HAPPY_PRODUCTION_PLATFORM_AUTH=1`.

The server also requires the existing unified SSO and real Core gateway settings.
No new Core OAuth client, signing key, database table/migration, or hostname literal
is introduced. Deployment origins remain injected configuration.

The Core contract still uses `happy-web` with the registered HTTPS callback path
`/tokenhub/callback`. If the UI is mounted at `/work`, the existing reverse proxy
must forward that root callback to the Work SPA while preserving code/state.
The exchange always uses the registered root URI, not `/work/tokenhub/callback`.
The trusted loopback proxy must overwrite the original browser IP and preserve its
User-Agent, since Core Work grants are bound to that request context.

## Security and lifecycle

The server alone retains the Core grant. The browser receives only an opaque
HttpOnly/Secure/SameSite cookie and a CSRF value. Every catalog/stream request binds
that CSRF value to the current cookie, then revalidates Core authority. Writes also
require the exact configured Origin. Platform sessions cannot authenticate Happy
account, file, device or socket routes.

Sessions are memory-only, bounded by the earlier of Core expiry and 24 hours.
A process restart signs users out of Work; they can sign in again with TokenHub.
There is no invented Work refresh token or automatic billed-request retry.

“Sign out of Work” immediately deletes the server-side session/grant and aborts
its active requests. It does not revoke the Core refresh family or sign out other
applications. Logout responses deliberately do not overwrite cookies: a delayed
response from an old tab must not erase a newer login. The residual opaque value
has no authority and is replaced on the next explicit login or expires naturally.

Normal Home/new routes do not initialize legacy credentials or sync. Entering or
leaving the separate device area uses a full document boundary so legacy sync
singletons cannot carry keys or background activity into the platform runtime.
Only that device area offers encrypted-device recovery.

New platform chat history has a separate authority/issuer/subject/server namespace
and a browser-local data-encryption key. This key is not an authentication credential
and never goes to the server. History is not synchronized across devices. Missing,
corrupt, or unavailable history storage does not block login, and unreadable old
ciphertext is never silently replaced. Existing Happy history remains untouched.

## Verification and deployment limits

Run the full TokenHub frontend integration suite, Happy server suite, both
TypeScript checks and the self-hosted web build. Tests use synthetic grants and
model output, not production credentials or paid inference. Hosted CI artifacts
are review builds, not deployment approval. Production acceptance still needs a
fresh phone/browser TokenHub login, reload/new tab, exact available model catalog,
account-switch isolation, and explicit Work logout. Do not claim a live login was
verified from unit tests or an anonymous static-page check.
