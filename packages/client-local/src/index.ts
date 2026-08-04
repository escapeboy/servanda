export * from './warnings.js';
import type { NodeClient } from '@servanda/client-web';
import { ServandaNode } from '@servanda/node';
import type {
  BriefInput,
  BriefOutput,
  CommitInput,
  CommitOutput,
  ConfirmInput,
  ConfirmOutput,
  ExpectInput,
  ExpectOutput,
  OpenLoopsInput,
  OpenLoopsOutput,
} from '@servanda/types';
import { defaultStateDir, Vault } from '@servanda/vault';
import type { DeliveryInput, VaultStrengthInput } from '@servanda/client-web';
import { deliveryOf, vaultStrengthOf } from './warnings.js';

/**
 * The register, read from the vault it actually lives in.
 *
 * `NodeClient` was written as a narrow interface so that every surface could be built against
 * a stand-in "and pointed at a real one later with no change above this line". This is that
 * real one. Until it existed, `FixtureNodeClient` was the only implementation, which meant the
 * shipped TUI, the web ledger and the email brief could render only invented promises — the
 * vault worked, the node worked, and no client could reach either. An empty seam between two
 * finished halves.
 *
 * It lives in its own package for a dependency reason, not an aesthetic one: the interface
 * belongs to `@servanda/client-web` and the implementation needs `@servanda/node` and
 * `@servanda/vault`. A client package that imported the node would put a whole vault stack
 * behind a browser bundle, and a node that imported the client would invert §7 — the contract
 * exists so that clients depend on the node's *shape*, never the reverse. A third package
 * depending on both is the only arrangement that keeps that arrow pointing one way.
 *
 * The methods are async because `NodeClient` is; the node underneath is synchronous, and
 * nothing here adds concurrency. A remote client would genuinely await a transport, and the
 * interface has to fit both.
 */
export class LocalNodeClient implements NodeClient {
  private readonly node: ServandaNode;

  constructor(node: ServandaNode) {
    this.node = node;
  }

  async commit(input: CommitInput): Promise<CommitOutput> {
    return this.node.commit(input);
  }

  async expect(input: ExpectInput): Promise<ExpectOutput> {
    return this.node.expect(input);
  }

  async confirm(input: ConfirmInput): Promise<ConfirmOutput> {
    return this.node.confirm(input);
  }

  /** Tool name verbatim, per §7. The node spells the method `openLoops`; the wire spells it this way. */
  async open_loops(input: OpenLoopsInput): Promise<OpenLoopsOutput> {
    return this.node.openLoops(input);
  }

  async brief(input: BriefInput): Promise<BriefOutput> {
    return this.node.brief(input);
  }
}

export interface OpenVaultOptions {
  dir: string;
  passphrase: string;
  /** persona_id or context label. Omitted means the first persona in the vault. */
  persona?: string | undefined;
  /** Where node-local state lives. Omitted means `SERVANDA_STATE_DIR` or `~/.servanda-state`. */
  stateDir?: string | undefined;
  now?: (() => Date) | undefined;
}

export interface OpenedRegister {
  client: LocalNodeClient;
  vault: Vault;
  node: ServandaNode;
  /** The persona whose register this is — resolved, so a caller can display it. */
  personaId: string;
  /**
   * The two facts a surface needs and cannot fetch for itself, computed here rather than left
   * for the caller to remember.
   *
   * Returned rather than offered as helpers because the failure this closes is exactly a caller
   * not knowing to ask: `loadApp` took `pending` as an optional input with an empty default for
   * a whole release, and the terminal passed `{ items: [] }` explicitly with a comment saying
   * there was no read path — which stopped being true and nothing noticed. An input nobody
   * passes is a surface nobody sees.
   */
  vaultStrength: VaultStrengthInput;
  delivery: DeliveryInput;
}

/**
 * Open a vault on disk and return a client onto it.
 *
 * The passphrase is a parameter rather than something read from the environment here, because
 * a library that reaches for `process.env` cannot be used by a caller who keeps secrets
 * somewhere else. Entry points decide where a passphrase comes from; this decides nothing.
 */
export function openRegister(opts: OpenVaultOptions): OpenedRegister {
  const vault = Vault.open({ dir: opts.dir, passphrase: opts.passphrase });
  // Sorted by persona_index — creation order, and the only ordering that means anything to
  // the person. `listPersonaIds` sorts by persona_id, which is a public key: deterministic,
  // but arbitrary with respect to which persona somebody actually made first, so "the default
  // persona" would otherwise be decided by a hash.
  const personas = vault
    .listPersonaIds()
    .map((id) => vault.getPersona(id))
    .sort((a, b) => a.persona_index - b.persona_index);
  if (personas.length === 0) {
    throw new Error(
      `the vault at ${opts.dir} holds no persona. Create one with servanda-init before reading a register.`,
    );
  }

  // §1.2: a persona may be named by its persona_id or by its local context label — the same
  // two names the node itself accepts, so a caller never has to learn a third vocabulary.
  const wanted = opts.persona;
  const found =
    wanted === undefined
      ? personas[0]
      : personas.find((p) => p.persona_id === wanted || p.label === wanted);
  if (found === undefined) {
    // Deliberately does NOT enumerate the vault's personas. The old message listed every label
    // beside a key prefix — an org identity and a personal one in one string, on a surface that
    // reaches logs, shells and crash reporters. M-5 is about pipelines rather than error text, but
    // the reason it exists is that these two contexts are not supposed to meet, and a typo is a
    // poor trigger for putting them in the same sentence. The count is enough to tell "wrong name"
    // from "empty vault", which is the only thing the message has to do.
    throw new Error(
      `no persona named ${JSON.stringify(wanted)} in this vault (${personas.length} present)`,
    );
  }

  const node = new ServandaNode({
    vault,
    // `opts.stateDir` so an embedder can place it; otherwise `SERVANDA_STATE_DIR` or
    // `~/.servanda-state`. Never inside the vault — see `LocalStore`.
    localStore: vault.localStore(opts.stateDir ?? defaultStateDir()),
    activePersona: found.persona_id,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  return {
    client: new LocalNodeClient(node),
    vault,
    node,
    personaId: found.persona_id,
    vaultStrength: vaultStrengthOf(vault),
    delivery: deliveryOf(vault, found.persona_id),
  };
}
