import { sha256 as nobleSha256 } from '@noble/hashes/sha2';
import { canonicalBytes } from './jcs.js';

/** Spec §00 Conventions: all hashes SHA-256, hex-encoded lowercase. */
export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new TypeError(`odd-length hex string: ${hex.length} chars`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new TypeError(`invalid hex at offset ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

export function sha256Hex(data: Uint8Array): string {
  return toHex(nobleSha256(data));
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** sha256 over the RFC 8785 canonical form of an object. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalBytes(value));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
