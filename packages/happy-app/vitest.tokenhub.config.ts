import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Test the shared display contract directly; production still resolves the built workspace package.
export default defineConfig({
    // Keep navigation's ESM hooks in the renderer's React module graph.
    test: { server: { deps: { inline: [/@react-navigation/] } }, environment: 'node', include: ['sources/integrations/tokenhub/*.test.ts'] },
    resolve: { alias: {
        // Pin both transformed navigation hooks and renderer imports to the same installation.
        'react': fileURLToPath(new URL('../../node_modules/react', import.meta.url)),
        '@': fileURLToPath(new URL('./sources', import.meta.url)),
        '@slopus/happy-wire': fileURLToPath(new URL('../happy-wire/src/tokenhub/pageConfig.ts', import.meta.url)),
    } },
});
