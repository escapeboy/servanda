import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  decodeEncodedWords,
  htmlToText,
  normalizeMessageId,
  parseAddressList,
  parseMessage,
  parseReferences,
  rfc3339FromMailDate,
} from '../src/index.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('mime: header parsing', () => {
  it('unfolds continuation lines', () => {
    const m = parseMessage(
      enc('Subject: a very\n long subject\nFrom: a@b.example\n\nbody\n'),
    );
    expect(m.subject).toBe('a very long subject');
  });

  it('takes the FIRST occurrence of a singleton header and records the duplicate', () => {
    const m = parseMessage(
      enc('From: real@a.example\nFrom: forged@b.example\nSubject: x\n\nbody\n'),
    );
    expect(m.from[0]?.address).toBe('real@a.example');
    expect(m.anomalies).toContain('duplicate-header:from');
  });

  it('skips lines that are not headers rather than throwing', () => {
    const m = parseMessage(enc('From: a@b.example\nthis is not a header\n\nbody\n'));
    expect(m.from[0]?.address).toBe('a@b.example');
    expect(m.anomalies).toContain('malformed-header-line');
  });

  it('reports a stable, sorted, deduped anomaly list', () => {
    const m = parseMessage(enc('From: a@b.example\nFrom: c@d.example\nSubject: x\nSubject: y\n\nb\n'));
    expect(m.anomalies).toEqual([...m.anomalies].sort());
    expect(new Set(m.anomalies).size).toBe(m.anomalies.length);
  });
});

describe('mime: addresses', () => {
  it('separates display name from address', () => {
    const [a] = parseAddressList('"Georgi Petrov" <georgi@skladco.example>', DEFAULT_LIMITS);
    expect(a?.name).toBe('Georgi Petrov');
    expect(a?.address).toBe('georgi@skladco.example');
  });

  it('does not treat a display name as an address', () => {
    const [a] = parseAddressList('"billing@acme.example" <attacker@evil.example>', DEFAULT_LIMITS);
    expect(a?.name).toBe('billing@acme.example');
    expect(a?.address).toBe('attacker@evil.example');
  });

  it('splits only on commas outside quotes and angle brackets', () => {
    const list = parseAddressList('"Petrov, Georgi" <g@a.example>, b@c.example', DEFAULT_LIMITS);
    expect(list.map((a) => a.address)).toEqual(['g@a.example', 'b@c.example']);
  });

  it('keeps a token that is not an address as raw only', () => {
    const [a] = parseAddressList('undisclosed recipients', DEFAULT_LIMITS);
    expect(a?.address).toBeUndefined();
    expect(a?.raw).toBe('undisclosed recipients');
  });

  it('is bounded', () => {
    const many = Array.from({ length: 500 }, (_, i) => `u${i}@e.example`).join(', ');
    expect(parseAddressList(many, DEFAULT_LIMITS).length).toBe(DEFAULT_LIMITS.maxAddresses);
  });
});

describe('mime: thread identity', () => {
  it('strips angle brackets and invisible characters from a message id', () => {
    expect(normalizeMessageId('<ab c@e.example>')).toBe('abc@e.example');
    expect(normalizeMessageId(undefined)).toBeUndefined();
    expect(normalizeMessageId('<>')).toBeUndefined();
  });

  it('parses References oldest-first and dedupes', () => {
    expect(parseReferences('<a@e> <b@e> <a@e>', DEFAULT_LIMITS)).toEqual(['a@e', 'b@e']);
  });

  it('falls back to whitespace splitting when a References header has no brackets', () => {
    expect(parseReferences('a@e b@e', DEFAULT_LIMITS)).toEqual(['a@e', 'b@e']);
  });
});

describe('mime: dates', () => {
  it('normalizes an RFC 5322 date to RFC 3339 UTC', () => {
    expect(rfc3339FromMailDate('Wed, 22 Jul 2026 09:14:00 +0300')).toBe('2026-07-22T06:14:00Z');
  });

  it('returns undefined rather than throwing on nonsense', () => {
    for (const bad of ['', 'not a date', 'Mon, 01 Jan 275760 00:00:00 +0000', undefined]) {
      expect(rfc3339FromMailDate(bad)).toBeUndefined();
    }
  });
});

describe('mime: bodies', () => {
  it('prefers text/plain over text/html in a multipart/alternative', () => {
    const m = parseMessage(
      enc(
        'From: a@b.example\nContent-Type: multipart/alternative; boundary="x"\n\n' +
          '--x\nContent-Type: text/plain\n\nplain wins\n' +
          '--x\nContent-Type: text/html\n\n<p>html loses</p>\n' +
          '--x--\n',
      ),
    );
    expect(m.text.trim()).toBe('plain wins');
    expect(m.html).toBe(false);
  });

  it('decodes quoted-printable and base64 transfer encodings', () => {
    const qp = parseMessage(
      enc('From: a@b.example\nContent-Transfer-Encoding: quoted-printable\n\nca=66=C3=A9\n'),
    );
    expect(qp.text.trim()).toBe('café');
    const b64 = parseMessage(
      enc(
        'From: a@b.example\nContent-Transfer-Encoding: base64\n\n' +
          `${Buffer.from('hello there', 'utf8').toString('base64')}\n`,
      ),
    );
    expect(b64.text.trim()).toBe('hello there');
  });

  it('preserves the original text length when clipping', () => {
    const big = 'A'.repeat(DEFAULT_LIMITS.maxTextChars + 5000);
    const m = parseMessage(enc(`From: a@b.example\n\n${big}\n`));
    expect(m.text.length).toBe(DEFAULT_LIMITS.maxTextChars);
    expect(m.textLength).toBeGreaterThan(DEFAULT_LIMITS.maxTextChars);
    expect(m.anomalies).toContain('text-clipped');
  });

  it('records attachments by name and size, never by content', () => {
    const m = parseMessage(
      enc(
        'From: a@b.example\nContent-Type: multipart/mixed; boundary="x"\n\n' +
          '--x\nContent-Type: text/plain\n\nsee attached\n' +
          '--x\nContent-Type: application/pdf; name="offer.pdf"\nContent-Disposition: attachment; filename="offer.pdf"\n\nPDFBYTES\n' +
          '--x--\n',
      ),
    );
    expect(m.attachments).toEqual([
      { filename: 'offer.pdf', content_type: 'application/pdf', bytes: 9 },
    ]);
  });

  it('parses a message/rfc822 part as the embedded original', () => {
    const m = parseMessage(
      enc(
        'From: a@b.example\nContent-Type: multipart/mixed; boundary="x"\n\n' +
          '--x\nContent-Type: text/plain\n\nfwd\n' +
          '--x\nContent-Type: message/rfc822\n\nFrom: orig@c.example\nSubject: original\n\ninner body\n' +
          '--x--\n',
      ),
    );
    expect(m.embedded?.from[0]?.address).toBe('orig@c.example');
    expect(m.embedded?.subject).toBe('original');
  });
});

describe('mime: encoded words and html', () => {
  it('decodes RFC 2047 encoded words', () => {
    expect(decodeEncodedWords('=?utf-8?B?T3BzIFdlZWtseQ==?=')).toBe('Ops Weekly');
    expect(decodeEncodedWords('=?utf-8?Q?caf=C3=A9?=')).toBe('café');
  });

  it('leaves an undecodable encoded word verbatim', () => {
    const weird = '=?nosuchcharset-xyz?B?!!!!?=';
    expect(decodeEncodedWords(weird)).toBe(weird);
  });

  it('drops script and style content and all markup from html', () => {
    const text = htmlToText(
      '<html><body onload="x()"><script>fetch("http://evil")</script><style>p{}</style>' +
        '<p>visible one</p><p>visible two</p></body></html>',
    );
    expect(text).toContain('visible one');
    expect(text).toContain('visible two');
    expect(text).not.toContain('fetch');
    expect(text).not.toContain('<');
  });
});

describe('mime: nothing throws', () => {
  it('parses zero bytes', () => {
    const m = parseMessage(new Uint8Array(0));
    expect(m.anomalies).toContain('empty-message');
    expect(m.text).toBe('');
  });

  it('parses bytes that are not valid UTF-8', () => {
    const m = parseMessage(Uint8Array.from([0xff, 0xfe, 0x00, 0x0a, 0x0a, 0xc3, 0x28]));
    expect(typeof m.text).toBe('string');
  });
});
