# Local Work runtime

The `feat/tokenhub-integration` branch keeps upstream protocol/package names and
local encrypted identity, while displaying Work (or configured display branding).
Default upstream promotional links are absent; optional public links come from the
TokenHub display configuration and are hidden when unset. Original legal notices
and licenses are preserved. Existing GitHub account linking remains available and
returns to the same relay origin, not an upstream hosted application.

With the repository's verified Node 24/pnpm dependencies, generated Prisma client
and built happy-wire package:

```sh
node scripts/local-web/build-work-runtime.mjs /absolute/work-local-runtime
```

This builds a real production-mode Expo web export fixed to the local relay at
127.0.0.1:28083 and compiles its standalone relay. Its dependency links make it a
local development artifact; do not upload it as a production release. The original
Linux-only production packager retains its platform and integrity checks.

The host service manager can run `node dist/standalone.mjs serve` with HOST set to
127.0.0.1, PORT 28083, HAPPY_STATIC_DIR pointing at webapp, and persistent DATA_DIR /
PGLITE_DIR outside this artifact. Use an existing matching HANDY_MASTER_SECRET;
this builder never generates credentials or starts services. Apply schema
migrations explicitly before the first service start. There are no bundled model,
payment, provider or administrator credentials.

Regenerate code-native Work icon assets with `node scripts/work/build-brand-assets.mjs`.
This does not alter the original upstream asset files or license statements.
