import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { mock, test } from 'node:test';
import * as path from 'path';
import { parseCertFile, type Block, type CertFile } from '../src/certInfo';
import { fixture, needs, random, run, scratch, which } from './helpers';

// Certificates, requests, revocation lists and PKCS #7 bundles as src/certInfo.ts reads them. What it
// promises about private keys is in certSecrets.test.ts.
//
// The fixtures in test/fixtures/cert/ are written by make.sh there (openssl; the keys are throwaway
// keys made for these tests). The names, serial numbers, dates and extensions below are what
// `openssl x509 -noout -text -nameopt esc_2253,esc_ctrl,utf8,sep_comma_plus_space,sname` printed for
// them. Everything that follows from a key (fingerprints, key identifiers, key hashes) is computed
// here from the bytes, with a DER reader of this file's own.

const dir = scratch();
const openssl = which('openssl');

const read = (name: string): Buffer => fs.readFileSync(fixture(`cert/${name}`));
const pem = (name: string): string => read(name).toString('latin1');
const parse = (name: string): CertFile => parseCertFile(read(name));
const parseText = (text: string): CertFile => parseCertFile(Buffer.from(text, 'latin1'));
/** The bytes inside the first PEM block of a text. */
const derOf = (text: string): Buffer => Buffer.from(/-----BEGIN [^-]+-----([^-]+)-----END/.exec(text)![1], 'base64');
const der = (name: string): Buffer => derOf(pem(name));
const armor = (label: string, bytes: Uint8Array): string => `-----BEGIN ${label}-----\n${Buffer.from(bytes).toString('base64').replace(/.{64}(?=.)/g, '$&\n')}\n-----END ${label}-----\n`;
const colons = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex').toUpperCase().match(/../g)!.join(':');
const digest = (algorithm: string, bytes: Uint8Array): string => colons(crypto.createHash(algorithm).update(bytes).digest());

const row = (block: Block, section: string, label: string): string | undefined => block.sections.find((s) => s.title === section)?.rows.find((r) => r.label === label)?.value;
const labels = (block: Block, section: string): string[] => block.sections.find((s) => s.title === section)?.rows.map((r) => r.label) ?? [];
/** A file with one block, and that block. */
function only(file: CertFile): Block {
  assert.equal(file.blocks.length, 1, file.message);
  return file.blocks[0];
}

// ---- A DER reader of the test's own -----------------------------------------------

interface Tlv {
  tag: number;
  start: number;
  from: number;
  end: number;
}

/** One element with a definite length, which is all that the fixtures hold. */
function tlv(data: Buffer, at: number): Tlv {
  let length = data[at + 1];
  let from = at + 2;
  if (length & 0x80) {
    const size = length & 0x7f;
    length = data.readUIntBE(from, size);
    from += size;
  }
  return { tag: data[at], start: at, from, end: from + length };
}

function children(data: Buffer, node: Tlv): Tlv[] {
  const list: Tlv[] = [];
  for (let at = node.from; at < node.end; at = list[list.length - 1].end) {
    list.push(tlv(data, at));
  }
  return list;
}

/** The parts of a certificate: what is signed, how, the signature, and the fields of the signed part by name. */
function certParts(cert: Buffer) {
  const [tbs, algorithm, signature] = children(cert, tlv(cert, 0));
  const fields = children(cert, tbs);
  // Version 1 has no version field in front.
  const [serial, , issuer, , subject, spki] = fields.slice(fields[0].tag === 0xa0 ? 1 : 0);
  return { tbs, algorithm, signature, serial, issuer, subject, spki };
}

const bytesOf = (data: Buffer, node: Tlv): Buffer => data.subarray(node.start, node.end);
const spkiOf = (cert: Buffer): Buffer => bytesOf(cert, certParts(cert).spki);
/** The key identifier openssl derives with `subjectKeyIdentifier = hash`: SHA-1 of the key bits (RFC 5280, 4.2.1.2). */
function keyIdOf(cert: Buffer): string {
  const spki = spkiOf(cert);
  const bits = children(spki, tlv(spki, 0))[1];
  return digest('sha1', spki.subarray(bits.from + 1, bits.end));
}

/** A copy with one bit turned in the last byte of an element. */
function flipIn(data: Buffer, node: Tlv): Buffer {
  const copy = Buffer.from(data);
  copy[node.end - 1] ^= 1;
  return copy;
}

/**
 * The leaf with a signature algorithm nobody knows, written into the outer field only: the signed part is
 * untouched, but no runtime can check the signature any more.
 */
function uncheckable(cert: Buffer): Buffer {
  const oid = children(cert, certParts(cert).algorithm)[0];
  const copy = Buffer.from(cert);
  copy[oid.end - 1] = 0x7f;
  return copy;
}

// ---- What openssl says about the fixtures -----------------------------------------

const ROOT_DN = 'C=US, O=Previewix Test, CN=Previewix Test Root';
const INTER_DN = 'C=US, O=Previewix Test, OU=Issuing\\, Dept \\"A\\", CN=Previewix Test Intermediate';
const LEAF_DN = 'C=DE, ST=Bayern, L=München, O=Beispiel GmbH, CN=example.test, emailAddress=admin@example.test';
const CERTIFICATES = ['root.crt', 'inter.crt', 'leaf.crt', 'ed.crt', 'v1.crt', 'pss.crt', 'k1-ca.crt', 'k1-leaf.crt', 'impostor.crt', 'impostor-ski.crt'];

const CHAIN = pem('leaf.crt') + pem('inter.crt') + pem('root.crt');
/** Who issued each block: the number of the issuer's block, `self`, or `out` when the issuer is not in the file. */
const issuers = (file: CertFile): string => file.blocks.map((block) => (block.selfSigned ? 'self' : block.issuer?.index !== undefined ? block.issuer.index + 1 : 'out')).join(' ');
const pems = (file: CertFile): (string | undefined)[] => file.blocks.map((block) => block.pem);

// ---- Reading a certificate --------------------------------------------------------

test('subject and issuer are given attribute by attribute and as one DN line', () => {
  const leaf = only(parse('leaf.crt'));
  assert.equal(row(leaf, 'Subject', 'DN'), LEAF_DN);
  assert.deepEqual(
    leaf.sections.find((s) => s.title === 'Subject')!.rows.slice(0, -1).map((r) => r.value),
    ['DE', 'Bayern', 'München', 'Beispiel GmbH', 'example.test', 'admin@example.test'],
  );
  // The comma and the quotes in the unit are escaped in the line, as RFC 4514 asks, and plain in the row.
  assert.equal(row(leaf, 'Issuer', 'DN'), INTER_DN);
  assert.equal(row(leaf, 'Issuer', 'Organizational unit'), 'Issuing, Dept "A"');
  assert.equal(leaf.title, 'example.test');
  assert.equal(leaf.issuer?.name, 'Previewix Test Intermediate');

  const root = only(parse('root.crt'));
  assert.equal(row(root, 'Subject', 'DN'), ROOT_DN);
  assert.equal(row(root, 'Issuer', 'DN'), ROOT_DN);
});

test('the validity period is given in milliseconds and as UTC text, for both ways a certificate writes a time', () => {
  const leaf = only(parse('leaf.crt'));
  assert.deepEqual(leaf.validity, { from: Date.UTC(2025, 5, 1, 12), to: Date.UTC(2025, 7, 30, 12) });
  assert.equal(row(leaf, 'Validity', 'Not before'), '2025-06-01 12:00:00 UTC');
  assert.equal(row(leaf, 'Validity', 'Not after'), '2025-08-30 12:00:00 UTC');
  assert.equal(row(leaf, 'Validity', 'Lifetime'), '90 days');

  const inter = only(parse('inter.crt'));
  assert.deepEqual(inter.validity, { from: Date.UTC(2021, 1, 3, 4, 5, 6), to: Date.UTC(2041, 1, 3, 4, 5, 6) });

  // 2060 is past what a two-digit year can say, so openssl wrote a GeneralizedTime there.
  const root = der('root.crt');
  const [, , , validity] = children(root, certParts(root).tbs).slice(1);
  assert.deepEqual(children(root, validity).map((time) => time.tag), [0x17, 0x18]);
  assert.deepEqual(only(parseCertFile(root)).validity, { from: Date.UTC(2020, 0, 1), to: Date.UTC(2060, 0, 1) });
});

test('the serial number is shown as bytes, without the zero that only keeps it positive', () => {
  assert.equal(row(only(parse('root.crt')), 'Certificate', 'Serial number'), '01 (1)');
  assert.equal(row(only(parse('inter.crt')), 'Certificate', 'Serial number'), '10:00 (4096)');
  // The first byte is F0, so the DER has a zero in front of it.
  const leaf = der('leaf.crt');
  const serial = certParts(leaf).serial;
  assert.equal(leaf[serial.from], 0);
  assert.equal(row(only(parseCertFile(leaf)), 'Certificate', 'Serial number'), 'F0:E1:D2:C3:B4:A5:96:87:78:69:5A:4B:3C:2D:1E:0F:00:11:22:33');
});

test('alternative names of every kind are listed by kind', () => {
  const leaf = only(parse('leaf.crt'));
  const names = Object.fromEntries(leaf.sections.find((s) => s.title === 'Subject alternative names')!.rows.map((r) => [r.label, r.value.split('\n')]));
  assert.deepEqual(names, {
    // An internationalised name is shown in both of its forms.
    'DNS names': ['example.test', '*.example.test', 'xn--mnchen-3ya.example.test (münchen.example.test)'],
    // Written as RFC 5952 asks: the longest run of zero groups as "::", a single zero group as it is.
    'IP addresses': ['192.0.2.10', '2001:db8::1', '::1', '2001:db8:0:1:2:3:4:5'],
    'Email addresses': ['admin@example.test'],
    URIs: ['https://example.test/id'],
    'Registered IDs': ['1.2.3.4'],
    'User principal names': ['user@example.test'],
    'Directory names': ['CN=dir name, O=Dir Org'],
  });
  assert.equal(only(parse('root.crt')).sections.some((s) => s.title.startsWith('Subject alternative names')), false);
});

test('the key is described by its algorithm and its size or curve', () => {
  const keys = Object.fromEntries(CERTIFICATES.map((name) => [name, only(parse(name)).key]));
  assert.deepEqual(keys, {
    'root.crt': 'RSA 2048 bits',
    'inter.crt': 'EC P-384',
    'leaf.crt': 'RSA 2048 bits',
    'ed.crt': 'Ed25519',
    'v1.crt': 'Ed25519',
    'pss.crt': 'RSA-PSS 2048 bits',
    'k1-ca.crt': 'EC secp256k1',
    'k1-leaf.crt': 'Ed25519',
    'impostor.crt': 'EC P-256',
    'impostor-ski.crt': 'EC P-256',
  });
  const leaf = only(parse('leaf.crt'));
  assert.equal(row(leaf, 'Public key', 'Size'), '2048 bits');
  assert.equal(row(leaf, 'Public key', 'Exponent'), '65537');
  const inter = only(parse('inter.crt'));
  assert.match(row(inter, 'Public key', 'Curve')!, /P-384.*secp384r1/);
  assert.equal(row(inter, 'Public key', 'Size'), '384 bits');
});

test('the fingerprints are the SHA-256 and the SHA-1 of the DER', () => {
  for (const name of CERTIFICATES) {
    const block = only(parse(name));
    assert.equal(row(block, 'Certificate', 'SHA-256 fingerprint'), digest('sha256', der(name)), name);
    assert.equal(row(block, 'Certificate', 'SHA-1 fingerprint'), digest('sha1', der(name)), name);
  }
});

test('the public key hash is the SHA-256 of the SubjectPublicKeyInfo', () => {
  for (const name of CERTIFICATES) {
    assert.equal(row(only(parse(name)), 'Public key', 'Public key SHA-256'), digest('sha256', spkiOf(der(name))), name);
  }
});

test('the key identifiers are those in the certificate', () => {
  const leaf = only(parse('leaf.crt'));
  assert.equal(row(leaf, 'Key identifiers', 'Subject key ID'), keyIdOf(der('leaf.crt')));
  assert.equal(row(leaf, 'Key identifiers', 'Authority key ID'), keyIdOf(der('inter.crt')));
  const inter = only(parse('inter.crt'));
  assert.equal(row(inter, 'Key identifiers', 'Subject key ID'), keyIdOf(der('inter.crt')));
  assert.equal(row(inter, 'Key identifiers', 'Authority key ID'), keyIdOf(der('root.crt')));
  assert.deepEqual(labels(only(parse('root.crt')), 'Key identifiers'), ['Subject key ID']);
  assert.deepEqual(labels(only(parse('impostor.crt')), 'Key identifiers'), []);
});

test('usage: whether it is a CA, the path length, key usage and extended key usage, with what is critical', () => {
  const usage = (name: string) => Object.fromEntries(only(parse(name)).sections.find((s) => s.title === 'Usage')!.rows.map((r) => [r.label, r.value]));
  assert.deepEqual(usage('root.crt'), { 'Certificate authority (critical)': 'Yes', 'Key usage (critical)': 'Certificate signing, CRL signing' });
  const inter = usage('inter.crt');
  assert.equal(inter['Certificate authority (critical)'], 'Yes');
  assert.match(inter['Path length'], /^0\b/);
  assert.equal(inter['Key usage (critical)'], 'Digital signature, Certificate signing, CRL signing');
  assert.deepEqual(usage('leaf.crt'), {
    'Certificate authority': 'No',
    'Key usage (critical)': 'Digital signature, Key encipherment',
    'Extended key usage': 'TLS server authentication, TLS client authentication',
  });
});

test('a version 1 certificate, which has no version field and no extensions, is read and is not a CA', () => {
  const cert = der('v1.crt');
  assert.equal(children(cert, certParts(cert).tbs)[0].tag, 0x02, 'the fixture starts with its serial number');
  const block = only(parseCertFile(cert));
  assert.deepEqual(block.problems, []);
  assert.equal(row(block, 'Certificate', 'Version'), '1');
  assert.equal(row(only(parse('leaf.crt')), 'Certificate', 'Version'), '3');
  assert.equal(row(block, 'Subject', 'DN'), 'CN=Previewix Test V1');
  assert.equal(row(block, 'Certificate', 'Serial number'), '03 (3)');
  // A two-digit year from 50 on is in the last century.
  assert.deepEqual(block.validity, { from: Date.UTC(1999, 11, 31, 23, 59, 59), to: Date.UTC(2024, 0, 11) });
  assert.equal(row(block, 'Validity', 'Not before'), '1999-12-31 23:59:59 UTC');
  assert.equal(row(block, 'Usage', 'Certificate authority'), 'No');
  assert.deepEqual(block.tags, ['Self-signed']);
});

test('the other extensions are decoded where there is something to read', () => {
  const inter = only(parse('inter.crt'));
  assert.equal(row(inter, 'Other extensions', 'CRL distribution points'), 'http://crl.example.test/root.crl');
  assert.equal(row(inter, 'Other extensions', 'Authority information access'), 'OCSP: http://ocsp.example.test\nCA issuers: http://ca.example.test/root.crt');
  assert.equal(row(inter, 'Other extensions', 'Certificate policies'), 'Domain validated (2.23.140.1.2.1)\n1.3.6.1.4.1.99999.1');
  assert.equal(row(inter, 'Other extensions', 'Name constraints'), 'Permitted: DNS .example.test\nExcluded: IP 10.0.0.0/8');
  const leaf = only(parse('leaf.crt'));
  assert.match(row(leaf, 'Other extensions', 'TLS feature')!, /must-staple/);
  // An extension nobody knows goes by its OID, and its value is shown when it is one plain string.
  assert.equal(row(leaf, 'Other extensions', '1.3.6.1.4.1.99999.5'), 'custom value');
});

test('the signature algorithm is named', () => {
  const algorithm = (name: string) => row(only(parse(name)), 'Certificate', 'Signature algorithm');
  assert.equal(algorithm('root.crt'), 'SHA-256 with RSA');
  assert.equal(algorithm('inter.crt'), 'SHA-384 with RSA');
  assert.equal(algorithm('leaf.crt'), 'ECDSA with SHA-256');
  assert.equal(algorithm('ed.crt'), 'Ed25519');
  assert.equal(algorithm('pss.crt'), 'RSASSA-PSS with SHA-256');
});

test('none of the fixtures has a part that could not be read', () => {
  for (const name of CERTIFICATES) {
    assert.deepEqual(only(parse(name)).problems, [], name);
  }
});

// ---- PEM and DER ------------------------------------------------------------------

test('a DER file is told from PEM by its content and gives the same description', () => {
  const fromPem = parse('leaf.crt');
  const fromDer = parseCertFile(der('leaf.crt'));
  assert.equal(fromPem.format, 'PEM');
  assert.equal(fromPem.text, true);
  assert.equal(fromDer.format, 'DER');
  // A DER file is binary, so there is no source to open.
  assert.equal(fromDer.text, false);
  assert.deepEqual(fromDer.blocks, fromPem.blocks);
});

test('the PEM of a certificate is the certificate, also when the file was DER', () => {
  for (const name of CERTIFICATES) {
    // As openssl wrote it: 64 characters a line.
    assert.equal(only(parseCertFile(der(name))).pem, pem(name), name);
  }
});

test('Base64 without the BEGIN and END lines is read and said to be that', () => {
  const file = parseText(der('leaf.crt').toString('base64').replace(/.{64}/g, '$&\r\n'));
  assert.equal(file.format, 'Base64');
  assert.equal(file.text, true);
  assert.equal(only(file).pem, pem('leaf.crt'));
  assert.equal(file.notes.length, 1);
});

test('a file with nothing to show says why, and whether there is a source to open', () => {
  const empty = parseCertFile(new Uint8Array(0));
  assert.deepEqual([empty.blocks.length, typeof empty.message], [0, 'string']);
  for (const [bytes, text] of [
    [Buffer.from('hello world\n'), true],
    [Buffer.from('0123456789 a text file that starts with a zero, as a DER sequence does\n'), true],
    [read('ssh-ed.pub'), true],
    [Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), false],
    [Buffer.from([0x30, 0x03, 0x02, 0x01, 0x05]), false],
  ] as const) {
    const file = parseCertFile(bytes);
    assert.deepEqual([file.blocks.length, file.format, file.text, typeof file.message], [0, '', text, 'string'], bytes.toString('latin1'));
  }
});

// ---- scanPem(): what a PEM file may look like -------------------------------------

const lenient: [string, string][] = [
  ['Windows line endings', CHAIN.replace(/\n/g, '\r\n')],
  ['old Mac line endings', CHAIN.replace(/\n/g, '\r')],
  [
    'text before, between and after the blocks',
    `Bag Attributes\n    friendlyName: test\nsubject=CN = example.test\n${pem('leaf.crt')}\n# the intermediate follows\nsome: text\n${pem('inter.crt')}Certificate:\n    Data:\n        Version: 3 (0x2)\n${pem('root.crt')}\ntrailing words\n`,
  ],
  ['indentation', CHAIN.replace(/^/gm, '      ')],
  ['tabs and trailing spaces', CHAIN.replace(/^(.*)$/gm, '\t$1  ')],
  ['everything on one line', CHAIN.replace(/\n/g, '')],
  ['line breaks written as \\n', CHAIN.replace(/\n/g, '\\n')],
  ['line breaks written as \\r\\n, in quotes', `CERT="${CHAIN.replace(/\n/g, '\\r\\n')}"`],
  ['a UTF-8 byte order mark', `ï»¿${CHAIN}`],
  ['an empty line after the BEGIN line', CHAIN.replace(/(-----BEGIN CERTIFICATE-----\n)/g, '$1\n')],
];

for (const [what, text] of lenient) {
  test(`PEM is read with ${what}`, () => {
    const file = parseText(text);
    assert.equal(file.format, 'PEM');
    assert.deepEqual(pems(file), [pem('leaf.crt'), pem('inter.crt'), pem('root.crt')]);
    assert.deepEqual(file.blocks.flatMap((block) => block.problems), []);
    assert.equal(file.chain?.state, 'ordered');
    assert.deepEqual(file.notes, []);
  });
}

test('a block without its END line is read up to the next BEGIN or the end of the file, and the loss is reported', () => {
  const END = '-----END CERTIFICATE-----\n';
  const noEnd = (name: string) => pem(name).replace(END, '');
  const middle = parseText(noEnd('leaf.crt') + pem('inter.crt') + pem('root.crt'));
  assert.deepEqual(pems(middle), [pem('leaf.crt'), pem('inter.crt'), pem('root.crt')]);
  assert.deepEqual(middle.blocks.map((block) => block.problems.length), [1, 0, 0]);
  const last = parseText(pem('leaf.crt') + noEnd('inter.crt'));
  assert.deepEqual(pems(last), [pem('leaf.crt'), pem('inter.crt')]);
  assert.deepEqual(last.blocks.map((block) => block.problems.length), [0, 1]);
});

test('a PEM file cut in the middle of a block shows the whole blocks and what is left of the last', () => {
  const text = pem('leaf.crt') + pem('inter.crt');
  const file = parseText(text.slice(0, pem('leaf.crt').length + 700));
  assert.equal(file.blocks.length, 2);
  assert.equal(file.blocks[0].pem, pem('leaf.crt'));
  assert.deepEqual(file.blocks[0].problems, []);
  const cut = file.blocks[1];
  assert.equal(cut.kind, 'certificate');
  assert.equal(cut.title, 'Previewix Test Intermediate');
  assert.equal(cut.pem, undefined);
  assert.ok(cut.problems.length >= 2, 'no END line, and a certificate cut short');
});

test('UTF-16 is read, and noted because other tools reject it', () => {
  const le = Buffer.from(CHAIN, 'utf16le');
  const be = Buffer.from(le).swap16();
  for (const [what, bytes] of [
    ['little-endian with a byte order mark', Buffer.concat([Buffer.from([0xff, 0xfe]), le])],
    ['big-endian with a byte order mark', Buffer.concat([Buffer.from([0xfe, 0xff]), be])],
    ['little-endian without one', le],
  ] as const) {
    const file = parseCertFile(bytes);
    assert.deepEqual(pems(file), [pem('leaf.crt'), pem('inter.crt'), pem('root.crt')], what);
    assert.equal(file.chain?.state, 'ordered', what);
    assert.equal(file.notes.length, 1, what);
    assert.match(file.notes[0], /UTF-16/, what);
  }
});

test('at most 1,000 blocks are shown, and the rest is counted', () => {
  const file = parseText('-----BEGIN X-----\nAAAA\n-----END X-----\n'.repeat(1003));
  assert.equal(file.blocks.length, 1000);
  assert.equal(file.notes.filter((note) => /\b3 more\b/.test(note)).length, 1);
  assert.deepEqual(parseText('-----BEGIN X-----\nAAAA\n-----END X-----\n'.repeat(1000)).notes, []);
});

// ---- relate(): who issued whom ----------------------------------------------------

test('a chain in the order of the file: each certificate is issued by the next, and the signatures are checked', () => {
  const file = parseText(CHAIN);
  assert.equal(file.chain?.state, 'ordered');
  assert.equal(issuers(file), '2 3 self');
  assert.deepEqual(file.blocks.map((block) => block.issuer?.checked), [true, true, true]);
  assert.deepEqual(file.blocks.map((block) => block.tags), [[], ['Intermediate CA'], ['Root CA']]);
});

test('a chain listed from the root down is said to be reversed', () => {
  const file = parseText(pem('root.crt') + pem('inter.crt') + pem('leaf.crt'));
  assert.equal(file.chain?.state, 'reversed');
  assert.equal(issuers(file), 'self 1 2');
});

test('a chain in another order is mixed, with the right order spelled out', () => {
  const file = parseText(pem('inter.crt') + pem('leaf.crt') + pem('root.crt'));
  assert.equal(file.chain?.state, 'mixed');
  assert.equal(issuers(file), '3 1 self');
  assert.ok(file.chain.text.includes('2. example.test → 1. Previewix Test Intermediate → 3. Previewix Test Root'), file.chain.text);
});

test('a chain may end at an issuer that is not in the file', () => {
  const file = parseText(pem('leaf.crt') + pem('inter.crt'));
  assert.equal(file.chain?.state, 'ordered');
  assert.equal(issuers(file), '2 out');
  assert.deepEqual(file.blocks[1].issuer, { name: 'Previewix Test Root' });
  assert.ok(file.chain.text.includes('Previewix Test Root'), file.chain.text);
});

test('certificates that are not one path are not a chain', () => {
  const gap = parseText(pem('leaf.crt') + pem('root.crt'));
  assert.equal(gap.chain?.state, 'none');
  assert.equal(issuers(gap), 'out self');
  const roots = parseText(pem('root.crt') + pem('ed.crt') + pem('pss.crt'));
  assert.equal(roots.chain?.state, 'none');
  assert.equal(issuers(roots), 'self self self');
  // A whole chain and a stranger next to it.
  const tree = parseText(pem('leaf.crt') + pem('inter.crt') + pem('root.crt') + pem('ed.crt'));
  assert.equal(tree.chain?.state, 'none');
  assert.equal(issuers(tree), '2 3 self self');
});

test('one certificate, with or without its key, is no chain at all', () => {
  assert.equal(parse('leaf.crt').chain, undefined);
  assert.equal(parseText(pem('leaf.crt') + pem('rsa.key')).chain, undefined);
});

test('a certificate with the name of the issuer and another key is not the issuer', () => {
  // Without a key identifier in the impostor, only the signature can tell.
  const alone = parseText(pem('leaf.crt') + pem('impostor.crt'));
  assert.equal(issuers(alone), 'out self');
  assert.equal(alone.chain?.state, 'none');
  for (const impostor of ['impostor.crt', 'impostor-ski.crt']) {
    const file = parseText(pem('leaf.crt') + pem(impostor) + pem('inter.crt') + pem('root.crt'));
    assert.equal(issuers(file), '3 self 4 self', impostor);
    assert.equal(file.blocks[0].issuer?.checked, true, impostor);
  }
});

test('where the signature cannot be checked, the key identifier picks the issuer, and the link is marked unchecked', () => {
  const leaf = armor('CERTIFICATE', uncheckable(der('leaf.crt')));
  const withId = parseText(leaf + pem('impostor-ski.crt') + pem('inter.crt'));
  assert.equal(issuers(withId), '3 self out');
  assert.notEqual(withId.blocks[0].issuer?.checked, true);
  // Nothing tells the two apart, so the first one by name is taken.
  const without = parseText(leaf + pem('impostor.crt') + pem('inter.crt'));
  assert.equal(issuers(without), '2 self out');
  assert.notEqual(without.blocks[0].issuer?.checked, true);
  assert.equal(without.blocks[0].problems.length, 0);
});

test('the issuer is found by name whatever the case of the letters', () => {
  const inter = der('inter.crt');
  const { subject } = certParts(inter);
  const shouting = Buffer.concat([inter.subarray(0, subject.start), Buffer.from(bytesOf(inter, subject).toString('latin1').replace('Previewix Test Intermediate', 'PREVIEWIX TEST INTERMEDIATE'), 'latin1'), inter.subarray(subject.end)]);
  assert.equal(shouting.length, inter.length);
  assert.notDeepEqual(shouting, inter);
  // The key is the same, so the signature of the leaf still verifies with it.
  const file = parseText(pem('leaf.crt') + armor('CERTIFICATE', shouting));
  assert.equal(file.blocks[1].title, 'PREVIEWIX TEST INTERMEDIATE');
  assert.deepEqual(file.blocks[0].issuer, { name: 'Previewix Test Intermediate', index: 1, checked: true });
});

test('the same certificate twice is marked as a duplicate of the first', () => {
  const file = parseText(pem('leaf.crt') + pem('inter.crt') + pem('leaf.crt'));
  assert.deepEqual(file.blocks.map((block) => block.tags.includes('Duplicate')), [false, false, true]);
  assert.deepEqual(file.blocks[2].links, [{ label: 'Same certificate as', index: 0 }]);
});

test('a certificate, its request and its keys are linked by their public key', () => {
  const publicKey = crypto.createPublicKey(pem('rsa.key')).export({ type: 'spki', format: 'pem' }) as string;
  const file = parseText(pem('leaf.crt') + pem('inter.crt') + pem('rsa.key') + publicKey + pem('request.csr') + pem('ec.key'));
  assert.deepEqual(file.blocks.map((block) => block.kind), ['certificate', 'certificate', 'private', 'public', 'request', 'private']);
  const linked = file.blocks.map((block) => block.links.map((link) => link.index));
  assert.deepEqual(linked, [[2, 3], [], [0, 3], [0, 2], [5], [4]]);
});

// ---- verify(): which signatures are checked ---------------------------------------

/** Whether this runtime's crypto can check a certificate against its issuer's key, asked without certInfo. */
function runtimeVerifies(cert: Buffer, issuer: Buffer, hash: string): boolean | undefined {
  try {
    const { tbs, signature } = certParts(cert);
    const key = crypto.createPublicKey({ key: spkiOf(issuer), format: 'der', type: 'spki' });
    return crypto.verify(hash, bytesOf(cert, tbs), key, cert.subarray(signature.from + 1, signature.end));
  } catch {
    return undefined;
  }
}

test('self-signatures made with RSA, RSA-PSS, P-256 and Ed25519 keys are verified in every runtime', () => {
  for (const name of ['root.crt', 'pss.crt', 'impostor.crt', 'ed.crt', 'v1.crt']) {
    const block = only(parse(name));
    assert.equal(block.selfSigned, true, name);
    assert.deepEqual(block.issuer, { name: block.title, checked: true }, name);
  }
});

test('signatures of an issuer with an RSA and with a P-384 key are verified in every runtime', () => {
  const file = parseText(CHAIN);
  assert.equal(row(file.blocks[1], 'Certificate', 'Signature algorithm'), 'SHA-384 with RSA');
  assert.deepEqual(file.blocks[1].issuer, { name: 'Previewix Test Root', index: 2, checked: true });
  assert.equal(file.blocks[0].key, 'RSA 2048 bits');
  assert.equal(file.blocks[1].key, 'EC P-384');
  assert.deepEqual(file.blocks[0].issuer, { name: 'Previewix Test Intermediate', index: 1, checked: true });
});

test('a secp256k1 signature is verified where the runtime can, and never called wrong where it cannot', () => {
  const [leaf, ca] = [der('k1-leaf.crt'), der('k1-ca.crt')];
  // true under Node, undefined under VS Code, whose BoringSSL has no such curve.
  const able = runtimeVerifies(leaf, ca, 'sha256');
  assert.notEqual(able, false);
  const file = parseText(pem('k1-leaf.crt') + pem('k1-ca.crt'));
  assert.equal(issuers(file), '2 self');
  assert.equal(file.chain?.state, 'ordered');
  assert.notEqual(file.blocks[0].issuer?.checked, false);
  assert.equal(file.blocks[0].issuer?.checked, able);
  assert.equal(file.blocks[1].issuer?.checked, able);
  assert.deepEqual(file.blocks.flatMap((block) => block.problems), []);
  assert.deepEqual(file.blocks[1].tags, ['Root CA']);
});

test('a certificate changed after it was signed is not linked to its issuer', () => {
  const leaf = der('leaf.crt');
  const changed = armor('CERTIFICATE', flipIn(leaf, certParts(leaf).serial));
  const file = parseText(changed + pem('inter.crt') + pem('root.crt'));
  assert.equal(issuers(file), 'out 3 self');
  assert.equal(file.blocks[0].issuer?.checked, undefined);
  assert.equal(file.chain?.state, 'none');
});

test('a certificate that names itself as issuer but fails its own signature is not called self-signed', () => {
  for (const name of ['root.crt', 'ed.crt', 'pss.crt', 'impostor.crt']) {
    const cert = der(name);
    const block = only(parseCertFile(flipIn(cert, certParts(cert).serial)));
    assert.notEqual(block.selfSigned, true, name);
    assert.notEqual(block.issuer?.checked, true, name);
    assert.equal(block.tags.includes('Root CA') || block.tags.includes('Self-signed'), false, name);
  }
});

// ---- PKCS #7 ----------------------------------------------------------------------

const P7_SIGNED_DATA = Buffer.from('06092a864886f70d010702', 'hex');
const P7_DATA = Buffer.from('06092a864886f70d010701', 'hex');
/** A BER element of indefinite length: its content runs up to two zero bytes. */
const ber = (tag: number, ...parts: Buffer[]): Buffer => Buffer.concat([Buffer.from([tag, 0x80]), ...parts, Buffer.from([0, 0])]);
/** SignedData without signers, as `openssl crl2pkcs7 -nocrl` writes it, but in the BER that streaming writers produce. */
const berBundle = (...certs: Buffer[]): Buffer =>
  ber(0x30, P7_SIGNED_DATA, ber(0xa0, ber(0x30, Buffer.from('020101', 'hex'), Buffer.from('3100', 'hex'), ber(0x30, P7_DATA), ber(0xa0, ...certs), Buffer.from('3100', 'hex'))));

test('a PKCS #7 bundle in DER form is shown as the certificates inside it', () => {
  // chain.p7b: openssl crl2pkcs7 -nocrl -certfile <leaf, inter, root> -outform der
  const file = parse('chain.p7b');
  assert.equal(file.format, 'DER');
  assert.equal(file.text, false);
  assert.deepEqual(pems(file), [pem('leaf.crt'), pem('inter.crt'), pem('root.crt')]);
  assert.equal(file.chain?.state, 'ordered');
  assert.equal(issuers(file), '2 3 self');
  assert.equal(file.notes.filter((note) => /PKCS #7/.test(note)).length, 1);
});

test('a PKCS #7 block in a PEM file gives its certificates too, next to the other blocks', () => {
  const file = parseText(pem('ed.crt') + armor('PKCS7', read('chain.p7b')));
  assert.equal(file.format, 'PEM');
  assert.deepEqual(pems(file), [pem('ed.crt'), pem('leaf.crt'), pem('inter.crt'), pem('root.crt')]);
  assert.deepEqual(file.blocks.map((block) => block.notes.some((note) => /PKCS #7/.test(note))), [false, true, true, true]);
});

test('a PKCS #7 bundle written with BER indefinite lengths is read', () => {
  const bundle = berBundle(der('leaf.crt'), der('inter.crt'), der('root.crt'));
  const file = parseCertFile(bundle);
  assert.equal(file.format, 'DER');
  assert.deepEqual(pems(file), [pem('leaf.crt'), pem('inter.crt'), pem('root.crt')]);
  assert.equal(file.chain?.state, 'ordered');
  assert.deepEqual(file.blocks.flatMap((block) => block.problems), []);
  assert.deepEqual(pems(parseText(armor('PKCS7', bundle))), [pem('leaf.crt'), pem('inter.crt'), pem('root.crt')]);
});

test('a PKCS #7 file without certificates, or of another kind, is named and not decoded', () => {
  const empty = only(parseCertFile(berBundle()));
  assert.equal(empty.kind, 'other');
  assert.equal(empty.pem, undefined);
  const data = only(parseCertFile(ber(0x30, P7_DATA, ber(0xa0, Buffer.from('040568656c6c6f', 'hex')))));
  assert.equal(data.kind, 'other');
  assert.equal(data.pem, undefined);
});

test('indefinite lengths nested without end neither throw nor take long', () => {
  for (const unit of [[0x30, 0x80], [0xa0, 0x80], [0x30, 0x80, 0x06, 0x01, 0x2a]]) {
    const file = parseCertFile(Buffer.alloc(300000, Buffer.from(unit)));
    assert.equal(file.blocks.filter((block) => block.kind === 'certificate').length, 0);
  }
});

// ---- Requests and revocation lists ------------------------------------------------

test('a certificate request: subject, requested names and usage, key, and its own signature', () => {
  const file = parse('request.csr');
  const block = only(file);
  assert.equal(block.kind, 'request');
  assert.equal(block.title, 'request.example.test');
  assert.deepEqual(block.problems, []);
  assert.equal(row(block, 'Subject', 'DN'), 'C=US, O=Requester Inc, CN=request.example.test');
  assert.equal(row(block, 'Subject alternative names', 'DNS names'), 'request.example.test\nwww.request.example.test');
  assert.equal(row(block, 'Subject alternative names', 'IP addresses'), '198.51.100.7');
  assert.equal(block.key, 'EC P-256');
  assert.equal(row(block, 'Requested extensions', 'Key usage'), 'Digital signature, Key encipherment');
  assert.equal(row(block, 'Requested extensions', 'Extended key usage'), 'TLS server authentication');
  assert.equal(row(block, 'Requested extensions', 'Certificate authority'), 'No');
  assert.equal(row(block, 'Request', 'Signature algorithm'), 'ECDSA with SHA-256');
  // A P-256 signature, which every runtime checks.
  assert.match(row(block, 'Request', 'Signature')!, /^Valid/);
  assert.equal(row(block, 'Attributes', 'Unstructured name'), 'An unstructured name');
  // This one carries a challenge password, and the PEM of a request is all of it: so it has none, and says why.
  // certSecrets.test.ts makes requests without one and gets them back byte for byte.
  assert.equal(block.pem, undefined);
  assert.equal(block.notes.length, 1);
  assert.match(block.notes[0], /challenge password/);
  // Nothing in it says when it is valid or who issued it.
  assert.equal(block.validity, undefined);
  assert.equal(block.issuer, undefined);
});

test('a request in DER form is recognised', () => {
  const file = parseCertFile(der('request.csr'));
  assert.equal(file.format, 'DER');
  assert.deepEqual(file.blocks, parse('request.csr').blocks);
});

test('a request changed after it was signed has an invalid signature, and that is a problem', () => {
  const request = der('request.csr');
  const [info] = children(request, tlv(request, 0));
  const subject = children(request, info)[1];
  const block = only(parseCertFile(flipIn(request, subject)));
  assert.equal(block.title, 'request.example.tesu');
  assert.match(row(block, 'Request', 'Signature')!, /^Invalid/);
  assert.equal(block.problems.length, 1);
});

test('a revocation list: issuer, dates and the number of revoked certificates', () => {
  // inter.crl: openssl ca -gencrl with one revoked certificate, signed by the intermediate.
  for (const file of [parse('inter.crl'), parseCertFile(der('inter.crl'))]) {
    const block = only(file);
    assert.equal(block.kind, 'crl');
    assert.equal(block.title, 'Previewix Test Intermediate');
    assert.deepEqual(block.problems, []);
    assert.equal(row(block, 'Issuer', 'DN'), INTER_DN);
    assert.equal(row(block, 'List', 'Issued'), '2025-07-01 00:00:00 UTC');
    assert.equal(row(block, 'List', 'Next update'), '2025-07-31 00:00:00 UTC');
    assert.equal(row(block, 'List', 'Revoked certificates'), '1');
    assert.equal(row(block, 'List', 'Signature algorithm'), 'ECDSA with SHA-256');
    assert.equal(block.pem, pem('inter.crl'));
  }
  assert.equal(parseCertFile(der('inter.crl')).format, 'DER');
});

// ---- The clock --------------------------------------------------------------------

test('nothing in the result depends on the clock or the time zone', () => {
  // The page works out "valid", "expired" and "days left" itself, from `validity`.
  const files = [Buffer.from(CHAIN), read('inter.crl'), read('request.csr'), read('rsa.key'), read('chain.p7b')];
  const zone = process.env.TZ;
  const at = (now: number, tz: string) => {
    mock.timers.enable({ apis: ['Date'], now });
    process.env.TZ = tz;
    try {
      return files.map((bytes) => parseCertFile(bytes));
    } finally {
      mock.timers.reset();
      if (zone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = zone;
      }
    }
  };
  // Before any of the certificates begins, and after all of them have ended.
  const before = at(Date.UTC(1999, 0, 1), 'Pacific/Kiritimati');
  const after = at(Date.UTC(2099, 6, 1, 12), 'America/Anchorage');
  assert.deepEqual(after, before);
  assert.deepEqual(before[0].blocks[0].validity, { from: Date.UTC(2025, 5, 1, 12), to: Date.UTC(2025, 7, 30, 12) });
});

// ---- Damage -----------------------------------------------------------------------

/** Parses, and holds the result to what must be true of every file whatever is in it. */
function survive(bytes: Uint8Array, what: string): CertFile {
  let file: CertFile;
  try {
    file = parseCertFile(bytes);
    JSON.stringify(file);
  } catch (error) {
    assert.fail(`${what}: ${error instanceof Error ? error.stack : String(error)}`);
  }
  assert.ok(file.blocks.length > 0 || typeof file.message === 'string', `${what}: neither a block nor a message`);
  return file;
}

test('a DER certificate cut at any length is shown as far as it goes, without fingerprints and without PEM', () => {
  for (const name of ['leaf.crt', 'root.crt']) {
    const whole = der(name);
    let shown = 0;
    let named = 0;
    for (let length = 0; length < whole.length; length++) {
      const what = `${name} cut at ${length}`;
      for (const block of survive(whole.subarray(0, length), what).blocks) {
        shown++;
        named += block.sections.some((s) => s.title === 'Subject') ? 1 : 0;
        assert.equal(block.pem, undefined, what);
        assert.equal(block.sections.flatMap((s) => s.rows).some((r) => /fingerprint/i.test(r.label)), false, what);
        assert.ok(block.problems.length > 0, what);
      }
    }
    // Most cuts leave something worth showing; the subject is in the first third.
    assert.ok(shown > whole.length * 0.9, `${name}: ${shown} of ${whole.length} cuts shown`);
    assert.ok(named > whole.length * 0.5, `${name}: ${named} of ${whole.length} cuts with a subject`);
  }
});

test('a request or a revocation list cut short says so, and has no PEM', () => {
  for (const name of ['request.csr', 'inter.crl']) {
    const whole = der(name);
    let shown = 0;
    for (let length = 0; length < whole.length; length++) {
      const what = `${name} cut at ${length}`;
      for (const block of survive(whole.subarray(0, length), what).blocks) {
        shown++;
        assert.equal(block.kind, name === 'request.csr' ? 'request' : 'crl', what);
        assert.equal(block.pem, undefined, what);
        assert.match(block.problems.join(' '), /cut short/, what);
      }
    }
    // A list is told from a version 1 certificate by its fourth field, the date behind the issuer's name; cut before
    // that, the file is called neither, which is why fewer cuts of the list are shown.
    assert.ok(shown > whole.length * 0.5, `${name}: ${shown} of ${whole.length} cuts shown`);
  }
});

test('a DER file that starts as a certificate does and goes on as something else is a file of no known kind', () => {
  const cert = der('leaf.crt');
  const { tbs, algorithm, signature } = certParts(cert);
  const fields = children(cert, tbs);
  // The serial number and the algorithm of a certificate, and then an octet string where the issuer belongs.
  const head = Buffer.concat(fields.slice(0, 3).map((field) => bytesOf(cert, field)));
  const body = Buffer.concat([head, Buffer.from('0410', 'hex'), Buffer.alloc(16, 7)]);
  const odd = Buffer.concat([Buffer.from([0x30, 0x82, 0, 0]), Buffer.from([0x30, body.length]), body, bytesOf(cert, algorithm), bytesOf(cert, signature)]);
  odd.writeUInt16BE(odd.length - 4, 2);
  const file = parseCertFile(odd);
  assert.deepEqual([file.blocks.length, file.format, file.text], [0, '', false]);
  assert.match(file.message!, /not a certificate/);
  // Under the label it is a block that couldn't be read as what the label says.
  const block = only(parseText(armor('CERTIFICATE', odd)));
  assert.deepEqual([block.kind, block.title, block.pem], ['other', 'Unreadable', undefined]);
  assert.equal(block.problems.length, 1);
});

test('requests, revocation lists, bundles and PEM files cut short do not throw', () => {
  for (const [name, bytes] of [['request.csr', der('request.csr')], ['inter.crl', der('inter.crl')], ['chain.p7b', read('chain.p7b')], ['chain', Buffer.from(CHAIN)]] as const) {
    for (let length = 0; length < bytes.length; length += name === 'request.csr' || name === 'inter.crl' ? 1 : 7) {
      for (const block of survive(bytes.subarray(0, length), `${name} cut at ${length}`).blocks) {
        // What is cut is never offered as PEM: every PEM is a whole structure of the file.
        if (block.pem !== undefined) {
          assert.ok(bytes.includes(derOf(block.pem)) || CHAIN.includes(block.pem), `${name} cut at ${length}`);
        }
      }
    }
  }
});

test('a certificate with bytes changed at random does not throw, and its PEM and fingerprint stay those of the bytes', () => {
  const rand = random(0xce27);
  for (const name of ['leaf.crt', 'inter.crt', 'request.csr', 'inter.crl']) {
    const whole = der(name);
    for (let round = 0; round < 250; round++) {
      const copy = Buffer.from(whole);
      for (let flips = 1 + (round % 4); flips > 0; flips--) {
        copy[rand.int(copy.length)] = rand.int(256);
      }
      const what = `${name}, round ${round}: ${copy.toString('base64')}`;
      for (const block of survive(copy, what).blocks) {
        if (block.pem === undefined) {
          continue;
        }
        // A changed length may end the structure early; what is given back is still what is there.
        const given = derOf(block.pem);
        assert.ok(given.equals(copy.subarray(0, given.length)), what);
        if (block.kind === 'certificate') {
          assert.equal(row(block, 'Certificate', 'SHA-256 fingerprint'), digest('sha256', given), what);
        }
      }
    }
  }
});

test('noise under every label, and as a file of its own, does not throw', () => {
  const rand = random(0x0bad);
  const LABELS = ['CERTIFICATE', 'TRUSTED CERTIFICATE', 'CERTIFICATE REQUEST', 'X509 CRL', 'PKCS7', 'PUBLIC KEY', 'RSA PUBLIC KEY', 'PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'DH PARAMETERS', 'EC PARAMETERS', 'SOMETHING ELSE'];
  for (let round = 0; round < 60; round++) {
    const noise = rand.bytes(rand.int(300));
    if (round % 2) {
      noise[0] = 0x30;
    }
    survive(noise, `noise ${noise.toString('hex')}`);
    for (const label of LABELS) {
      const file = survive(Buffer.from(armor(label, noise)), `noise as ${label}: ${noise.toString('hex')}`);
      assert.equal(file.blocks.length, 1);
    }
  }
});

test('a block with nothing in it, or only a BEGIN line, is listed as unreadable', () => {
  for (const text of ['-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n', '-----BEGIN CERTIFICATE-----\n', '-----BEGIN CERTIFICATE-----']) {
    const block = only(parseText(text));
    assert.ok(block.problems.length > 0, text);
    assert.equal(block.pem, undefined, text);
  }
});

// ---- Against openssl --------------------------------------------------------------

test('a certificate made on the spot reads as openssl x509 -text prints it', { skip: needs(openssl, 'openssl') }, () => {
  const [config, key, cert] = ['fresh.cnf', 'fresh.key', 'fresh.crt'].map((name) => path.join(dir, name));
  // Only what old versions and LibreSSL know as well: a configuration file instead of -addext.
  fs.writeFileSync(
    config,
    [
      '[req]', 'distinguished_name = dn', 'x509_extensions = v3', 'prompt = no',
      '[dn]', 'C = NL', 'O = Fresh Org', 'CN = fresh.example.test',
      '[v3]', 'basicConstraints = critical,CA:TRUE,pathlen:1', 'keyUsage = critical,digitalSignature,keyCertSign',
      'subjectAltName = DNS:fresh.example.test,DNS:*.fresh.example.test,IP:192.0.2.7,email:fresh@example.test', '',
    ].join('\n'),
  );
  run(openssl!, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
  run(openssl!, ['req', '-x509', '-new', '-key', key, '-config', config, '-sha256', '-days', '37', '-set_serial', '0x1234ABCD', '-out', cert]);
  const text = run(openssl!, ['x509', '-in', cert, '-noout', '-text', '-fingerprint', '-sha256']).toString();
  const field = (pattern: RegExp): string => {
    const match = pattern.exec(text);
    assert.ok(match, `${pattern} in\n${text}`);
    return match[1].trim();
  };

  const block = only(parseCertFile(fs.readFileSync(cert)));
  assert.deepEqual(block.problems, []);
  // Newer versions print "C = NL", older ones "C=NL".
  assert.equal(row(block, 'Subject', 'DN'), field(/^ {8}Subject: (.*)$/m).replace(/ = /g, '='));
  assert.equal(row(block, 'Issuer', 'DN'), field(/^ {8}Issuer: (.*)$/m).replace(/ = /g, '='));
  assert.equal(block.validity?.from, Date.parse(field(/Not Before: (.*)$/m)));
  assert.equal(block.validity?.to, Date.parse(field(/Not After : (.*)$/m)));
  assert.equal(block.validity!.to! - block.validity!.from!, 37 * 86400000);
  assert.equal(row(block, 'Certificate', 'Serial number'), `12:34:AB:CD (${field(/Serial Number: (\d+) \(0x1234abcd\)/i)})`);
  assert.equal(row(block, 'Certificate', 'SHA-256 fingerprint'), field(/sha256 Fingerprint=(.*)$/im).toUpperCase());
  assert.equal(row(block, 'Public key', 'Size'), `${field(/Public-Key: \((\d+) bit\b/)} bits`);
  assert.ok(row(block, 'Public key', 'Curve')!.includes(field(/ASN1 OID: (.*)$/m)));
  assert.equal(row(block, 'Usage', 'Certificate authority (critical)'), field(/CA:(TRUE|FALSE)/) === 'TRUE' ? 'Yes' : 'No');
  assert.equal(row(block, 'Usage', 'Path length')!.split(' ')[0], field(/pathlen:(\d+)/));
  const names = field(/Subject Alternative Name: *\n(.*)$/m).split(', ');
  const listed = (prefix: string) => names.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length));
  assert.deepEqual(row(block, 'Subject alternative names', 'DNS names')!.split('\n'), listed('DNS:'));
  assert.deepEqual(row(block, 'Subject alternative names', 'IP addresses')!.split('\n'), listed('IP Address:'));
  assert.deepEqual(row(block, 'Subject alternative names', 'Email addresses')!.split('\n'), listed('email:'));
  // Made with its own key a moment ago: self-signed, and checked.
  assert.equal(block.selfSigned, true);
  assert.equal(block.issuer?.checked, true);
  assert.deepEqual(block.tags, ['Root CA']);
});
