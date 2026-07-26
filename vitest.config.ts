import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    globals: false,
    testTimeout: 30_000,
    /**
     * Setup is expensive here on purpose.
     *
     * Opening a vault derives a key with Argon2id at the §9.3 minimum (m=64MiB, t=3, p=1),
     * which costs roughly 1.2 s — that slowness IS the security property, and tuning it down
     * for the suite would mean testing a weaker vault than the one that ships. The team and
     * cross-org scenarios stand up three vaults apiece and drive git alongside them, so their
     * `beforeAll` runs ~15 s alone and longer when the whole suite competes for cores.
     *
     * So the budget is generous while every individual assertion stays on the 30 s
     * `testTimeout`: a slow *setup* is expected, a slow *assertion* still means something is
     * wrong.
     */
    hookTimeout: 180_000,
  },
});
