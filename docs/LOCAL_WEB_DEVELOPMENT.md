# Local web development

This runs the existing Happy Expo web application and its real relay backend.
It is not a mockup and does not require the desktop app just to render the UI.

## Install and start

Requirements: Node.js 20 or newer, pnpm 10.11.0, Git.

```sh
pnpm install --frozen-lockfile
pnpm test:web-local
pnpm web:local
```

- Web: http://localhost:8081
- Relay: http://127.0.0.1:3005/health
- Both listeners are local only; no deployment or tunnel is started.
- Ctrl+C stops both processes. Occupied ports cause a clear failure; the launcher
  never kills an existing service.
- Optional unprivileged port overrides: `HAPPY_LOCAL_WEB_PORT` and
  `HAPPY_LOCAL_SERVER_PORT`.

The launcher migrates an isolated PGlite database and stores disposable data in
`.happy-web-local/` (ignored by Git). Docker, PostgreSQL, Redis and S3 are not
required. Its subprocess environment does not inherit provider credentials,
GitHub credentials, database URLs, or remote-storage settings. Expo dotenv and
analytics are disabled. The development master secret is a public fixture, not
a production credential: never expose these services or use real personal data.

Use a fresh private browser profile for smoke testing. The local launcher pins
the relay URL, ignores saved remote-server preferences, and disables remote log
forwarding. Voice requests also stay on the pinned relay. Do not sign in to real
provider accounts, import real recovery keys, or enable voice during this local
baseline validation.

## What is and is not running

The web client and relay handle the UI and encrypted session synchronization.
They do not run Claude, Codex, Gemini, or other model inference themselves.
Actual task execution requires an independently configured and authenticated
Happy CLI daemon or Happy Agent runtime. No such provider connection is created
by this launcher, and successful UI startup is not an end-to-end AI task test.

Provider/model display is implemented in:

- `packages/happy-app/sources/components/modelModeOptions.ts`
- `packages/happy-app/sources/sync/rig.ts`
- `packages/happy-app/sources/sync/agentDefaults.ts`

The UI supports more than one model provider; provider capabilities and available
models depend on the attached runtime. Do not put model API secrets into Expo's
`EXPO_PUBLIC_*` variables, which are shipped to the browser.

## Checks

```sh
pnpm test:web-local
pnpm --filter happy-app typecheck
pnpm --filter happy-app exec vitest run sources/components/modelModeOptions.test.ts sources/sync/rig.test.ts
```

A production static web export is a separate check from development startup.
Do not publish development bundles or the local relay. Hosting, HTTPS, private
credentials and runtime connectivity require their own deployment configuration.
