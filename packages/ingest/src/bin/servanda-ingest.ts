#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAnthropicModelClient, createClaudeCliModelClient } from '@servanda/extraction';
import { openNode, ServandaNode } from '@servanda/node';
import { runIngest } from '../run.js';

/**
 * Carry what you told your agent into the queue you confirm from.
 *
 * One shot: it reads the log to the end, queues what it found, saves how far it got, and exits.
 * Run it when you want to, or from cron or launchd if you decide you want that — the decision to
 * have a process continuously reading everything you type at an agent is yours to make
 * explicitly, and a command you invoke is the shape that leaves it yours.
 *
 * Everything is reported on stdout in whole sentences, including the boring outcome. "Nothing new"
 * has to be distinguishable from "it did not run", or a person cannot tell a working setup from a
 * broken one — which is the state the whole §3 path was in until this existed.
 */
type Env = Record<string, string | undefined>;

class IngestError extends Error {}

function fail(message: string): never {
  throw new IngestError(message);
}

export function logPathFrom(env: Env): string {
  const explicit = env['SERVANDA_ENVELOPE_LOG'];
  if (explicit !== undefined && explicit !== '') return explicit;
  // The same default the hook's own documentation gives. If the two ever disagree, a person
  // registers the hook, runs this, and is told there is nothing to read — while the file sits
  // full a directory away.
  return join(homedir(), '.servanda-envelopes.ndjson');
}

export async function main(env: Env = process.env): Promise<number> {
  const opened = openNode(env);
  const node = new ServandaNode({
    vault: opened.vault,
    localStore: opened.localStore,
    activePersona: opened.activePersona,
  });
  const logPath = logPathFrom(env);


  const { model, posture } = chooseModel(env);
  const report = await runIngest({
    node,
    local: opened.localStore,
    persona: opened.activePersona,
    logPath,
    model,
  });

  const out: string[] = [posture];
  if (report.logMissing) {
    // Not an error. A fresh install has no log until the hook fires for the first time, and
    // treating that as a failure would teach people to ignore the failure.
    out.push(`No capture log at ${logPath} yet.`);
    out.push('Nothing has been captured, so there is nothing to read. Register the hook first.');
  } else if (report.queued === 0 && report.envelopesIngested === 0) {
    out.push(`Nothing new in ${logPath}.`);
    out.push(`${report.alreadyIngested} entries had already been read.`);
  } else {
    out.push(`Read ${report.envelopesIngested} new entries from ${logPath}.`);
    out.push(
      report.queued === 1
        ? '1 promise is waiting for you to confirm it.'
        : `${report.queued} promises are waiting for you to confirm them.`,
    );
    if (report.alreadyIngested > 0) out.push(`${report.alreadyIngested} had already been read.`);
  }

  // Every one of these is a thing a person would otherwise experience as "it just does not work",
  // so each gets a sentence rather than a silent zero.
  if (report.deferred > 0) {
    out.push(
      `${report.deferred} entries could not be read this time and were left for the next run. ` +
        'If that number stops moving, the same entries are failing every time.',
    );
  }
  if (report.rejectedBatches > 0) {
    out.push(`${report.rejectedBatches} batches came back unusable and were not queued.`);
  }
  if (report.incomplete) {
    out.push(
      `Stopped after ${report.rounds} rounds with the log unfinished. Run it again to continue.`,
    );
  }
  process.stdout.write(`${out.join('\n')}\n`);
  return report.incomplete ? 1 : 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      if (err instanceof IngestError) {
        process.stderr.write(`servanda-ingest: ${err.message}\n`);
        process.exit(2);
      }
      throw err;
    });
}

/**
 * Which model reads your words, and how tool-less that reading actually is.
 *
 * §3.4 / M-6 requires extraction to run with NO tool access, and the two backends satisfy it
 * differently — which is why the choice is reported rather than made silently.
 *
 * The API client is tool-less **structurally**: `ModelRequest` has no field in which a tool could
 * be named, so there is nothing to disable and nothing to get wrong.
 *
 * The CLI is an agent, and its default posture is the opposite — it inherits the environment,
 * including every MCP server configured. `claude-cli.ts` measured that rather than assuming it:
 * with built-in tools disallowed but MCP left alone, the model was handed `serena.read_file` and
 * `context-mode.ctx_execute_file` and ATTEMPTED BOTH in response to an instruction embedded in
 * its input. Only the permission layer stopped it. So that backend strips MCP, disallows every
 * built-in, and then VERIFIES the outcome, failing loudly rather than trusting the flags.
 *
 * Configurationally tool-less plus verification is weaker than structurally tool-less, and the
 * difference is exactly what an implementer would want to know. It is fine for reading your own
 * register; `claude-cli.ts` says plainly it is not the path a conformance claim rests on.
 *
 * The CLI comes first because it costs nothing and uses the sign-in somebody already has. A key,
 * when present, means they asked for the stronger posture and gets it.
 */
export function chooseModel(env: Env): { model: ReturnType<typeof createClaudeCliModelClient>; posture: string } {
  const key = env['ANTHROPIC_API_KEY'];
  if (key !== undefined && key !== '') {
    return {
      model: createAnthropicModelClient(),
      posture: 'Reading with the API. It is tool-less by construction: the request has no field a tool could go in.',
    };
  }
  return {
    model: createClaudeCliModelClient(),
    posture:
      'Reading with the `claude` command you already sign in to — no API key, no cost.\n' +
      'It runs with MCP stripped and every built-in tool disallowed, and the result is checked:\n' +
      'a run that touched a tool is failed rather than returned. Set ANTHROPIC_API_KEY to use the\n' +
      'API instead, which cannot be handed a tool at all.',
  };
}
