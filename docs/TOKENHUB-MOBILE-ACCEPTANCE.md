# TokenHub mobile acceptance boundaries

This is an acceptance addendum to [the mobile implementation notes](TOKENHUB-MOBILE.md) and [the self-hosted build gate](TOKENHUB-MOBILE-BUILD.md). Source tests and Metro exports are not installed-device or production-deployment acceptance.

## Binding prerequisite and actual defaults

Native `/start` and `/complete` **always** require the same server-observed, canonical peer IP and the exact app UA `TokenHubWorkNative/1`. A changed context is rejected locally by Work before authority verification/exchange. This transaction check is independent of Core's session-binding switch.

For **subsequent protected HTTP, streaming and WebSocket traffic**, Core's existing `session_binding_enabled` setting controls IP/UA binding verification and family revocation on mismatch. The combined isolated cross-service E2E explicitly enables that setting. If it is disabled, do not claim that ordinary protected native traffic is rejected or its family revoked merely because its IP/UA changes. The mandatory native transaction check above still applies. Statements that a network change invalidates subsequent native sessions are conditional on this setting being enabled.

The IP in this contract is the peer address Work actually observes through its framework `request.ip` (normally the TCP peer under the current configuration), not an arbitrary client-supplied `X-Forwarded-For` or JSON value. Behind a reverse proxy this may be a proxy address. Therefore switching Wi-Fi/cellular is **not guaranteed** to change the binding merely because `session_binding_enabled` is on: Work must actually observe a changed, correctly established peer context. A stable shared proxy address plus a fixed app UA is not proof of an individual physical device.

Enabling or changing a deployed security setting is not part of this cloud source change. Deployment owners must verify the actual configuration through their authorized deployment process; these notes are not approval to change a live setting.

## What cloud validation does and does not establish

- The adapted clients are the shared Expo/React Native application on iOS and Android. Separate Swift and Kotlin applications have not been adapted.
- Isolated source tests cover secure-storage deletion failure/recovery, pending invalidation, local request/socket gating, bounded logout, strict callbacks, encryption-identity retention, and incremental mock streaming/cancellation. Platform mocks cannot prove OS keychain or network behavior.
- The combined Core/Authcenter/Work integration is a local isolated acceptance run with synthetic principals and explicit binding configuration. Its exact final result is recorded by the integration owner; it is not production rollout evidence.
- A real Redis-backed deployment, multi-process behavior and production operational acceptance have **not** been completed here. Do not interpret a source test or local integration pass as Redis deployment acceptance.
- Work-specific remote logout revokes the signed grant's own server-side session family. It does not establish immediate rejection of every previously issued Core panel access JWT: existing Core panel access-token verification retains its prior lifetime/validation semantics. Do not advertise universal immediate panel JWT revocation.
- The native AuthProvider owns a non-dismissible, full-screen state notice above navigation. It remains visible over account and retained-stack pages when secure deletion fails or reload throws/is a no-op. Pending cleanup explicitly says credentials are not yet cleared and offers a coalesced retry; completed cleanup requires a full App restart. Remote confirmation/uncertainty is shown separately, without falsely claiming local deletion succeeded. Web retains its existing presentation. This is covered with the installed native-stack implementation and mocked platform views, not physical OS modal acceptance.
- No refresh-token contract is implemented. An expired/invalid native session must finish local cleanup, restart the one-shot sync runtime, and use unified login again with its retained encryption identity.
- The self-hosted iOS/Android Metro export used `https://work.example.invalid` and `invalid.example.work.fixture` as isolated, synthetic build inputs. They are not user-owned registrations, a reachable deployment, signed installation packages or release-ready app identities.

## Required Mac/device release gates

Follow the repository's packaging/release policy and the self-hosted build gate. Do not use upstream Expo ownership, OTA, app IDs, associated domains or push settings. Real owned identifiers/signing setup must be resolved separately without treating fixtures as ownership.

On **each** iOS and Android signed installation, record the actual server-observed UA for:

1. Ordinary React Native fetch to the selected Work origin.
2. Official Expo fetch, including native login and live mock streaming.
3. Native Socket.IO WebSocket connection **and reconnection**.

All six platform/transport cells must report exactly `TokenHubWorkNative/1`. Any ignored or overwritten header blocks release. Also verify Web and unrelated origins remain unchanged. A Node Socket.IO or Metro test does not waive these checks, even when binding is disabled.

Before release, verify the trusted ingress/reverse-proxy chain and record the actual IP and UA observed by native start, complete, protected HTTP/streaming and WebSocket paths. Confirm those observations are consistent and cannot be spoofed with client-forwarded headers. Do not temporarily trust arbitrary `X-Forwarded-For` to make a test pass. Only with that verified ingress behavior and the binding switch explicitly checked should real Wi-Fi/cellular or other network-change tests assert the corresponding observed-context change and re-login behavior. Proxy/network/security settings were not changed by this slice. Test fixed callback warm/cold return, cancellation/stale callbacks, real SecureStore failure/recovery, identity/history retention, expiry/revocation, confirmed and unconfirmed remote logout, retained-navigation streaming cancellation, and automatic same-bundle reload. If reload fails or is a no-op, old Work requests and new login must stay blocked and the required local cleanup/restart must remain visible. Signed packages, OS acceptance and physical-device acceptance remain pending.
