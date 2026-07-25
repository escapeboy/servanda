#!/usr/bin/env bash
# Constitution in code: every M-x in §8 must have a named test.
#
# This gate proves COVERAGE, not correctness — that no MUST has quietly gone untested.
# The tests themselves prove the behaviour. A MUST with no test is a rule nothing enforces.
set -euo pipefail

cd "$(dirname "$0")/.."

node --input-type=module -e '
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const IDS = Array.from({ length: 16 }, (_, i) => `M-${i + 1}`);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const files = walk("packages");
if (files.length === 0) {
  console.error("FAIL: no test files found under packages/");
  process.exit(1);
}

// Word-boundary match so "M-1" never matches inside "M-16".
const found = new Map(IDS.map((id) => [id, []]));
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const id of IDS) {
    if (new RegExp(`\\b${id}\\b`).test(text) || new RegExp(`\\b${id.replace("-", "-0?")}\\b`).test(f)) {
      found.get(id).push(f);
    }
  }
}

let missing = 0;
for (const id of IDS) {
  const hits = found.get(id);
  if (hits.length === 0) {
    console.error(`  FAIL ${id.padEnd(5)} no named test`);
    missing++;
  } else {
    const shown = hits.length === 1 ? hits[0] : `${hits.length} files`;
    console.log(`  ok   ${id.padEnd(5)} ${shown}`);
  }
}

console.log(`\n  ${IDS.length - missing}/${IDS.length} MUSTs covered across ${files.length} test files`);
if (missing > 0) {
  console.error(`\nFAIL: ${missing} MUST(s) have no named test. §8 is binding on code.`);
  process.exit(1);
}
'

echo
echo "GATE must-coverage: PASS"
