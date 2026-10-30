import { defineConfig } from 'vitest/config';

// Standalone rather than merged with vite.config.ts: the app's config carries
// the Monaco alias, vendor chunking and dev proxy, none of which a unit test
// wants.
export default defineConfig({
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        // i18next is a process-global: without initialising it here every
        // rendered component returns raw keys and every string assertion fails.
        setupFiles: ['./src/test/i18n-setup.ts'],
        // Nothing here should reach the network or a cluster: these are unit
        // tests over pure helpers and hooks. Cluster-facing coverage is the
        // e2e_tests/ suite's job.
        restoreMocks: true,
    },
});
