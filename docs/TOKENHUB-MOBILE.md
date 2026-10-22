# TokenHub mobile integration

## Scope and status

This slice adapts the existing **Expo / React Native `happy-app`** for iOS and Android. It does not port TokenHub to the separate Swift `happy-ios` or Kotlin `happy-android` clients. Those directories remain unchanged.

Cloud validation is source-level and isolated: it does not prove an installed application, an actual device keychain, an OS browser callback, or a physical WebSocket stack works. The initial iOS and Android Metro JavaScript exports succeeded. Signed packages, device installation, OS callback acceptance, and real-device acceptance remain separate work.

The native flow uses the independent `happy-native` audience. It requires Core metadata `native_audience: happy-native` and `native_binding_method: ip-ua-sha256-128-v1`. Work authorization verification must be enabled, or native login fails closed. Web keeps `happy-web` unchanged. Full cross-service acceptance must be recorded separately; mocked grant-verifier tests are not proof of real Core binding.

At native start, Work captures the actual framework peer IP (canonical IPv4 / compressed IPv6) and exact application UA `TokenHubWorkNative/1`; it stores `SHA256(ip + "\n" + ua)[0:16]` as lowercase 32-hex. Start/complete must observe the same context. The authorization request includes only `native_binding_hash`; the server exchange includes that stored hash plus stored `native_client_ip`. Neither comes from client JSON or forwarded header inputs. Core checks the original browser session under its original binding before issuing the native Work grant. Network changes invalidate the session and require login again.

The app uses its own transparent UA, not a browser impersonation. Native global fetch, official Expo fetch and Socket.IO extraHeaders set it only for the exactly selected Work URL origin. Web and third-party requests are unchanged. This retains IP+UA semantics; it is not hardware/device-key binding or per-request private-key proof.

Installed official source confirms header forwarding at Expo iOS `ExpoURLSessionTask.swift:36–38`, Expo Android `NativeRequest.kt:37–51`, React Native `WebSocket.js:148`, iOS `RCTWebSocketModule.mm:83–91`, and Android `WebSocketModule.kt:101–115`. Isolated tests execute actual loopback HTTP/Socket.IO requests and the installed Engine.IO React Native constructor branch. These do not replace OS/device transport validation.

## Login boundaries

- Web retains its original exact Origin check and secure cookie-bound start/complete flow.
- Native uses separate `/v1/tokenhub/native/start`, `/complete`, and `/handoff` endpoints. Only those exact POST routes are public bootstrap endpoints.
- The authorization service redirects only to the configured HTTPS `/tokenhub/callback`. Native callbacks are bridged only for a server-side, live native transaction, to the single constant `happy://tokenhub/callback`.
- No caller-selectable redirect is accepted. Callback parameters contain a short-lived code and state, never an authorization token, encryption secret, PKCE verifier, or completion binding.
- Completion requires the high-entropy transaction binding kept on the device, and a signature from the existing Happy encryption identity. State and the callback URL alone are insufficient. PKCE is retained on the server; only Happy's existing signer issues a Happy session.
- The selected server must be HTTPS. Native does not reuse browser cookies. The existing encryption identity is reused rather than replaced, and a conflicting account binding returns recovery-required.

## Device lifecycle

- `login.native.ts` uses Expo's system authentication browser, with a fixed return URI. `callback.native.tsx` handles cold starts. Duplicate warm/cold completion paths share one exchange/save operation.
- Native pending identity, one-time transaction, and session metadata use `expo-secure-store`, with device-only unlocked accessibility. Final Happy credentials continue to use the application's existing SecureStore-backed `TokenStorage`.
- Cancellation consumes or expires the pending server transaction. Logout invalidates in-flight native completion and clears active authorization state. The local encryption identity is preserved separately for reauthentication and existing encrypted history.
- Expiry uses the server-returned actual grant deadline and a foreground check of `/v1/tokenhub/native/session`. A failed network check never extends the stored deadline.
- Invalidation first removes authorization from memory/UI, disconnects the socket, and locally blocks selected-Work HTTP and new socket connections. If SecureStore credential deletion fails, session monitoring metadata is retained, the watcher remembers the pending invalidation even if a later authority response would be 200, and foreground/explicit cleanup retry can finish deletion. The screen says credentials are not yet cleared, does not claim successful local logout, and does not auto-reload until cleanup succeeds. Repeated logout retries local cleanup without repeating or relabeling the first bounded remote outcome.
- The existing sync engine is one-shot per JS runtime. After expiry/logout cleanup succeeds, native runtime reload is requested. If Expo reload is disabled or fails, the welcome screen visibly requires completely closing/reopening the App, and all new login/duplicate callback paths are blocked before consuming another grant. Automatic runtime reload must be verified in the signed device build.
- There is **no refresh-token contract implemented in this slice**. The UI explicitly requests unified login again after expiry. No replacement authority token is fabricated locally.
- Only credentials containing the existing TokenHub grant extras are routed to remote family logout (client parsing is UI routing, never authorization). Legacy Happy signout keeps its local-only semantics.
- Logout calls `POST /v1/tokenhub/logout` with a Happy bearer token and an empty JSON body. It reports remote revocation only for `{ "revoked": true }`. Remote failure still permits local logout and leaves an explicit “remote revocation unconfirmed” notice. Revocation is bounded to 2.2 seconds; push-token cleanup is a separate single bounded attempt, not indefinite backoff.

## Mock page

`/tokenhub/work-mock` now uses the same React Native screen on Web, iOS and Android. Native selects official `expo/fetch` for incremental ReadableStream and cancellation support. It does not buffer a complete response and present it as streaming.

Only the isolated non-billable Mock gateway is used. Existing provider selection, real models, paid APIs and balances are unchanged. Focus loss, unmount, identity changes and explicit cancellation abort in-flight model/stream requests. Returning to the screen resets its stale output and reloads the model catalog.

## Required device acceptance

Use the repository's release/build policy when preparing installation packages. No credentials or signing material belong in this document or the source tree.

1. On both iOS and Android, authenticate from a fresh install and from an existing encrypted identity. Verify the same history remains readable.
2. Verify the real browser → App transport-binding contract, plus subsequent normal HTTP and Socket.IO traffic, with actual device request context.
3. Test successful warm return, app-killed cold return, cancel, expired transaction, duplicate/stale callback, and a callback intercepted without the completion binding.
4. Check the device stores transaction material and authorization credentials only in its secure storage; no token/identity secret should appear in callback URLs or logs.
5. Let the grant expire and revoke it remotely. Confirm local authorization disappears and unified login can resume with the same encryption identity. Do not describe this as refresh.
6. Simulate locked/unavailable SecureStore on credential deletion, then foreground after recovery. Verify immediate UI/HTTP/WS stop, retained session metadata, no reload before deletion succeeds, retry cleanup, and retained encryption identity. Repeat with a revoked session whose next probe would be 200, duplicate logout, failed reload, and a no-op reload.
7. Test confirmed remote logout and offline/timeout logout. Confirm the latter explicitly says remote revocation is unconfirmed.
8. In Mock, observe multiple chunks before completion, cancel midway, push another route while retaining the screen, then return and restart. Repeat with a background/foreground transition and revoked auth.

Isolated unit/component tests and Metro exports are necessary preparation, not a substitute for these device checks.

## Installed runtime and upstream implementation references

Cloud validation used `expo` **55.0.8**, `react-native` **0.83.1**, `socket.io-client` **4.8.3**, `engine.io-client` **6.6.4**, `expo-secure-store` **55.0.9**, `expo-web-browser` **55.0.10**, and `expo-updates` **55.0.15**. No dependency was upgraded for this slice.

- [Expo SDK 55 fetch/stream API](https://docs.expo.dev/versions/v55.0.0/sdk/expo/#expofetch-api). Native source: [iOS request headers](https://raw.githubusercontent.com/expo/expo/sdk-55/packages/expo/ios/Fetch/ExpoURLSessionTask.swift) and [Android request headers](https://raw.githubusercontent.com/expo/expo/sdk-55/packages/expo/android/src/main/java/expo/modules/fetch/NativeRequest.kt). These Expo links are the official SDK 55 branch, not a claim that the branch is immutable; installed package files were inspected independently.
- React Native 0.83.1 ordinary fetch/XHR source: [iOS RCTNetworking](https://raw.githubusercontent.com/facebook/react-native/v0.83.1/packages/react-native/Libraries/Network/RCTNetworking.mm) and [Android NetworkingModule](https://raw.githubusercontent.com/facebook/react-native/v0.83.1/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/network/NetworkingModule.kt). Installed iOS lines 328–334 apply supplied headers; Android lines 428–441 apply them, and 1025–1027 add a default UA only if none was supplied.
- [React Native 0.83.1 WebSocket constructor](https://raw.githubusercontent.com/facebook/react-native/v0.83.1/packages/react-native/Libraries/WebSocket/WebSocket.js) passes `options.headers` to the native module. Installed native implementations inspected: `React/CoreModules/RCTWebSocketModule.mm:83–91` and `ReactAndroid/src/main/java/com/facebook/react/modules/websocket/WebSocketModule.kt:101–115`.
- [Socket.IO extraHeaders documentation](https://socket.io/docs/v4/client-options/#extraheaders) explicitly supports React Native/Node, while browser WebSocket-only clients cannot set those headers. Our Web adapter therefore does not set this UA.
- [Expo reloadAppAsync](https://docs.expo.dev/versions/v55.0.0/sdk/expo/#reloadappasyncreason) reloads the currently running bundle, including debug/release builds, rather than applying a downloaded OTA update. The implementation used here is this function, **not `Updates.reloadAsync()`**. Installed source: `expo-modules-core/src/reload.ts:1–10`, iOS `Core/AppContext.swift:583–590`, and Android `defaultmodules/CoreModule.kt:92–96`. Failure or a no-op keeps the restart requirement visible and login blocked.

### Mandatory six-cell device transport gate

For **each iOS and Android installation build**, capture the actual server-observed UA independently for all three paths:

1. Ordinary React Native global fetch to the selected Work origin.
2. Official `expo/fetch`, including native login and live Mock streaming.
3. Socket.IO's native WebSocket handshake and a reconnection.

All six platform/transport combinations must observe exactly `TokenHubWorkNative/1`; the same login must survive all three transports without a binding mismatch. Also confirm unrelated origins and Web retain their own UA, and a real network change is rejected with an explicit re-login requirement. **If any native transport ignores or overwrites the header, this build must not be released.** A passing Node transport test or Metro export cannot waive this gate.

## Mac packaging gate and scope

Self-hosted packaging must follow [the dedicated mobile build gate](TOKENHUB-MOBILE-BUILD.md). Do not publish using upstream OTA, Expo ownership/project, bundle identifiers, associated domains or push settings. Build-time fixture IDs are not real app registrations and must not be represented as deployable ownership.

The Mac handoff must separately verify automatic same-bundle reload after expiry/logout, the six transport cells, fixed callback warm/cold entry and secure-store persistence. Signed packages and real-device acceptance are still pending. Separate Swift/Kotlin applications remain outside this Expo integration. No application registration, account changes, signing credentials, paid services or distribution has been performed by this cloud slice.
