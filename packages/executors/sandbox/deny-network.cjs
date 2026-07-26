'use strict';
/**
 * Network trap for the executor sandbox, loaded with `node --require` so it runs before any
 * application module — including before the executor host imports anything.
 *
 * §9.2: "Executors receive typed objects + enumerated capabilities (no network by default)."
 * security.md §2 puts it more sharply: not "you may not send email" but "there is no network
 * interface". This file is the runtime half of that. Every primitive that can reach off-box is
 * replaced with a thrower, so an executor that so much as resolves a hostname kills its own
 * process with NETWORK_ACCESS_DENIED and produces no artifact at all.
 *
 * A trap is only evidence if it is armed. `test/support/prove-sandbox.mjs` runs positive
 * controls that must trip it and a negative control that must fail *differently* without it —
 * otherwise "the executor could not reach the network" would be indistinguishable from "there
 * was no network to reach".
 *
 * Honest limitation, same as the node layer's: this covers the documented Node surface, not
 * `process.binding('tcp_wrap')` or a native addon. The static import-graph audit in the same
 * prover closes the other side — nothing in the shipped graph imports a network module at all.
 */

const DENIED = 'NETWORK_ACCESS_DENIED';

function deny(what) {
  return function denied() {
    throw new Error(`${DENIED}: ${what} was called`);
  };
}

function trap(mod, names, prefix) {
  for (const name of names) {
    if (typeof mod[name] === 'function') mod[name] = deny(`${prefix}.${name}`);
  }
}

const net = require('node:net');
trap(net, ['connect', 'createConnection'], 'net');
net.Socket.prototype.connect = deny('net.Socket#connect');

const tls = require('node:tls');
trap(tls, ['connect', 'createSecureContext'], 'tls');

const dns = require('node:dns');
trap(dns, ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'lookupService'], 'dns');
trap(dns.promises, ['lookup', 'resolve', 'resolve4', 'resolve6'], 'dns.promises');

const http = require('node:http');
trap(http, ['request', 'get'], 'http');

const https = require('node:https');
trap(https, ['request', 'get'], 'https');

const http2 = require('node:http2');
trap(http2, ['connect'], 'http2');

const dgram = require('node:dgram');
trap(dgram, ['createSocket'], 'dgram');

for (const name of ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource']) {
  Object.defineProperty(globalThis, name, {
    value: deny(`global ${name}`),
    configurable: true,
    writable: true,
  });
}

/**
 * The second half of the capability world: an executor has no `exec` capability either, so the
 * ways out through a subprocess are closed too. Without this, `git push` is one spawn away and
 * "produces an artifact, never acts" would rest on the executor choosing not to.
 */
const childProcess = require('node:child_process');
trap(
  childProcess,
  ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork'],
  'child_process',
);

module.exports = { DENIED };
