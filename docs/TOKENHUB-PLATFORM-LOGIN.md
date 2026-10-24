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

The server alone retains the Core grant. The browser receives only a server-minted,
256-bit opaque `__Host-` cookie (HttpOnly, Secure, SameSite=Lax, no Domain) and a CSRF
value. The cookie identifies a browser channel, not an authenticated principal.
Only `/start` can mint it, and only when no unexpired server-issued channel exists.
Each channel has one current state/nonce/PKCE flow. Verified completion replaces its
principal and grant atomically, rotates CSRF, and aborts the previous principal's
requests. Completion, including errors, never writes cookies, so a delayed success
cannot replace a newer login. Unknown client-chosen IDs are never adopted.
The public `sessionId` is a non-credential identifier for this particular BFF login,
not the Core SID. It changes even when the same Core account/session signs in again,
so a saved sign-out intent cannot target the newer login. The Core SID remains
server-side for live authority verification.

Every catalog/stream request binds its CSRF value to the current channel principal,
then revalidates Core authority. Writes also require the exact configured Origin.
A stale tab's CSRF is rejected before a catalog or model request. Platform sessions
cannot authenticate Happy account, file, device or socket routes.

Channels and flows are bounded and memory-only. Anonymous channels and login flows
expire after five minutes; channels have a fixed 24-hour absolute lifetime. An
authenticated principal expires at the earlier of Core expiry and that absolute
lifetime. Expiry or process restart requires a fresh start and verified login.
There is no invented Work refresh token or automatic billed-request retry.
Two simultaneous first-ever starts without an existing cookie can create separate
anonymous channels. If an older start response arrives late, it can require a new
login, but cannot link or restore the other channel's authenticated principal.

“Sign out of Work” immediately deletes the server-side principal/grant, cancels its
pending login flow, and aborts active requests. It does not revoke the Core refresh
family or sign out other applications. Logout never writes cookies, so a delayed
response cannot erase a newer login. The remaining channel has no authority and
expires within five minutes unless a new explicit login starts; its cookie is
reused only through a fresh verified flow. No cookie-byte deletion is claimed.
A failed logout retains only public session-instance metadata for a safe retry;
it never persists CSRF or grants. The signed-out page also retains a non-sensitive
URL stop marker until explicit login, so reload/foreground cannot silently restore
an old or another tab's newer cookie. A retry never revokes a different BFF instance.

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
