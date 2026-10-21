# ai.iforz.cn deployment preparation

Templates only: nothing here creates credentials, installs services, changes
firewalls, requests certificates, or publishes the site automatically.

1. Use Node.js >=20 and pnpm 10.11.0. Install with `pnpm install --frozen-lockfile`.
2. Build the actual web client (never a harness/debug-auth bundle):

   ```sh
   EXPO_NO_DOTENV=1 EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 \
   EXPO_PUBLIC_DISABLE_ANALYTICS=1 EXPO_PUBLIC_SELF_HOSTED=1 \
   EXPO_PUBLIC_HAPPY_SERVER_URL=https://ai.iforz.cn \
   pnpm --filter happy-app exec expo export --platform web --max-workers 2
   ```

3. Review `ai.iforz.cn.env.example`; supply a separately approved production
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
