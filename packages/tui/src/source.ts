import { COPY } from '@servanda/client-web';

/**
 * Which register the terminal is about to show, decided from the environment alone.
 *
 * This lived inside `bin/servanda.mjs`, where nothing could reach it — and the entry point is
 * where the one question that matters most is answered: *are these my promises, or invented
 * ones?* Both of the defects found here were defects of that placement rather than of the
 * rule. It is a pure function of four strings so the answer can be checked instead of
 * demonstrated once by hand.
 */

export interface EnvLike {
  readonly SERVANDA_VAULT?: string | undefined;
  readonly SERVANDA_PASSPHRASE?: string | undefined;
  readonly SERVANDA_PERSONA?: string | undefined;
}

export type Source =
  | { readonly kind: 'demonstration'; readonly banner: string }
  | {
      readonly kind: 'register';
      readonly dir: string;
      readonly passphrase: string;
      readonly persona: string | undefined;
    }
  /** Neither register nor sample: say why and stop. */
  | { readonly kind: 'refuse'; readonly message: string };

/**
 * Half an answer is a refusal, in both directions.
 *
 * `SERVANDA_VAULT` without a passphrase already refused, on the stated ground that "a sample
 * shown where your promises were expected is worse than an error". The mirror case did not:
 * exporting the passphrase and mistyping the variable that names the directory quietly
 * produced invented promises. The expectation a person has typed is identical in both — they
 * came for their own register — so the answer is.
 */
export function sourceFor(env: EnvLike): Source {
  const dir = env.SERVANDA_VAULT;
  const passphrase = env.SERVANDA_PASSPHRASE;

  if (dir === undefined && passphrase === undefined) {
    return { kind: 'demonstration', banner: COPY.source.demonstration };
  }
  if (dir === undefined || passphrase === undefined) {
    const missing = dir === undefined ? 'SERVANDA_VAULT' : 'SERVANDA_PASSPHRASE';
    const present = dir === undefined ? 'SERVANDA_PASSPHRASE' : 'SERVANDA_VAULT';
    return {
      kind: 'refuse',
      message:
        `${present} is set and ${missing} is not. Reading your own register needs both: one\n` +
        `says where it is kept and the other unlocks it. Refusing to fall back to the\n` +
        `demonstration, because a sample shown where your promises were expected is worse\n` +
        `than an error.\n`,
    };
  }
  return { kind: 'register', dir, passphrase, persona: env.SERVANDA_PERSONA };
}
