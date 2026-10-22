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

Focused tests cover URL/SSRF boundaries, issuer/audience/nonce/expiry, state
consumption, key proof, replay, cancellation and identity mismatch. They are not
yet verified: the first test-runner launch failed because @vitest/utils had not
arrived during the still-running locked dependency installation. Prisma
regeneration, migration validation, full typechecks, focused tests, production
web export and runtime smoke checks remain required. Mock checks are not proof
of production account federation.

The only bootstrap provider destination is TOKENHUB_URL, an explicitly trusted
HTTPS origin. Do not accept that value from a URL query or provider response.
HAPPY_PUBLIC_ORIGIN fixes the self-host callback origin. TOKENHUB_SSO_ENABLED
remains off unless the deployment has explicitly authorized the client and
persistent account binding. Never commit credentials or production state.

This development branch is separate from upstream main. Publishing native/OTA
or CLI packages is outside this work.
