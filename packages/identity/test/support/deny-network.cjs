'use strict';
/**
 * Network trap for the identity layer, loaded with `node --require` so it runs before any
 * application module.
 *
 * Modelled on packages/node/test/support/deny-network.cjs, with the DNS surface widened:
 * §1.5 anchors are the one part of §1 that *wants* to reach the network, and `resolveTxt` /
 * `resolveCname` / the promises API are exactly the calls a careless implementation would make.
 * If @servanda/identity so much as looks up a TXT record, the process dies with
 * NETWORK_ACCESS_DENIED and the gate fails.
 *
 * The trap is only evidence if it is armed, so prove-no-network.mjs runs positive controls that
 * must trip it and a negative control that must NOT report NETWORK_ACCESS_DENIED — otherwise a
 * machine with no network at all would "pass" this gate for the wrong reason.
 *
 * Honest limitation: this blocks the documented Node surface, not `process.binding('tcp_wrap')`
 * or a native addon. The static import-graph audit in the same prover covers the other side.
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

const DNS_METHODS = [
  'lookup',
  'lookupService',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCname',
  'resolveMx',
  'resolveNs',
  'resolveSrv',
  'resolveTxt',
  'reverse',
];
const dns = require('node:dns');
trap(dns, DNS_METHODS, 'dns');
trap(dns.promises, DNS_METHODS, 'dns.promises');
if (typeof dns.Resolver === 'function') {
  trap(dns.Resolver.prototype, DNS_METHODS, 'dns.Resolver');
}

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
