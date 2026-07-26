/**
 * Run the precision harness against the locally-installed `claude` CLI.
 *
 * This is NOT the conformance path — see the note at the top of src/claude-cli.ts. The API client
 * is tool-less structurally; this one is tool-less by configuration and then verifies it, refusing
 * any run that touched a tool. It exists so the precision report can be produced from a real model
 * over real transcripts without an API key.
 *
 *   node packages/extraction/scripts/precision-via-claude-cli.mjs [--envelopes N] [--out PATH]
 */
import { writeFileSync } from 'node:fs';
import { runHarness } from '../dist/harness/run.js';
import { createClaudeCliModelClient } from '../dist/claude-cli.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const maxEnvelopes = Number(arg('envelopes', '150'));
const out = arg('out', 'precision-report.md');
const batchSize = Number(arg('batch', '12'));

const model = createClaudeCliModelClient({ timeoutMs: 240_000 });

console.log(`running extraction over up to ${maxEnvelopes} envelopes via ${model.id}`);
console.log('every batch is one CLI invocation; a run that touches any tool is refused\n');

let done = 0;
const counting = {
  id: model.id,
  async complete(request) {
    const started = Date.now();
    const res = await model.complete(request);
    done++;
    console.log(`  batch ${done} — ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return res;
  },
};

const result = await runHarness({
  modelClient: counting,
  modelClientMode: 'live',
  modelClientNote: '— live model via the local `claude` CLI (tool-less by configuration, verified per run)',
  maxEnvelopes,
  batchSize,
  days: 30,
});

writeFileSync(out, result.markdown);

console.log('');
console.log(`mode:                 ${result.mode}`);
console.log(`transcripts scanned:  ${result.scan.transcriptsScanned}`);
console.log(`envelopes produced:   ${result.scan.envelopes}`);
console.log(`batches:              ${done}`);
console.log(`batches discarded:    ${result.rejectedBatches.length}`);
console.log(`rows extracted:       ${result.rows.length}`);
console.log(`report:               ${out}`);
