/**
 * §4.7 + M-9 collective decomposition, re-exported under this package's own name.
 *
 * The rule itself lives in `@servanda/types` beside the `Edge` schema it is a property of.
 * This package and `@servanda/node` both decide verifiability and neither depends on the
 * other; each used to carry its own byte-identical copy, kept in step by an agreement test.
 * The alias keeps this package's public surface while leaving exactly one implementation.
 */
export { collectiveDecompositionValid } from '@servanda/types';
