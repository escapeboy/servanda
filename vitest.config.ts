import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

/**
 * A CEILING on workers, never a floor.
 *
 * The first version of this was the constant 4, and it broke CI for three commits while
 * passing on every local run. On a developer machine with many cores, 4 is *below* what
 * vitest would have chosen and it relieves the starvation described on `maxWorkers` below.
 * On a small CI runner, 4 is *above* what the machine can serve, and forcing it there
 * reproduced the very failure it was meant to cure — no test failed, but workers starved
 * badly enough that the reporter RPC timed out with `Timeout calling "onTaskUpdate"` and
 * vitest exited non-zero. A constant cannot be both a cap and a safe default.
 *
 * `- 1` leaves a core for the main process, which is the one that has to answer that RPC.
 */
const MAX_WORKERS = Math.max(1, Math.min(4, availableParallelism() - 1));

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
    /**
     * Concurrency is capped because the suite is memory-bound, not CPU-bound.
     *
     * Every vault open runs Argon2id at the §9.3 minimum — m=64MiB per derivation — and the
     * scenario tests stand up several vaults each. Left unbounded, vitest starts a worker per
     * core, each holding 64MiB-plus of KDF state, and the workers starve: the run emits
     * `[vitest-worker]: Timeout calling "onTaskUpdate"` and, worse, a gate can report failure
     * for want of a scheduling slot rather than for anything wrong with the code. A federation
     * gate failed exactly once that way and could not be reproduced in isolation.
     *
     * Four workers is enough to keep the run parallel while leaving each one the memory its
     * KDF actually needs. The suite is not meaningfully slower; it is merely honest.
     *
     * Four is the ceiling, not the number — see `MAX_WORKERS` above for why that distinction
     * is load-bearing on a small runner.
     */
    maxWorkers: MAX_WORKERS,
    minWorkers: 1,
  },
});
