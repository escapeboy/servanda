import { CapabilitySet } from './capabilities.js';
import type { Executor, ExecutionTarget } from './executor.js';
import type { RiskClass } from './trust/gradient.js';
import { testsExecutor } from './classes/tests.js';
import { deadCodeExecutor } from './classes/dead-code.js';
import { depBumpExecutor } from './classes/dep-bump.js';

/**
 * The v1 registry: hardcoded, three classes, no plugin mechanism.
 *
 * "The door for signals is wide open; the door for actions opens under control — that asymmetry
 * is deliberate" (execution-and-attention.md). There is no `register()` here, no discovery, no
 * config file listing classes. Adding a fourth class means editing this file and passing review,
 * which is exactly the friction the asymmetry is for. Scenario 6 leans on it directly: the
 * injected "add a GitHub Actions workflow" has no class to run in.
 */

export const EXECUTOR_CLASS_NAMES = ['tests', 'dead-code', 'dep-bump'] as const;
export type ExecutorClassName = (typeof EXECUTOR_CLASS_NAMES)[number];

export interface ExecutorClass {
  readonly name: ExecutorClassName;
  readonly riskClass: RiskClass;
  /** The only target shape this class accepts; anything else is refused before it runs. */
  readonly targetKind: ExecutionTarget['kind'];
  readonly capabilities: CapabilitySet;
  readonly run: Executor;
  readonly summary: string;
}

/**
 * Capability sets are written here and nowhere else. Note what none of them contains: no path
 * under `.github/`, no `.env`, no key material, no manifest for a class that has no business in
 * one. A capability that is not granted here cannot be granted at a call site — `runExecutor`
 * takes the class, not a capability set.
 */
const CLASSES: readonly ExecutorClass[] = Object.freeze([
  Object.freeze({
    name: 'tests',
    riskClass: 'routine',
    targetKind: 'source-file',
    capabilities: CapabilitySet.parse({
      read: ['src/**', 'test/**'],
      write: ['test/**'],
      maxChangedLines: 400,
      maxChangedFiles: 3,
    }),
    run: testsExecutor,
    summary: 'Scaffold a test file for a source module.',
  }),
  Object.freeze({
    name: 'dead-code',
    riskClass: 'routine',
    targetKind: 'symbol',
    capabilities: CapabilitySet.parse({
      read: ['src/**'],
      write: ['src/**'],
      maxChangedLines: 40,
      maxChangedFiles: 2,
    }),
    run: deadCodeExecutor,
    summary: 'Remove a declaration that nothing references.',
  }),
  Object.freeze({
    name: 'dep-bump',
    riskClass: 'supply-chain',
    targetKind: 'dependency',
    capabilities: CapabilitySet.parse({
      read: ['package.json'],
      write: ['package.json'],
      maxChangedLines: 4,
      maxChangedFiles: 1,
    }),
    run: depBumpExecutor,
    summary: 'Move one dependency to one version.',
  }),
] as ExecutorClass[]);

export const REGISTRY: readonly ExecutorClass[] = CLASSES;

export class UnknownExecutorClass extends Error {
  constructor(name: string) {
    super(
      `no executor class ${JSON.stringify(name)}; the v1 registry is exactly ` +
        `[${EXECUTOR_CLASS_NAMES.join(', ')}] and is not extensible at runtime`,
    );
    this.name = 'UnknownExecutorClass';
  }
}

export function getExecutorClass(name: string): ExecutorClass {
  const found = CLASSES.find((c) => c.name === name);
  if (found === undefined) throw new UnknownExecutorClass(name);
  return found;
}
