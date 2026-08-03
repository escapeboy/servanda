import { afterEach } from 'vitest';

/**
 * One macrotask yield after every test, so the worker can answer the reporter.
 *
 * The failure this cures is `[vitest-worker]: Timeout calling "onTaskUpdate"` — a run that
 * exits non-zero with every test green. It had been attributed to worker starvation four
 * separate times (see `MAX_WORKERS` in `vitest.config.ts`, which records the attempts), and
 * every attempt tuned the worker COUNT. None of them closed it, because the count is not the
 * mechanism.
 *
 * The mechanism: `onTaskUpdate` is a birpc call the worker makes and then awaits, and vitest's
 * `DEFAULT_TIMEOUT` for it is 60_000 ms — enforced by a timer INSIDE the worker. A file of
 * synchronous tests never reaches the poll phase of its event loop, so the main process's reply
 * sits unread in the IPC queue while that timer runs. The clock is therefore **cumulative over
 * the file**, not per test: eight tests of 8 s each trip it and a single test of 23 s does not.
 * That is why the file the symptom was blamed on (`bad-day.test.ts`, 48.5 s) never crossed it
 * while `vault.test.ts` (80.4 s) in the same package always did.
 *
 * `setTimeout(…, 0)` is a macrotask, which is the point — a microtask (`queueMicrotask`,
 * `await Promise.resolve()`) drains without ever reaching the poll phase and cures nothing.
 *
 * This weakens no assertion. It does not make anything faster; it lets the worker read a reply
 * that has already arrived. The cost is one timer tick per test.
 *
 * It does NOT cover a test that blocks past the timeout on its own — the yield comes after the
 * test, and by then the timer has already fired. `M-10`'s `the shipped node answers all six
 * tools with network primitives disabled` is 30 s of `execFileSync` in a single test and is the
 * one case in the tree that still needs its own answer.
 */
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});
