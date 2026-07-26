/**
 * The sandboxed executor host: the process an executor actually runs in.
 *
 * It is spawned by `runExecutor` under `--require sandbox/deny-network.cjs` and with a scrubbed
 * environment. By the time this module's first line executes, the network primitives and
 * `child_process` are throwers and `process.env` holds nothing but a marker — so the world this
 * process can observe is: the JSON on stdin, and the registry it imports. That is the whole
 * capability set, and it is enforced by what was done to the process, not by what this file
 * remembers to avoid.
 *
 * It reads one request, runs one executor, writes one response, and exits.
 */
import { getExecutorClass } from '../registry.js';
import { Workspace } from '../workspace.js';
import { RESPONSE_PREFIX, SandboxRequest, SandboxResponse } from './protocol.js';

function respond(response: SandboxResponse): void {
  process.stdout.write(`${RESPONSE_PREFIX}${JSON.stringify(response)}\n`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
    });
    process.stdin.on('end', () => resolve(buffer));
    process.stdin.on('error', reject);
  });
}

export async function main(): Promise<number> {
  try {
    const request = SandboxRequest.parse(JSON.parse(await readStdin()));
    const executorClass = getExecutorClass(request.executor_class);

    if (request.target.kind !== executorClass.targetKind) {
      respond({
        ok: false,
        error: {
          name: 'TargetKindMismatch',
          message: `class ${executorClass.name} takes a ${executorClass.targetKind} target, got ${request.target.kind}`,
        },
      });
      return 0;
    }

    const workspace = new Workspace(request.snapshot, executorClass.capabilities);
    const output = executorClass.run(request.commitment, {
      persona: request.persona,
      target: request.target,
      workspace,
      now: request.now,
    });

    const proposal = workspace.proposal();
    respond({ ok: true, output, proposal: { writes: proposal.writes, deletes: [...proposal.deletes] } });
    return 0;
  } catch (err) {
    respond({
      ok: false,
      error: {
        name: err instanceof Error ? err.name : 'Error',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return 0;
  }
}

// Run when executed directly (the host is always spawned, never imported by the parent).
if (process.env['SERVANDA_SANDBOX'] === '1') {
  void main().then((code) => {
    process.exitCode = code;
  });
}
