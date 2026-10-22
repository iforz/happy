import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
 test: { environment: 'node', include: ['sources/app/tokenhub/*.spec.ts', 'sources/app/api/routes/tokenHubRoutes.spec.ts'] },
 resolve: { alias: {
  '@': fileURLToPath(new URL('./sources', import.meta.url)),
  '@slopus/happy-wire': fileURLToPath(new URL('../happy-wire/src/tokenhub/pageConfig.ts', import.meta.url)),
 } },
});
