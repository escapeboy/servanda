/**
 * RFC 8785 — JSON Canonicalization Scheme (JCS).
 *
 * Spec §00 Conventions: "Any object with a defined schema has exactly one canonical
 * byte representation; hashes and signatures are computed over it."
 *
 * Serialization is written out by hand rather than by rebuilding a key-sorted object and
 * handing it to JSON.stringify: JavaScript objects reorder integer-like keys ahead of
 * string keys regardless of insertion order, which would silently violate the RFC's
 * UTF-16 code-unit ordering for keys such as "2" and "10".
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** RFC 8785 §3.2.2.2 — member ordering is by UTF-16 code unit. JS default string sort is exactly that. */
function sortKeys(keys: string[]): string[] {
  return [...keys].sort();
}

/**
 * RFC 8785 §3.2.2.3 — numbers serialize per the ECMAScript Number::toString algorithm,
 * which is what JSON.stringify emits. NaN/Infinity have no JSON representation.
 */
function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError(`JCS: non-finite number cannot be canonicalized: ${String(n)}`);
  }
  // JSON.stringify(-0) === "0", which is the required output.
  return JSON.stringify(n) as string;
}

/**
 * RFC 8785 §3.2.2.2 — strings use JSON escaping with the shortest form for control
 * characters, no escaping of solidus, and no Unicode normalization. JSON.stringify has
 * emitted well-formed output (lone surrogates escaped) since ES2019.
 */
function serializeString(s: string): string {
  return JSON.stringify(s);
}

function write(value: JsonValue, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      out.push(serializeNumber(value));
      return;
    case 'string':
      out.push(serializeString(value));
      return;
    case 'object':
      break;
    default:
      throw new TypeError(`JCS: unsupported value type: ${typeof value}`);
  }

  if (Array.isArray(value)) {
    out.push('[');
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(',');
      write(value[i] as JsonValue, out);
    }
    out.push(']');
    return;
  }

  const obj = value as { [k: string]: JsonValue };
  const keys = sortKeys(Object.keys(obj));
  out.push('{');
  let first = true;
  for (const k of keys) {
    const v = obj[k];
    // Absent members and explicit `undefined` are both "not present" (JSON has no undefined).
    if (v === undefined) continue;
    if (!first) out.push(',');
    first = false;
    out.push(serializeString(k), ':');
    write(v, out);
  }
  out.push('}');
}

/** Canonical JSON text (RFC 8785) for a JSON value. */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  write(value as JsonValue, out);
  return out.join('');
}

/** Canonical JSON as UTF-8 bytes — the exact preimage for hashing and signing. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

/** Parse raw JSON text and return its canonical form. */
export function canonicalizeText(json: string): string {
  return canonicalize(JSON.parse(json));
}
