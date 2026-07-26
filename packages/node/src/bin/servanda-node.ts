#!/usr/bin/env node
import { Vault } from '@servanda/vault';
import { ServandaNode } from '../node.js';
import { McpServer } from '../mcp/stdio.js';

/**
 * Entry point: a §7 node speaking MCP over stdio.
 *
 * Configuration comes from the environment because stdio is the protocol channel and must
 * carry nothing else.
 *
 *   SERVANDA_VAULT       vault directory (required)
 *   SERVANDA_PASSPHRASE  vault passphrase (required)
 *   SERVANDA_PERSONA     active persona_id (defaults to the vault's first persona)
 */
function main(): Promise<void> {
  const dir = process.env['SERVANDA_VAULT'];
  const passphrase = process.env['SERVANDA_PASSPHRASE'];
  if (!dir || passphrase === undefined) {
    process.stderr.write('SERVANDA_VAULT and SERVANDA_PASSPHRASE are required\n');
    process.exit(2);
  }

  const vault = Vault.open({ dir, passphrase });
  const personas = vault.listPersonaIds();
  const activePersona = process.env['SERVANDA_PERSONA'] ?? personas[0];
  if (!activePersona) {
    process.stderr.write('vault has no persona; nothing to act as\n');
    process.exit(2);
  }

  const node = new ServandaNode({ vault, activePersona });
  return new McpServer(node).serve(process.stdin, process.stdout);
}

void main();
