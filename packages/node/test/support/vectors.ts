import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Access to the conformance oracle by case name, so an M-test can cite the exact vector. */

const VECTORS = process.env['SERVANDA_VECTORS'] ?? join(process.cwd(), 'vendor/vectors');

export interface VectorCase {
  name: string;
  description: string;
  edge: unknown;
  assertions: unknown[];
  expected_outcomes: { index: number; accepted: boolean; rejection_reason: string | null }[];
  expected_final_state: string;
}

function load(file: string): VectorCase[] {
  return (
    JSON.parse(readFileSync(join(VECTORS, 'transitions', file), 'utf8')) as { cases: VectorCase[] }
  ).cases;
}

function find(cases: VectorCase[], name: string): VectorCase {
  const c = cases.find((x) => x.name === name);
  if (!c) throw new Error(`no such transition vector: ${name}`);
  return c;
}

export function invalidVector(name: string): VectorCase {
  return find(load('invalid.json'), name);
}

export function validVector(name: string): VectorCase {
  return find(load('valid.json'), name);
}
