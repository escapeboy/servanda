import { z } from 'zod';
import { ExecutionTarget, ExecutorCommitment, ExecutorOutput } from '../executor.js';

/**
 * The wire between the host and the sandboxed executor process.
 *
 * It is JSON, in one direction each way, and it is narrow on purpose. The request carries a
 * typed commitment, an enumerated target, and the file snapshot the executor's read capability
 * already selected — nothing else crosses. There is no field for an environment, a token, a
 * remote, or a command. The response carries a title, a body, and proposed file contents.
 *
 * Because the boundary is a process boundary and the payload is data, "the executor cannot act"
 * needs no enforcement inside the executor: whatever it returns, the host is the one deciding
 * what to do with it, and the host's only option is to build a draft artifact.
 */

export const SandboxRequest = z
  .object({
    executor_class: z.string().min(1),
    commitment: ExecutorCommitment,
    target: ExecutionTarget,
    persona: z.string().regex(/^[0-9a-f]{64}$/),
    now: z.string().min(1),
    /** Workspace-relative path → contents. Pre-filtered by the class's `read` capability. */
    snapshot: z.record(z.string()),
  })
  .strict();
export type SandboxRequest = z.infer<typeof SandboxRequest>;

export const SandboxResponse = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      output: ExecutorOutput.nullable(),
      proposal: z
        .object({ writes: z.record(z.string()), deletes: z.array(z.string()) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ name: z.string(), message: z.string() }).strict(),
    })
    .strict(),
]);
export type SandboxResponse = z.infer<typeof SandboxResponse>;

/** Marks the one line on stdout that is the response, so stray output cannot be mistaken for it. */
export const RESPONSE_PREFIX = 'SERVANDA_SANDBOX_RESPONSE ';
