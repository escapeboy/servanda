import { describe, expect, it } from 'vitest';
import { COPY, scanAll } from '@servanda/client-web';
import { sourceFor } from '../src/source.js';

/**
 * "A sample must never be mistakable for a register" (USAGE §4). The environment is the only
 * thing that decides which one you get, so this is the whole of that promise.
 */
describe('which register the terminal opens', () => {
  it('shows the demonstration, labelled, when nothing was asked for', () => {
    const source = sourceFor({});
    expect(source.kind).toBe('demonstration');
    expect(source.kind === 'demonstration' && source.banner).toContain('DEMONSTRATION');
  });

  it('refuses half an answer, whichever half is missing', () => {
    for (const env of [
      { SERVANDA_VAULT: '/home/you/.servanda' },
      { SERVANDA_PASSPHRASE: 'something only you know' },
    ]) {
      const source = sourceFor(env);
      expect(source.kind, JSON.stringify(env)).toBe('refuse');
      // The refusal has to say which half, or it cannot be acted on.
      expect(source.kind === 'refuse' && source.message).toContain('SERVANDA_VAULT');
      expect(source.kind === 'refuse' && source.message).toContain('SERVANDA_PASSPHRASE');
    }
  });

  it('never hands back a sample to somebody who supplied half a register', () => {
    expect(sourceFor({ SERVANDA_PASSPHRASE: 'x' }).kind).not.toBe('demonstration');
  });

  it('carries the persona through only when both halves are there', () => {
    const source = sourceFor({
      SERVANDA_VAULT: '/home/you/.servanda',
      SERVANDA_PASSPHRASE: 'x',
      SERVANDA_PERSONA: 'work',
    });
    expect(source).toEqual({
      kind: 'register',
      dir: '/home/you/.servanda',
      passphrase: 'x',
      persona: 'work',
    });
  });

  it('speaks no machinery vocabulary in the line it prints on every frame', () => {
    // The old banner said "vault" and "persona" — two of the seven words the copy table
    // exists to keep off a surface — and lived outside that table, where gate GE never
    // scanned it. The env variable names are one word each and survive the scan.
    expect(scanAll([COPY.source.demonstration])).toEqual([]);
    expect(scanAll([COPY.source.yours('/home/you/.servanda', 'a1b2c3d4…')])).toEqual([]);
  });
});
