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
 * `- 2` leaves a core for the main process, which is the one that has to answer that RPC — and it
 * is `- 2` rather than `- 1` because `- 1` does not. On a 4-core GitHub runner `min(3, 4 - 1)` is
 * 3 workers plus a main process on 4 cores: the main thread shares a core with an Argon2id worker
 * and the reporter RPC times out. The M-suite failed exactly that way with **438 passed and zero
 * failures**, which is the whole problem — the run reports red for a scheduling reason.
 *
 * `- 2` gives 2 workers on a 4-core runner and still 3 on a developer machine, so the cap is what
 * bounds the fast case and the subtraction is what protects the small one. Those are two different
 * jobs and one constant cannot do both, which is the same lesson the paragraph above records
 * about the original hardcoded 4.
 */
const MAX_WORKERS = Math.max(1, Math.min(3, availableParallelism() - 2));

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    globals: false,
    testTimeout: 30_000,
    /** See the file itself: it cures the `onTaskUpdate` timeout the numbers below never could. */
    setupFiles: ['./vitest.setup.ts'],
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
     * Three workers is enough to keep the run parallel while leaving each one the memory its
     * KDF actually needs. Three is the ceiling, not the number — see `MAX_WORKERS` above for why
     * that distinction is load-bearing on a small runner.
     *
     * **It was four until the suite grew past it.** Adversarial scenario tests roughly tripled the
     * run (71 s → 200 s) and with it the Argon2id work in flight, and four workers began emitting
     * `Timeout calling "onTaskUpdate"` on about one run in three — and, worse, reporting FAILED
     * TESTS that pass in isolation. A suite that invents a red result is worse than a slow one,
     * because the only defence against it is to stop believing red.
     *
     * Measured before changing it, six runs at four workers against three at three: the flakes
     * vanished AND the wall clock dropped from ~200 s to ~150 s. The fourth worker was not buying
     * parallelism; it was paying for contention. That is the whole argument for the number.
     */
    maxWorkers: MAX_WORKERS,
    minWorkers: 1,
  },
});
