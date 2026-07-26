'use strict';
/**
 * Network trap, loaded with `node --require` so it runs before any application module.
 *
 * Federation is the layer that is *allowed* to have a network — which is exactly why GF has to
 * prove the git transport does not need one. Every primitive that can reach off-box is replaced
 * with a thrower; if two nodes reaching agreement so much as resolves a hostname, the process
 * dies with NETWORK_ACCESS_DENIED and the gate fails.
 *
 * The trap is only evidence if it is armed, so `prove-no-network.mjs` runs positive controls
 * that must trip it and a negative control that must NOT report NETWORK_ACCESS_DENIED.
 *
 * Honest limitation: this blocks the documented Node surface of THIS process, not
 * `process.binding('tcp_wrap')`, a native addon, or a child process. The git transport does
 * spawn `git`, so the prover additionally asserts that the shared repository is a local
 * filesystem path with no URL scheme and no host — `git` against a path cannot reach a network
 * however it is compiled. The static import-graph audit closes the third side.
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

module.exports = { DENIED };
