import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { test } from 'node:test';
import { parseCertFile, type Block, type CertFile } from '../src/certInfo';
import { fixture } from './helpers';

// The promise of src/certInfo.ts that matters most: nothing of a private key is in what parseCertFile()
// returns, which is all the webview ever gets. Nor is the challenge password of a request, nor the text
// around the PEM blocks.
//
// The keys in test/fixtures/cert/ are throwaway keys that make.sh there generated for these tests (the
// passphrase of the encrypted ones is "previewix"). Their private numbers are taken out here with Node's
// crypto, not with certInfo, and then looked for in the whole result: as hex in either case and with any
// separators, as Base64 in all three alignments, and as runs of the Base64 the file itself holds.

const read = (name: string): Buffer => fs.readFileSync(fixture(`cert/${name}`));
const pem = (name: string): string => read(name).toString('latin1');
const parseText = (text: string): CertFile => parseCertFile(Buffer.from(text, 'latin1'));
/** The Base64 of the first PEM block of a text as it stands in the file, without line breaks and RFC 1421 headers. */
const bodyOf = (text: string): string => /-----BEGIN [^-]+-----([^]*?)-----END/.exec(text)![1].replace(/^[A-Za-z-]+:.*$/gm, '').replace(/\s/g, '');
const derOf = (text: string): Buffer => Buffer.from(bodyOf(text), 'base64');
const armor = (label: string, bytes: Uint8Array): string => `-----BEGIN ${label}-----\n${Buffer.from(bytes).toString('base64').replace(/.{64}(?=.)/g, '$&\n')}\n-----END ${label}-----\n`;
const colons = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex').toUpperCase().match(/../g)!.join(':');
const row = (block: Block, label: string): string | undefined => block.sections.flatMap((s) => s.rows).find((r) => r.label === label)?.value;

/** A DER element around the parts. */
function wrap(tag: number, ...parts: Uint8Array[]): Buffer {
  const body = Buffer.concat(parts);
  const size = body.length < 0x80 ? [body.length] : body.length < 0x100 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...size]), body]);
}
/** What is inside the outermost element. */
const inside = (der: Buffer): Buffer => der.subarray(der[1] < 0x80 ? 2 : 2 + (der[1] & 0x7f));
/** The elements of a run of DER, each with its header. */
function elements(der: Buffer): Buffer[] {
  const list: Buffer[] = [];
  for (let at = 0; at < der.length; ) {
    const header = der[at + 1] < 0x80 ? 2 : 2 + (der[at + 1] & 0x7f);
    const length = der[at + 1] < 0x80 ? der[at + 1] : der.readUIntBE(at + 2, der[at + 1] & 0x7f);
    list.push(der.subarray(at, at + header + length));
    at += header + length;
  }
  return list;
}
const oid = (hex: string): Buffer => wrap(0x06, Buffer.from(hex, 'hex'));
const utf8 = (text: string): Buffer => wrap(0x0c, Buffer.from(text));
/** An attribute of a request: its type and one value. */
const attribute = (type: Buffer, value: Buffer): Buffer => wrap(0x30, type, wrap(0x31, value));
const UNSTRUCTURED_NAME = oid('2a864886f70d010902');
const CHALLENGE_PASSWORD = oid('2a864886f70d010907');

/**
 * A certificate request made here and signed with the EC key of the fixtures, with the attributes given. The one
 * among the fixtures carries a challenge password, and a request can't lose an attribute and keep its signature.
 */
function request(attributes: Buffer[]): Buffer {
  const subject = wrap(0x30, wrap(0x31, wrap(0x30, oid('550403'), utf8('made.example.test'))));
  const spki = crypto.createPublicKey(pem('ec.key')).export({ type: 'spki', format: 'der' });
  const info = wrap(0x30, Buffer.from('020100', 'hex'), subject, spki, wrap(0xa0, ...attributes));
  const signature = crypto.sign('sha256', info, crypto.createPrivateKey(pem('ec.key')));
  // ecdsa-with-SHA256, and the signature as a bit string with no unused bits.
  return wrap(0x30, info, wrap(0x30, oid('2a8648ce3d040302')), wrap(0x03, Buffer.from([0]), signature));
}
/** The plain kind, as `openssl req -new` writes it when asked for nothing special. */
const PLAIN_REQUEST = armor('CERTIFICATE REQUEST', request([attribute(UNSTRUCTURED_NAME, utf8('a name that may be shown'))]));

function only(file: CertFile): Block {
  assert.equal(file.blocks.length, 1, file.message);
  return file.blocks[0];
}

// ---- Looking for a secret ---------------------------------------------------------

interface Haystack {
  text: string;
  hex: string;
  base64: string;
}

/** A result as the texts that are searched. Bytes, which a message to the webview would carry as they are, count as hex. */
function haystack(result: unknown): Haystack {
  const text =
    JSON.stringify(result, (_key, item: unknown) => {
      if (ArrayBuffer.isView(item)) {
        return Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString('hex');
      }
      // A Buffer arrives here as the array its toJSON() made of it.
      if (Array.isArray(item) && item.length >= 8 && item.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) {
        return Buffer.from(item as number[]).toString('hex');
      }
      return item;
    }) ?? '';
  // Line breaks inside a string are "\n" in JSON.
  const joined = text.replace(/\\[nrt]/g, '');
  return {
    text,
    // Colons and spaces between the digits must not hide a number, nor must lower case.
    hex: joined.replace(/[^0-9A-Za-z]/g, '').toUpperCase(),
    // The URL-safe alphabet counts as well.
    base64: joined.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/'),
  };
}

const HEX_BYTES = 8;
const BASE64_BYTES = 12;
const RUN = 20;

/** Where `secret` shows in the result, or undefined. Any 8 bytes of it in a row as hex and any 12 as Base64 count as showing. */
function find(hay: Haystack, secret: Buffer): string | undefined {
  for (let at = 0; at + HEX_BYTES <= secret.length; at++) {
    if (hay.hex.includes(secret.subarray(at, at + HEX_BYTES).toString('hex').toUpperCase())) {
      return `bytes ${at} to ${at + HEX_BYTES} as hex`;
    }
  }
  for (let at = 0; at + BASE64_BYTES <= secret.length; at++) {
    for (let shift = 0; shift < 3; shift++) {
      const encoded = Buffer.concat([Buffer.alloc(shift), secret.subarray(at, at + BASE64_BYTES), Buffer.alloc(2)]).toString('base64');
      // Only the characters these bytes decide alone: the first and the last share their bits with the neighbours.
      const own = encoded.slice(Math.ceil((shift * 8) / 6), Math.floor(((shift + BASE64_BYTES) * 8) / 6));
      if (hay.base64.includes(own)) {
        return `bytes ${at} to ${at + BASE64_BYTES} as Base64, shifted by ${shift}`;
      }
    }
  }
  if (hay.text.includes(BigInt(`0x${secret.toString('hex')}`).toString())) {
    return 'as a decimal number';
  }
  return undefined;
}

/** Where a run of the Base64 text of a key file shows in the result, or undefined. */
function findRun(hay: Haystack, body: string): string | undefined {
  for (let at = 0; at + RUN <= body.length; at++) {
    if (hay.base64.includes(body.slice(at, at + RUN))) {
      return `characters ${at} to ${at + RUN} of the Base64`;
    }
  }
  return undefined;
}

function assertHidden(what: string, result: unknown, secrets: Buffer[], bodies: string[] = []): void {
  const hay = haystack(result);
  for (const secret of secrets) {
    assert.ok(secret.length >= 16, `${what}: a secret of ${secret.length} bytes is too short to look for`);
    assert.equal(find(hay, secret), undefined, `${what}: part of a secret is in the result`);
  }
  for (const body of bodies) {
    assert.ok(body.length >= RUN * 3, what);
    assert.equal(findRun(hay, body), undefined, `${what}: part of the key file is in the result`);
  }
}

// ---- The keys and their secrets ---------------------------------------------------

/** The private numbers of a key: d for every kind, and the primes and the CRT values of an RSA key. */
function numbers(key: crypto.KeyObject): Buffer[] {
  const jwk = key.export({ format: 'jwk' }) as Record<string, string | undefined>;
  const list = ['d', 'p', 'q', 'dp', 'dq', 'qi'].flatMap((name) => (jwk[name] ? [Buffer.from(jwk[name]!, 'base64url')] : []));
  assert.ok(list.length === 1 || list.length === 6);
  return list;
}

const RSA = numbers(crypto.createPrivateKey(pem('rsa.key')));
const EC = numbers(crypto.createPrivateKey(pem('ec.key')));
const ED = numbers(crypto.createPrivateKey(pem('ed.key')));

/** Everything in an OpenSSH key behind its public half, which stands in the clear and is also what the .pub file holds. */
function sshPrivatePart(name: string): Buffer {
  const der = derOf(pem(name));
  const publicKey = Buffer.from(pem(`${name}.pub`).split(' ')[1], 'base64');
  const at = der.indexOf(publicKey);
  assert.ok(at > 0);
  return der.subarray(at + publicKey.length);
}

interface Key {
  name: string;
  /** The file. */
  text: string;
  /** The bytes under the label. */
  der: Buffer;
  /** What is private in it whatever stands next to it: the numbers, or the ciphertext, or the private half of an OpenSSH key. */
  secrets: Buffer[];
  /** The PEM label the bytes would have, when they are a file in DER form by themselves. */
  derLabel?: string;
}

function key(name: string, secrets: Buffer[] | undefined, derLabel?: string): Key {
  const der = derOf(pem(name));
  return { name, text: pem(name), der, secrets: secrets ?? [der], derLabel };
}

/**
 * A key locked the way PKCS #8 did it before PBES2, in the shape `openssl pkcs8 -topk8 -v1 PBE-SHA1-3DES -noiter`
 * writes: the scheme with a salt and an iteration count of one, then the ciphertext (a hash here). Its parameters
 * are two short values and not algorithms of their own, so under the label of a revocation list nothing but the
 * shape check stands between it and the PEM that is given back.
 */
function oldEncryptedKey(): Key {
  const scheme = Buffer.from('060a2a864886f70d010c0103', 'hex');
  const ciphertext = crypto.createHash('sha512').update('not a key, but as good as one for the search').digest();
  const der = wrap(0x30, wrap(0x30, scheme, wrap(0x30, wrap(0x04, Buffer.from('a1b2c3d4e5f60718', 'hex')), Buffer.from('020101', 'hex'))), wrap(0x04, ciphertext, ciphertext.subarray(0, 16)));
  return { name: 'a key encrypted the old way', text: armor('ENCRYPTED PRIVATE KEY', der), der, secrets: [der], derLabel: 'ENCRYPTED PRIVATE KEY' };
}

const KEYS: Key[] = [
  key('rsa.key', RSA, 'PRIVATE KEY'),
  key('rsa.pkcs1.key', RSA, 'RSA PRIVATE KEY'),
  // Encrypted: the numbers are out of reach, and the ciphertext with its salt is the key.
  key('rsa.enc8.key', undefined, 'ENCRYPTED PRIVATE KEY'),
  key('rsa.legacy.key', undefined),
  key('ec.key', EC, 'EC PRIVATE KEY'),
  key('ec.pkcs8.key', EC, 'PRIVATE KEY'),
  key('ed.key', ED, 'PRIVATE KEY'),
  key('ssh-ed', [sshPrivatePart('ssh-ed')]),
  key('ssh-ed-enc', [sshPrivatePart('ssh-ed-enc')]),
  key('ssh-rsa', [sshPrivatePart('ssh-rsa')]),
  oldEncryptedKey(),
];

/**
 * What a result is held to when the key is all there is in the file: none of its secrets, no run of the file's
 * Base64 and none of its bytes (the public half is not shown either, only hashed), and no PEM.
 */
function assertKeyHidden(what: string, file: CertFile, item: Key): void {
  assertHidden(what, file, [...item.secrets, item.der], [bodyOf(item.text)]);
  for (const block of file.blocks) {
    assert.equal(block.pem, undefined, `${what}: a block with PEM`);
  }
}

// ---- The search itself ------------------------------------------------------------

test('the search finds a secret planted as hex, as Base64 in every alignment, as bytes and as a number', () => {
  const [d, p] = RSA;
  const planted: [string, unknown][] = [
    ['lower-case hex', { x: d.toString('hex') }],
    ['upper-case hex with colons', { rows: [{ value: colons(d) }] }],
    ['hex with spaces, a part only', { x: d.subarray(40, 52).toString('hex').replace(/../g, '$& ') }],
    ['Base64', { x: p.toString('base64') }],
    ['Base64 after one byte', { x: Buffer.concat([Buffer.from('a'), p]).toString('base64') }],
    ['Base64 after two bytes', { x: Buffer.concat([Buffer.from('ab'), p]).toString('base64') }],
    ['URL-safe Base64', { x: Buffer.concat([Buffer.from('ab'), p]).toString('base64url') }],
    ['the PEM file', { x: pem('rsa.pkcs1.key') }],
    ['the PEM file with other line endings', { x: pem('rsa.key').replace(/\n/g, '\r\n') }],
    ['a Buffer', { x: derOf(pem('rsa.key')) }],
    ['a Uint8Array', { x: new Uint8Array(p) }],
    ['a decimal number', { x: `${BigInt(`0x${d.toString('hex')}`)}` }],
    ['a part in Base64', { x: `…${d.subarray(100, 130).toString('base64')}…` }],
  ];
  for (const [what, result] of planted) {
    assert.notEqual(RSA.map((secret) => find(haystack(result), secret)).find(Boolean), undefined, what);
  }
  assert.notEqual(findRun(haystack({ pem: pem('ec.key') }), bodyOf(pem('ec.key'))), undefined);
  assert.notEqual(findRun(haystack({ pem: pem('ed.key').replace(/\n/g, '\r\n') }), bodyOf(pem('ed.key'))), undefined);
  // And it stays quiet about what is public: the certificate of the same key holds none of the private numbers.
  assertHidden('the certificate', { x: pem('leaf.crt'), y: parseText(pem('leaf.crt')) }, RSA);
});

test('the numbers taken from the fixtures are those of the keys', () => {
  // d of the RSA key undoes e: a message raised to e and then to d comes back.
  const jwk = crypto.createPrivateKey(pem('rsa.key')).export({ format: 'jwk' }) as Record<string, string>;
  const n = BigInt(`0x${Buffer.from(jwk.n, 'base64url').toString('hex')}`);
  const [d, p, q] = RSA.map((number) => BigInt(`0x${number.toString('hex')}`));
  assert.equal(p * q, n);
  const power = (base: bigint, exponent: bigint): bigint => {
    let [result, square] = [1n, base % n];
    for (let e = exponent; e > 0n; e >>= 1n) {
      if (e & 1n) {
        result = (result * square) % n;
      }
      square = (square * square) % n;
    }
    return result;
  };
  assert.equal(power(power(42n, 65537n), d), 42n);
  assert.deepEqual(numbers(crypto.createPrivateKey(pem('rsa.pkcs1.key'))), RSA);
  assert.deepEqual(numbers(crypto.createPrivateKey({ key: pem('rsa.enc8.key'), passphrase: 'previewix' })), RSA);
  assert.deepEqual(numbers(crypto.createPrivateKey(pem('ec.pkcs8.key'))), EC);
  assert.deepEqual([EC[0].length, ED[0].length], [32, 32]);
  // They do stand in the files, so a reader that passed the file on would be caught.
  for (const number of RSA) {
    assert.ok(derOf(pem('rsa.key')).includes(number) && derOf(pem('rsa.pkcs1.key')).includes(number));
  }
  assert.ok(derOf(pem('ec.key')).includes(EC[0]) && derOf(pem('ec.pkcs8.key')).includes(EC[0]) && derOf(pem('ed.key')).includes(ED[0]));
  // An OpenSSH Ed25519 key holds its seed and the public key behind it; the seed is the private half.
  assert.ok(sshPrivatePart('ssh-ed').length >= 100 && sshPrivatePart('ssh-rsa').length >= 500);
});

// ---- What a private key is described by -------------------------------------------

const ALLOWED_ROWS = ['Format', 'Algorithm', 'Curve', 'Size', 'Protection', 'Public key SHA-256', 'SSH fingerprint'];

test('a private key is described by its format, algorithm, size and protection, and by nothing else', () => {
  const described = Object.fromEntries(
    KEYS.map(({ name, text }) => {
      const block = only(parseText(text));
      assert.equal(block.kind, 'private', name);
      assert.deepEqual(block.problems, [], name);
      // No PEM to copy, no key summary, and only rows of the kinds listed in AGENTS.md.
      assert.deepEqual([block.pem, block.key, block.validity, block.issuer], [undefined, undefined, undefined, undefined], name);
      assert.equal(block.sections.length, 1, name);
      assert.deepEqual(block.sections[0].rows.map((r) => r.label).filter((label) => !ALLOWED_ROWS.includes(label)), [], name);
      return [name, [block.title, row(block, 'Format'), row(block, 'Protection'), ...block.tags]];
    }),
  );
  assert.deepEqual(described, {
    'rsa.key': ['RSA 2048 bits', 'PKCS #8', 'Not encrypted', 'Not encrypted'],
    'rsa.pkcs1.key': ['RSA 2048 bits', 'PKCS #1 (traditional RSA)', 'Not encrypted', 'Not encrypted'],
    // openssl pkcs8 -topk8 -v2 aes-256-cbc: the cipher and the key derivation are what there is to say.
    'rsa.enc8.key': ['Algorithm hidden by the encryption', 'PKCS #8, encrypted', 'Encrypted with a password (AES-256-CBC, PBKDF2 with HMAC-SHA-256, 2,048 iterations)', 'Encrypted'],
    // openssl rsa -traditional -aes256: of the DEK-Info header only the cipher, not the initialisation vector after it.
    'rsa.legacy.key': ['RSA', 'Traditional OpenSSL, encrypted in the PEM layer', 'Encrypted with a password (AES-256-CBC)', 'Encrypted'],
    'ec.key': ['EC P-256', 'SEC 1 (traditional EC)', 'Not encrypted', 'Not encrypted'],
    'ec.pkcs8.key': ['EC P-256', 'PKCS #8', 'Not encrypted', 'Not encrypted'],
    'ed.key': ['Ed25519', 'PKCS #8', 'Not encrypted', 'Not encrypted'],
    'ssh-ed': ['Ed25519', 'OpenSSH', 'Not encrypted', 'Not encrypted'],
    'ssh-ed-enc': ['Ed25519', 'OpenSSH', 'Encrypted with a passphrase (aes256-ctr, bcrypt)', 'Encrypted'],
    'ssh-rsa': ['RSA 2048 bits', 'OpenSSH', 'Not encrypted', 'Not encrypted'],
    'a key encrypted the old way': ['Algorithm hidden by the encryption', 'PKCS #8, encrypted', 'Encrypted with a password (SHA-1 and Triple DES)', 'Encrypted'],
  });
});

test('the public key hash of a private key is that of its public half, in every form of the key', () => {
  const hashOf = (text: string) => colons(crypto.createHash('sha256').update(crypto.createPublicKey(text).export({ type: 'spki', format: 'der' })).digest());
  for (const [name, source] of [['rsa.key', 'rsa.key'], ['rsa.pkcs1.key', 'rsa.key'], ['ec.key', 'ec.key'], ['ec.pkcs8.key', 'ec.key'], ['ed.key', 'ed.key']]) {
    assert.equal(row(only(parseText(pem(name))), 'Public key SHA-256'), hashOf(pem(source)), name);
  }
  // The certificate and the request made with these keys say the same, which is how the page pairs them.
  assert.equal(row(only(parseText(pem('leaf.crt'))), 'Public key SHA-256'), hashOf(pem('rsa.key')));
  assert.equal(row(only(parseText(pem('request.csr'))), 'Public key SHA-256'), hashOf(pem('ec.key')));
  assert.equal(row(only(parseText(pem('ed.crt'))), 'Public key SHA-256'), hashOf(pem('ed.key')));
  // An encrypted key can't say.
  assert.equal(row(only(parseText(pem('rsa.enc8.key'))), 'Public key SHA-256'), undefined);
  assert.equal(row(only(parseText(pem('rsa.legacy.key'))), 'Public key SHA-256'), undefined);
});

test('an OpenSSH key shows the fingerprint of its public half, also when it is encrypted', () => {
  for (const name of ['ssh-ed', 'ssh-ed-enc', 'ssh-rsa']) {
    // What `ssh-keygen -l -f <name>.pub` prints: SHA-256 of the key blob in the .pub file, in Base64 without padding.
    const blob = Buffer.from(pem(`${name}.pub`).split(' ')[1], 'base64');
    assert.equal(row(only(parseText(pem(name))), 'SSH fingerprint'), `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`, name);
  }
});

// ---- Nothing of a key in the result -----------------------------------------------

test('a key under its own label: nothing of it is in the result', () => {
  for (const item of KEYS) {
    assertKeyHidden(item.name, parseText(item.text), item);
  }
});

test('a key in a PEM file of any shape that is still read: nothing of it is in the result', () => {
  for (const item of KEYS) {
    const { text } = item;
    const shapes: [string, Buffer][] = [
      ['Windows line endings', Buffer.from(text.replace(/\n/g, '\r\n'))],
      ['indented', Buffer.from(text.replace(/^/gm, '    '))],
      ['line breaks written as \\n', Buffer.from(text.replace(/\n/g, '\\n'))],
      ['UTF-16', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])],
      ['no END line', Buffer.from(text.replace(/-----END [^-]+-----\n/, ''))],
      ['cut in the middle', Buffer.from(text.slice(0, Math.floor(text.length * 0.6)))],
      ['twice', Buffer.from(text + text)],
    ];
    for (const [shape, bytes] of shapes) {
      const file = parseCertFile(bytes);
      assert.ok(file.blocks.length > 0 && file.blocks.every((block) => block.kind === 'private'), `${item.name}, ${shape}`);
      assertKeyHidden(`${item.name}, ${shape}`, file, item);
    }
    // On one line the RFC 1421 headers of the old encryption run into the Base64, which is then not read as a key.
    const flat = parseText(text.replace(/\n/g, ''));
    assert.equal(flat.blocks.length, 1, item.name);
    assertKeyHidden(`${item.name}, on one line`, flat, item);
  }
});

test('a key as a DER file, whole or cut, and as bare Base64: nothing of it is in the result', () => {
  for (const item of KEYS.filter((k) => k.derLabel)) {
    const whole = parseCertFile(item.der);
    assert.equal(whole.format, 'DER', item.name);
    assert.equal(only(whole).kind, 'private', item.name);
    assertKeyHidden(`${item.name} as DER`, whole, item);
    // The same description as under the label, so the file was taken for what it is.
    assert.deepEqual(only(whole).sections, only(parseText(armor(item.derLabel!, item.der))).sections, item.name);

    const bare = parseText(item.der.toString('base64'));
    assert.equal(bare.format, 'Base64', item.name);
    assert.equal(only(bare).kind, 'private', item.name);
    assertKeyHidden(`${item.name} as bare Base64`, bare, item);

    for (let length = 1; length < item.der.length; length += 23) {
      const what = `${item.name} as DER cut at ${length}`;
      const cut = parseCertFile(item.der.subarray(0, length));
      assertHidden(what, cut, item.secrets);
      assert.equal(cut.blocks.some((block) => block.kind === 'private' && block.pem !== undefined), false, what);
    }
  }
});

test('a private key file cut short is not taken for anything public, at whatever byte it ends', () => {
  // A reader that clamps the last element to the end of the file sees a smaller structure there: a PKCS #1 key that
  // ends inside its modulus is two numbers, which is the shape of an RSA public key.
  for (const item of KEYS.filter((k) => k.derLabel)) {
    for (let length = 1; length < item.der.length; length++) {
      const cut = parseCertFile(item.der.subarray(0, length));
      assert.deepEqual(cut.blocks.map((block) => [block.kind, block.pem]).filter(([kind, given]) => kind !== 'private' || given !== undefined), [], `${item.name} cut at ${length}`);
    }
  }
  // Past its first numbers a key in one of the plain forms is still said to be a private key.
  for (const [index, length] of [[0, 40], [1, 24], [1, 100], [1, 250], [4, 60]] as const) {
    const cut = parseCertFile(KEYS[index].der.subarray(0, length));
    assert.equal(only(cut).kind, 'private', `${KEYS[index].name} cut at ${length}`);
    assert.ok(only(cut).problems.length > 0);
  }
});

test('two numbers are an RSA public key only when they can be a modulus and a public exponent', () => {
  const jwk = crypto.createPrivateKey(pem('rsa.key')).export({ format: 'jwk' }) as Record<string, string>;
  const integer = (name: string) => wrap(0x02, Buffer.from([0]), Buffer.from(jwk[name], 'base64url'));
  const real = wrap(0x30, integer('n'), integer('e'));
  assert.equal(only(parseCertFile(real)).pem, armor('RSA PUBLIC KEY', real));
  const others: [string, Buffer][] = [
    // The private exponent is odd and smaller than the modulus, as a public one is.
    ['the modulus and the private exponent', wrap(0x30, integer('n'), integer('d'))],
    ['the two primes', wrap(0x30, integer('p'), integer('q'))],
    ['a version and the modulus', wrap(0x30, Buffer.from('020100', 'hex'), integer('n'))],
    ['the two CRT exponents', wrap(0x30, integer('dp'), integer('dq'))],
  ];
  // What no check of the form can tell: a private number written where the modulus belongs, with a real public
  // exponent behind it, is a well-formed RSA public key. That is the same as a certificate made with a secret
  // for its serial number, and nothing that a tool writes.
  for (const [what, pair] of others) {
    const spki = wrap(0x30, Buffer.from('300d06092a864886f70d0101010500', 'hex'), wrap(0x03, Buffer.from([0]), pair));
    for (const file of [parseCertFile(pair), parseText(armor('RSA PUBLIC KEY', pair)), parseCertFile(spki), parseText(armor('PUBLIC KEY', spki))]) {
      assert.deepEqual(file.blocks.filter((block) => block.pem !== undefined), [], what);
      assertHidden(what, file, RSA);
    }
  }
});

// Labels whose blocks are given back as PEM when they are what they say, labels that are decoded, labels that are only
// named, labels nobody knows, and the labels of the other kinds of private key.
const LABELS = [
  'CERTIFICATE', 'X509 CERTIFICATE', 'TRUSTED CERTIFICATE', 'CERTIFICATE REQUEST', 'NEW CERTIFICATE REQUEST', 'X509 CRL', 'PUBLIC KEY', 'RSA PUBLIC KEY',
  'PKCS7', 'CMS', 'DH PARAMETERS', 'X9.42 DH PARAMETERS', 'DSA PARAMETERS', 'EC PARAMETERS',
  'PKCS12', 'ATTRIBUTE CERTIFICATE', 'OCSP REQUEST', 'OCSP RESPONSE', 'SSL SESSION PARAMETERS', 'PGP PUBLIC KEY BLOCK', 'PGP MESSAGE', 'SSH2 PUBLIC KEY',
  'FOO', 'DATA', 'ANY PRIVATE KEY', 'OPENVPN STATIC KEY V1', 'PGP PRIVATE KEY BLOCK',
  'PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'DSA PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'OPENSSH PRIVATE KEY',
];

test('a key under the label of a certificate, a request, a public key or anything else: nothing of it is in the result', () => {
  for (const label of LABELS) {
    for (const item of KEYS) {
      const what = `${item.name} labelled ${label}`;
      const file = parseText(armor(label, item.der));
      assert.equal(file.blocks.length, 1, what);
      assertKeyHidden(what, file, item);
    }
  }
});

test('a block with an unknown label is passed on as its label and its size', () => {
  const { der } = KEYS[0];
  const block = only(parseText(armor('FOO', der)));
  assert.equal(block.kind, 'other');
  assert.deepEqual([block.sections, block.problems, block.pem], [[], [], undefined]);
  assert.ok(block.title.includes('FOO'));
  assert.ok(block.notes.join(' ').includes(`${der.length.toLocaleString('en-US')} bytes`), block.notes.join(' '));
  // A label that sounds like a secret makes it a private key block, which the page marks as one.
  assert.equal(only(parseText(armor('OPENVPN STATIC KEY V1', der))).kind, 'private');
});

test('a key in a file with certificates and text around it: nothing of it is in the result', () => {
  const file = parseText(`Bag Attributes\n    localKeyID: 01 02 03\n${pem('leaf.crt')}\nkey follows\n${pem('rsa.key')}\n${pem('rsa.pkcs1.key')}${pem('inter.crt')}# and others\n${pem('ec.key')}${pem('ed.key')}${pem('rsa.enc8.key')}${pem('ssh-ed')}the end\n`);
  assert.deepEqual(file.blocks.map((block) => block.kind), ['certificate', 'private', 'private', 'certificate', 'private', 'private', 'private', 'private']);
  // The certificate holds the public half of the RSA key, so here the private numbers are what is looked for, not the whole file.
  assertHidden('a mixed file', file, [...RSA, ...EC, ...ED, sshPrivatePart('ssh-ed'), derOf(pem('rsa.enc8.key'))], [bodyOf(pem('ec.key')), bodyOf(pem('ed.key')), bodyOf(pem('rsa.enc8.key')), bodyOf(pem('ssh-ed'))]);
  assert.deepEqual(file.blocks.map((block) => block.pem !== undefined), [true, false, false, true, false, false, false, false]);
  // The key is found to belong to the certificate all the same.
  assert.deepEqual(file.blocks[0].links.map((link) => link.index), [1, 2]);
});

test('a key whose BEGIN line is damaged is text around the blocks, and is not passed on', () => {
  for (const broken of ['----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY----', '-----BEGINPRIVATE KEY-----', '']) {
    const text = pem('rsa.key').replace('-----BEGIN PRIVATE KEY-----', broken);
    for (const file of [parseText(pem('leaf.crt') + text), parseText(text + pem('leaf.crt')), parseText(text)]) {
      assertHidden(`BEGIN line "${broken}"`, file, RSA);
      assert.ok(file.blocks.length <= 1);
    }
  }
});

test('what trails a certificate, a request, a list or a public key inside its block is not passed on', () => {
  const publicKey = crypto.createPublicKey(pem('ec.key')).export({ type: 'spki', format: 'pem' }) as string;
  for (const [label, text] of [['CERTIFICATE', pem('ed.crt')], ['CERTIFICATE REQUEST', PLAIN_REQUEST], ['X509 CRL', pem('inter.crl')], ['PUBLIC KEY', publicKey]]) {
    for (const item of KEYS) {
      const what = `${item.name} behind a ${label}`;
      const block = only(parseText(armor(label, Buffer.concat([derOf(text), item.der]))));
      assert.equal(block.kind, only(parseText(text)).kind, what);
      // The PEM that is offered for copying is the structure alone.
      assert.equal(block.pem, text, what);
      // The request is made with one of these keys, so its public half may be there; what is private may not.
      assertHidden(what, block, item.secrets);
    }
  }
});

test('a structure that begins as a public key and holds more is not given back as PEM', () => {
  const spki = crypto.createPublicKey(pem('ec.key')).export({ type: 'spki', format: 'der' });
  const pkcs1 = crypto.createPublicKey(pem('rsa.key')).export({ type: 'pkcs1', format: 'der' });
  for (const [label, publicKey] of [['PUBLIC KEY', spki], ['RSA PUBLIC KEY', pkcs1]] as const) {
    assert.equal(only(parseText(armor(label, publicKey))).pem, armor(label, publicKey), label);
    for (const item of KEYS) {
      // The two parts of the public key, and a private key as a third.
      const stuffed = wrap(0x30, inside(publicKey), item.der);
      assert.equal(only(parseText(armor(label, stuffed))).pem, undefined, `${item.name} inside a ${label}`);
      assert.deepEqual(parseCertFile(stuffed).blocks.filter((block) => block.pem !== undefined), [], `${item.name} inside a ${label}, as DER`);
    }
  }
});

/** The labels whose blocks are given back as PEM when they are what the label says. */
const GIVEN_BACK = ['CERTIFICATE', 'TRUSTED CERTIFICATE', 'CERTIFICATE REQUEST', 'X509 CRL', 'PUBLIC KEY', 'RSA PUBLIC KEY'];

test('a private key inside any wrapping is not given back as PEM, under whatever label', () => {
  // SEQUENCE { PrivateKeyInfo } has a number and then an algorithm, as the signed part of a certificate has.
  const wrappings: [string, (key: Buffer) => Buffer][] = [
    ['one more SEQUENCE', (key) => wrap(0x30, key)],
    ['two more', (key) => wrap(0x30, wrap(0x30, key))],
    ['a SEQUENCE with an algorithm and a signature behind it', (key) => wrap(0x30, key, wrap(0x30, oid('2a8648ce3d040302')), wrap(0x03, Buffer.alloc(9)))],
    ['a version and an algorithm in front', (key) => wrap(0x30, wrap(0x30, Buffer.from('020100', 'hex'), wrap(0x30, oid('2a8648ce3d040302')), key))],
    ['a context tag', (key) => wrap(0xa0, key)],
    ['a SET', (key) => wrap(0x31, key)],
  ];
  for (const item of KEYS) {
    for (const [how, wrapping] of wrappings) {
      const wrapped = wrapping(item.der);
      assertKeyHidden(`${item.name} in ${how}, as DER`, parseCertFile(wrapped), item);
      for (const label of GIVEN_BACK) {
        assertKeyHidden(`${item.name} in ${how}, as a ${label}`, parseText(armor(label, wrapped)), item);
      }
    }
  }
});

test('a certificate, a request or a list with a private key put into it is not given back as PEM', () => {
  for (const [label, text] of [['CERTIFICATE', pem('ed.crt')], ['CERTIFICATE', pem('leaf.crt')], ['CERTIFICATE REQUEST', PLAIN_REQUEST], ['X509 CRL', pem('inter.crl')]]) {
    const [signed, algorithm, signature] = elements(inside(derOf(text)));
    assert.notEqual(only(parseText(text)).pem, undefined, label);
    for (const item of KEYS) {
      const stuffed: [string, Buffer][] = [
        ['as a fourth part', wrap(0x30, signed, algorithm, signature, item.der)],
        ['at the end of the signed part', wrap(0x30, wrap(0x30, inside(signed), item.der), algorithm, signature)],
        ['in place of the signature', wrap(0x30, signed, algorithm, item.der)],
        ['in place of the algorithm', wrap(0x30, signed, item.der, signature)],
        // The length of the whole says more than its three parts take: bytes are left over inside it.
        ['behind the parts, inside the length of the whole', Buffer.concat([wrap(0x30, signed, algorithm, signature, Buffer.alloc(item.der.length)).subarray(0, -item.der.length), item.der])],
        ['inside an octet string in the signed part', wrap(0x30, wrap(0x30, inside(signed), wrap(0x04, item.der)), algorithm, signature)],
      ];
      for (const [where, bytes] of stuffed) {
        const what = `${item.name} ${where} of a ${label}`;
        for (const file of [parseText(armor(label, bytes)), parseCertFile(bytes)]) {
          assert.deepEqual(file.blocks.filter((block) => block.pem !== undefined), [], what);
          assert.deepEqual(file.blocks.flatMap((block) => block.sections.flatMap((s) => s.rows)).filter((r) => /fingerprint/i.test(r.label)), [], what);
          assertHidden(what, file, item.secrets);
        }
      }
    }
  }
});

test('a certificate with a part of the wrong form is still described, without fingerprints and without PEM', () => {
  const cert = derOf(pem('leaf.crt'));
  const [signed, algorithm, signature] = elements(inside(cert));
  const fields = elements(inside(signed));
  // The validity period with a third time in it: every field is in its place, and one is not what it should be.
  const validity = wrap(0x30, inside(fields[4]), elements(inside(fields[4]))[0]);
  const odd = wrap(0x30, wrap(0x30, ...fields.slice(0, 4), validity, ...fields.slice(5)), algorithm, signature);
  for (const file of [parseCertFile(odd), parseText(armor('CERTIFICATE', odd))]) {
    const block = only(file);
    assert.equal(block.kind, 'certificate');
    assert.equal(block.title, 'example.test');
    assert.equal(block.pem, undefined);
    assert.equal(row(block, 'SHA-256 fingerprint'), undefined);
    assert.match(block.problems.join(' '), /not offered as PEM/);
  }
});

// ---- PEM only for what is public --------------------------------------------------

test('PEM is given back for certificates, requests, revocation lists and public keys, and for nothing else', () => {
  const spki = crypto.createPublicKey(pem('rsa.key')).export({ type: 'spki', format: 'pem' }) as string;
  const pkcs1 = crypto.createPublicKey(pem('rsa.key')).export({ type: 'pkcs1', format: 'pem' }) as string;
  // Diffie-Hellman parameters in miniature: a prime and the generator 2.
  const dh = armor('DH PARAMETERS', Buffer.from('300d020900e5c5b5a3a1f1d7b3020102', 'hex'));
  const p7 = armor('PKCS7', read('chain.p7b'));
  const texts = [pem('leaf.crt'), PLAIN_REQUEST, pem('inter.crl'), spki, pkcs1, dh, armor('FOO', Buffer.from('hello')), armor('PKCS12', Buffer.from('0\u0003\u0002\u0001\u0003')), ...KEYS.map(({ text }) => text), p7];
  const file = parseText(texts.join('some text\n'));
  const kinds = file.blocks.map((block) => block.kind);
  assert.deepEqual(kinds, ['certificate', 'request', 'crl', 'public', 'public', 'other', 'other', 'other', ...KEYS.map(() => 'private'), 'certificate', 'certificate', 'certificate']);
  file.blocks.forEach((block, index) => {
    assert.equal(block.pem !== undefined, ['certificate', 'request', 'crl', 'public'].includes(block.kind), `block ${index + 1}, ${block.type}`);
  });
  // And it is the block of the file, byte for byte.
  assert.deepEqual(file.blocks.slice(0, 5).map((block) => block.pem), [pem('leaf.crt'), PLAIN_REQUEST, pem('inter.crl'), spki, pkcs1]);
  assert.deepEqual(file.blocks.slice(-3).map((block) => block.pem), [pem('leaf.crt'), pem('inter.crt'), pem('root.crt')]);
  assert.deepEqual([file.blocks[3].title, file.blocks[4].title], ['RSA 2048 bits', 'RSA 2048 bits']);
});

test('a public key of an algorithm that is not known here is described and not given back as PEM', () => {
  // The shape of a SubjectPublicKeyInfo, with an object identifier out of a private arc.
  const unknown = wrap(0x30, wrap(0x30, oid('2b0601040183b76f01')), wrap(0x03, Buffer.from([0]), crypto.randomBytes(64)));
  for (const file of [parseText(armor('PUBLIC KEY', unknown)), parseCertFile(unknown)]) {
    const block = only(file);
    assert.equal(block.kind, 'public');
    assert.equal(block.pem, undefined);
    assert.match(block.notes.join(' '), /not offered as PEM/);
  }
  // The ones that are known: RSA, EC and Ed25519 keys as Node writes them.
  for (const name of ['rsa.key', 'ec.key', 'ed.key']) {
    const text = crypto.createPublicKey(pem(name)).export({ type: 'spki', format: 'pem' }) as string;
    assert.equal(only(parseText(text)).pem, text, name);
    assert.equal(only(parseCertFile(derOf(text))).pem, text, name);
  }
});

// ---- The text around the blocks and the challenge password -------------------------

test('the text around the PEM blocks and the headers inside them are not passed on', () => {
  const words = ['hunter2secret', 'abcdef0123456789token', 'p4ssw0rd-in-a-header', 'between-the-blocks', 'after-the-end'];
  const text = `password=${words[0]}\nAPI_TOKEN="${words[1]}"\n${pem('leaf.crt').replace('-----\n', `-----\nComment: ${words[2]}\n\n`)}# ${words[3]}\n${pem('rsa.legacy.key')}${words[4]}`;
  const file = parseText(text);
  assert.deepEqual(file.blocks.map((block) => [block.kind, block.problems.length]), [['certificate', 0], ['private', 0]]);
  const result = JSON.stringify(file);
  for (const word of words) {
    assert.equal(result.includes(word), false, word);
    assert.equal(result.toLowerCase().includes(Buffer.from(word).toString('hex')), false, word);
  }
  // Of the two headers of the encrypted key only the name of the cipher is used.
  const iv = /DEK-Info: [^,]+,([0-9A-F]+)/.exec(pem('rsa.legacy.key'))![1];
  assert.equal(result.toUpperCase().includes(iv), false);
  assert.equal(file.blocks[0].pem, pem('leaf.crt'));
});

const CHALLENGE = 'TopSecretChallenge';

test('the challenge password of a request is said to be there, and nothing of it is passed on', () => {
  const fixture = derOf(pem('request.csr'));
  assert.ok(fixture.includes(CHALLENGE), 'the fixture carries one');
  const made = request([attribute(CHALLENGE_PASSWORD, utf8(CHALLENGE)), attribute(UNSTRUCTURED_NAME, utf8('a name that may be shown'))]);
  for (const file of [parseText(pem('request.csr')), parseCertFile(fixture), parseCertFile(made), parseText(armor('NEW CERTIFICATE REQUEST', made))]) {
    const block = only(file);
    assert.equal(block.kind, 'request');
    assert.deepEqual(block.problems, []);
    assert.equal(row(block, 'Challenge password'), 'Present (not shown)');
    // The PEM of a request is the whole request, so one with a password in it has none, and says why.
    assert.equal(block.pem, undefined);
    assert.match(block.notes.join(' '), /challenge password.*not offered as PEM/);
    assert.equal(JSON.stringify(file).includes(CHALLENGE), false);
    assertHidden('the request', file, [Buffer.from(CHALLENGE)]);
    // The rest of the request is read as ever.
    assert.match(row(block, 'Signature')!, /^Valid/);
  }
});

test('a request without a secret is given back as PEM, byte for byte', () => {
  for (const attributes of [[], [attribute(UNSTRUCTURED_NAME, utf8('a name that may be shown'))]]) {
    const text = armor('CERTIFICATE REQUEST', request(attributes));
    for (const file of [parseText(text), parseCertFile(derOf(text))]) {
      const block = only(file);
      assert.deepEqual([block.kind, block.title, block.problems, block.notes], ['request', 'made.example.test', [], []]);
      assert.equal(block.pem, text);
      assert.match(row(block, 'Signature')!, /^Valid/);
      assert.equal(row(block, 'Unstructured name'), attributes.length ? 'a name that may be shown' : undefined);
    }
  }
});

test('an attribute of a request that is not known here is named, and neither its value nor the request is passed on', () => {
  // What a CA of its own may ask for: a passphrase under an object identifier out of a private arc, as text and as bytes.
  const word = 'RevocationPassphrase-7731';
  const type = oid('2b0601040183b76f02');
  for (const value of [utf8(word), wrap(0x04, Buffer.from(word)), wrap(0x30, utf8(word))]) {
    const made = request([attribute(type, value)]);
    for (const file of [parseText(armor('CERTIFICATE REQUEST', made)), parseCertFile(made)]) {
      const block = only(file);
      assert.equal(block.kind, 'request');
      assert.match(row(block, '1.3.6.1.4.1.56303.2')!, /^\d+ bytes \(not shown\)$/);
      assert.equal(block.pem, undefined);
      assert.match(block.notes.join(' '), /not known here.*not offered as PEM/);
      assert.equal(JSON.stringify(file).includes(word), false);
      assertHidden('the request', file, [Buffer.from(word)]);
    }
  }
});
