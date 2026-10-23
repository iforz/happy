# Work deployment preparation (work.mzyai.com)

Templates only: nothing here creates credentials, installs services, changes
firewalls, requests certificates, or publishes the site automatically.

1. Use Node.js 24 and pnpm 10.11.0. Install with `pnpm install --frozen-lockfile`.
2. Build the actual web client (never a harness/debug-auth bundle):

   ```sh
   APP_ENV=production EXPO_NO_DOTENV=1 EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 \
   EXPO_PUBLIC_DISABLE_ANALYTICS=1 EXPO_PUBLIC_SELF_HOSTED=1 HAPPY_BUILD_TARGET=web \
   EXPO_PUBLIC_HAPPY_SERVER_URL=https://work.mzyai.com \
   pnpm --filter happy-app exec expo export --platform web --max-workers 2
   ```

   Preferred repeatable command: `pnpm web:build:selfhost`. This pins production
   branding, the approved relay URL and analytics settings in an isolated build
   environment. The normal `web:local` command intentionally remains development.

3. Review `ai.iforz.cn.env.example` as a legacy template and replace its public origin with `https://work.mzyai.com`; supply a separately approved production
   master secret outside Git. The placeholder and the local-development fixture
   are not acceptable production secrets. Keep this secret stable across restarts
   and back it up securely with the database; changing it disrupts authentication.
4. Review the systemd example against the server's actual Node binary, release
   directory, dedicated service user and writable data directory. Migrations run
   on the isolated new database before service start. Do not point it at existing
   unrelated data. PGlite is a single-process database: run one relay instance.
5. Review existing Nginx routes, DNS, HTTPS certificate and public-access approval
   before installing the proxy. Proxy the whole origin, not `/api`: the client
   expects `/v1`, `/v3`, `/v1/updates`, `/files` and SPA routes at root.
6. Check the loopback `/health`, then HTTPS page/deep links, WebSocket upgrade and
   unauthorized API rejection. Confirm 3005 is not publicly bound. Do not expose
   Metro, debugging routes or any agent execution API.

The pinned self-host build ignores previously saved relay overrides, uses the
same relay for voice, disables remote log forwarding, and disables analytics.
No model provider credential is embedded. An empty/no-machine UI is expected
until a separately authorized agent runtime is paired. This stack alone does
not provide AI execution and does not configure GitHub Actions deployment.

For updates, retain the approved secret and state directory, back up state,
build a new release directory, smoke-test it before switching the proxy/service,
and preserve the previous release for rollback. Never replace a server's existing
applications or global Nginx configuration wholesale.

## Frontend-only updates with the current static server

The relay registers `@fastify/static` with `wildcard: false`. Asset routes are
captured at process startup. Uploading newly hashed JavaScript files does NOT
make those files available to the running process: an unregistered asset URL
can fall through to the SPA handler and return HTML with HTTP 200. This causes
`Unexpected token <` in the browser. HTTP 200 alone is not an asset check.

Use this sequence for a frontend-only update:

1. Verify the archive checksum, stage the export and back up the active index.
   Keep the old index active and retain existing hashed assets for open tabs.
2. Copy new assets into the active `webapp` tree WITHOUT replacing `index.html`.
   Do not change the environment, secret, database, relay or service config.
3. Perform one authorized, controlled Happy-service restart to register both
   old and new asset paths. Wait for service health and `/health`. Do not
   restart unrelated applications or the database.
4. Before switching the index, request new JavaScript/CSS asset URLs directly,
   including entry scripts referenced by the staged index. Verify expected MIME
   types and bodies, not just HTTP 200. JavaScript must not return `text/html`,
   `<!DOCTYPE`, or an HTML app shell. Also check an old asset, through both
   loopback and public HTTPS.
5. Only after these checks pass, atomically replace the registered `index.html`
   path. Verify the real browser page, console, assets, deep links, `/health`
   and the `/v1/updates` WebSocket endpoint.
6. If checks fail, restore the previous index atomically and verify the old
   page/assets and service health. Preserve both asset sets while diagnosing;
   do not repeatedly restart or expand deployment scope.

This restart is required for this serving mode even for frontend-only changes.
Changing runtime routing needs separate review. The focused regression exercises
this static-plugin behavior and guards the production configuration:

```sh
pnpm --filter happy-server exec vitest run sources/app/api/staticAssetDeployment.spec.ts
```

## Small production artifact (build off-server)

For a memory-constrained server, do not install the monorepo or run Metro/Expo
there. Complete the install, Prisma generation, `happy-wire` build, and the clean
production web export above on a Linux x64 build machine using Node.js 24.
Then package only the relay's production dependencies and static web client:

```sh
PNPM_BIN=/absolute/path/to/pnpm-10.11.0 \
node scripts/local-web/package-production.mjs ../happy-web-production
```

`PNPM_BIN` also accepts an absolute pnpm `.cjs`/`.mjs` entrypoint. `WEB_DIST`
optionally selects an already-built production Expo export. The output must not
exist and must be outside the checkout. Packaging runs offline and fails if the
local dependency store, generated Prisma Debian/OpenSSL 3 engine, or native
sharp dependency is incomplete. It retains partial output on failure rather
than deleting directories. A successful package is not a runtime smoke test.
Never select a development/harness bundle: those can contain local credentials.

The artifact includes `dist/standalone.mjs`, `webapp/`, `prisma/`, and a portable
`node_modules/` tree, including generated `.prisma/client`, PGlite WASM/data,
Happy wire schemas, and sharp/libvips. Preserve the complete tree and symlinks
when transferring it. There is no target-side pnpm install or Bun requirement.

For this artifact layout, adapt the examples rather than using their source-tree
paths: set `WorkingDirectory=/opt/happy-web`,
`ExecStartPre=/usr/bin/node /opt/happy-web/dist/standalone.mjs migrate`,
`ExecStart=/usr/bin/node /opt/happy-web/dist/standalone.mjs serve`, and
`HAPPY_STATIC_DIR=/opt/happy-web/webapp`. Keep the approved environment/secret and
writable database outside the release directory. Start only one relay process.

PGlite and native image processing consume memory outside V8's JavaScript heap.
A heap-size flag is not an RSS limit. With only about 478 MB available and swap
already full, do not assume this stack is safe: measure cold migrations, idle
serving, and representative uploads on the build machine before activating it.
The API accepts bodies up to 100 MB, so even a successful idle boot does not
demonstrate adequate load headroom. Free capacity or reduce the deployment scope
before a memory measurement shows that the service would crowd out existing apps.

## Resource check and optional PostgreSQL plan

Do not start PGlite on an already memory-constrained server. A source-runtime
smoke test in the build environment peaked around 829–949 MiB RSS and settled
near 505 MiB; migrations also peaked above 500 MiB. Compiled-artifact results
must be measured independently. Idle health is not a load test.

If a separately approved dedicated PostgreSQL database and restricted account
are available, configure `DB_PROVIDER=postgres` and supply `DATABASE_URL`
outside Git. The existing `standalone.mjs migrate` command always migrates
PGlite, even in that environment, so it must NOT be used as the PostgreSQL
migration step. Instead, from the packaged artifact with the approved database
configuration supplied by the service manager:

```sh
node node_modules/prisma/build/index.js migrate deploy --schema=prisma/schema.prisma
node dist/standalone.mjs serve
```

Change the service's migration step only after database permission, credentials,
backups and resource budget are verified. Do not reuse unrelated applications'
databases, read their credentials, or create roles/grants without authorization.

The approved Work production origin is `https://work.mzyai.com`. The isolated
production build pins this origin even if an ambient relay variable is present.
Legacy `ai.iforz.cn` file names are templates only; do not deploy them without
reviewing origin, callback allowlists, proxy client context and existing state.
`build-work-runtime.mjs` is local-only and cannot replace the Linux x64
`package-production.mjs` artifact.

## Explicit production domain and loopback reverse proxy

Set `HAPPY_PRODUCTION_ORIGIN=https://work.iforz.cn` when invoking
`pnpm web:build:selfhost`. This exact public HTTPS origin overrides the default
`https://work.mzyai.com`; ambient `EXPO_PUBLIC_HAPPY_SERVER_URL` is ignored.
Paths, credentials, IP literals and trailing slash are rejected. The runtime
`HAPPY_PUBLIC_ORIGIN`, `PUBLIC_URL` and configured SSO callback must match the
chosen origin. Changing domain does not authorize replacing existing data or
regenerating its matching `HANDY_MASTER_SECRET`.

For a reviewed single local Nginx hop, bind Work to loopback and explicitly set
`TOKENHUB_TRUST_LOOPBACK_PROXY=true`. Nginx must overwrite `X-Real-IP` with
`$remote_addr` for both HTTP and WebSocket requests. Work only reads this one
validated address when the actual TCP peer is literal loopback; external peers
cannot choose their IP using headers. Missing, multiple or malformed addresses
fail closed. `X-Forwarded-For` and `X-Client-IP` never select Work identity.
Keep this option off for direct local access. Do not enable blanket Fastify proxy
trust. Core must resolve the same browser IP and User-Agent when authorizing the
original login; PKCE exchange preserves that original Core binding.
