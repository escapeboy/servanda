#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { defaultStateDir, LocalStore, Vault } from '@servanda/vault';
import { ServandaNode } from '../node.js';
import { McpServer } from '../mcp/stdio.js';
import { InitError, kdfAdvisoryFor, openFailure, type Env } from './servanda-init.js';

/**
 * Entry point: a §7 node speaking MCP over stdio.
 *
 * Configuration comes from the environment because stdio is the protocol channel and must
 * carry nothing else.
 *
 *   SERVANDA_VAULT       vault directory (required)
 *   SERVANDA_PASSPHRASE  vault passphrase (required)
 *   SERVANDA_PERSONA     active persona, by persona_id or by its local label
 *                        (defaults to the vault's first persona)
 */

function fail(message: string): never {
  throw new InitError(message);
}

/**
 * Open the vault and settle which persona this process acts as, before a byte of MCP is spoken.
 *
 * Every way of getting this wrong used to arrive as an uncaught exception, which under an MCP
 * client is the worst possible shape: the client reports that the server failed to start, and
 * the stack trace holding the only sentence that says why is somewhere the user is not looking.
 */
export function openNode(env: Env): { vault: Vault; localStore: LocalStore; activePersona: string } {
  const dir = env['SERVANDA_VAULT'];
  const passphrase = env['SERVANDA_PASSPHRASE'];
  if (!dir || passphrase === undefined) {
    fail('SERVANDA_VAULT and SERVANDA_PASSPHRASE are required');
  }

  let vault: Vault;
  try {
    vault = Vault.open({ dir, passphrase });
  } catch (err) {
    fail(openFailure(dir, err));
  }

  const wanted = env['SERVANDA_PERSONA'];
  const personas = vault.listPersonaIds();
  // §1.2: a persona may be named by its persona_id or by its local context label, which is what
  // the register already accepts under this same variable. Passing the value through unresolved
  // started the server on a persona that does not exist, so the failure surfaced one tool call
  // later, inside the assistant, as "persona_id must be lowercase hex".
  const activePersona =
    wanted === undefined
      ? personas[0]
      : personas.find((id) => id === wanted || vault.getPersona(id).label === wanted);
  if (activePersona === undefined) {
    if (personas.length === 0) fail(`the vault at ${dir} has no persona; nothing to act as`);
    fail(`no persona in ${dir} matches SERVANDA_PERSONA=${wanted} (neither a persona_id nor a label)`);
  }

  // `SERVANDA_STATE_DIR`, or `~/.servanda-state`. Deliberately NOT under `SERVANDA_VAULT`:
  // the vault commits everything in its tree, so a confirmation queue placed there would be
  // committed by the next write no matter what this file intended.
  return { vault, localStore: vault.localStore(defaultStateDir()), activePersona };
}

function main(): Promise<void> | void {
  let opened: { vault: Vault; localStore: LocalStore; activePersona: string };
  try {
    opened = openNode(process.env);
  } catch (err) {
    if (err instanceof InitError) {
      process.stderr.write(`servanda-node: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  // stderr, and before a byte of MCP is spoken. stdout is the protocol channel here, so this is
  // the only place a sentence for a human can go — and a vault made by a build up to 0.4.0-pre is
  // at the old profile for the rest of its life unless somebody is told.
  const advisory = kdfAdvisoryFor(opened.vault, process.env['SERVANDA_VAULT'] ?? '');
  if (advisory) process.stderr.write(`servanda-node:\n${advisory}`);

  const node = new ServandaNode(opened);
  return new McpServer(node).serve(process.stdin, process.stdout);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) void main();
