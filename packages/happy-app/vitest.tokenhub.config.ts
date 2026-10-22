import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Test the shared display contract directly; production still resolves the built workspace package.
export default defineConfig({
    test: { environment: 'node', include: ['sources/integrations/tokenhub/*.test.ts'] },
    resolve: { alias: {
        '@': fileURLToPath(new URL('./sources', import.meta.url)),
        '@slopus/happy-wire': fileURLToPath(new URL('../happy-wire/src/tokenhub/pageConfig.ts', import.meta.url)),
    } },
});
