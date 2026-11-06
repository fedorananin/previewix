import * as crypto from 'crypto';
import { domainToUnicode } from 'url';

export interface Row {
  label: string;
  value: string;
  /** Worth a copy button of its own. */
  copy?: boolean;
  /** Hex and other text for machines, set in the monospace font. */
  mono?: boolean;
}

export interface Section {
  title: string;
  rows: Row[];
  /** The page puts the status (valid, expired, time left) on top of this one; it depends on the clock. */
  validity?: boolean;
}

export interface Block {
  kind: 'certificate' | 'request' | 'private' | 'public' | 'crl' | 'other';
  /** What the block is. */
  type: string;
  /** Whose it is or what is in it. */
  title: string;
  /** Short facts shown next to the title. */
  tags: string[];
  /** Certificates and requests: the public key in a few words, such as `RSA 2048 bits`. */
  key?: string;
  sections: Section[];
  /** Neutral remarks, such as what is deliberately not shown. */
  notes: string[];
  /** The parts that couldn't be read. */
  problems: string[];
  /** Certificates: the validity period in milliseconds since the epoch; a time that couldn't be read is absent. */
  validity?: { from?: number; to?: number };
  /** Certificates: who issued it, with the block that holds the issuer when it is in this file. `checked` is whether the signature was verified with the issuer's key. */
  issuer?: { name: string; index?: number; checked?: boolean };
  selfSigned?: boolean;
  /** Other blocks this one belongs with: the private key of a certificate, the certificate of a key. */
  links: { label: string; index: number }[];
  /** The block as PEM. Never present for private keys. */
  pem?: string;
}

export interface CertFile {
  /** `PEM`, `DER`, or an empty string for a file that is neither. */
  format: string;
  /** Whether the file reads as text, which is when "Open source" has something to show. */
  text: boolean;
  blocks: Block[];
  /** How the certificates of the file relate, when there are several. */
  chain?: { state: 'ordered' | 'reversed' | 'mixed' | 'none'; text: string };
  notes: string[];
  /** Why there is nothing to show. */
  message?: string;
}

/** Files above this size are not certificates; the largest trust bundles are a few megabytes with their comments. */
export const MAX_BYTES = 16 * 1024 * 1024;
/** A page with more blocks than this would be useless anyway. */
const MAX_BLOCKS = 1000;

function attempt<T>(work: () => T, fallback: T): T {
  try {
    return work();
  } catch {
    return fallback;
  }
}

/** Runs the reader of one part; a damaged part is reported and leaves the rest of the block standing. */
function part<T>(problems: string[], what: string, work: () => T, fallback: T): T {
  try {
    return work();
  } catch {
    problems.push(`${what} couldn't be read.`);
    return fallback;
  }
}

// ---- DER ----------------------------------------------------------------------

/** One element: its identifier byte, where its content lies, and where the next element starts. */
interface Der {
  data: Buffer;
  tag: number;
  start: number;
  from: number;
  to: number;
  next: number;
  /** The length pointed past the end of what is there; the content is what remained. */
  cut: boolean;
}

const SEQUENCE = 0x30;
const SET = 0x31;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OCTET_STRING = 0x04;
const OID = 0x06;

function readDer(data: Buffer, at: number, limit = data.length, depth = 0): Der {
  if (at + 2 > limit) {
    throw new Error('truncated');
  }
  const tag = data[at];
  let p = at + 1;
  if ((tag & 0x1f) === 0x1f) {
    while (p < limit && data[p] & 0x80) {
      p++;
    }
    p++;
  }
  if (p >= limit) {
    throw new Error('truncated');
  }
  let length = data[p++];
  if (length === 0x80) {
    // BER, which PKCS #7 files may use: the content runs up to an end-of-contents marker.
    if (depth > 64) {
      throw new Error('nested too deep');
    }
    for (let q = p; ; ) {
      if (q + 2 > limit) {
        return { data, tag, start: at, from: p, to: limit, next: limit, cut: true };
      }
      if (data[q] === 0 && data[q + 1] === 0) {
        return { data, tag, start: at, from: p, to: q, next: q + 2, cut: false };
      }
      q = readDer(data, q, limit, depth + 1).next;
    }
  }
  if (length & 0x80) {
    const size = length & 0x7f;
    if (size > 6 || p + size > limit) {
      throw new Error('bad length');
    }
    length = data.readUIntBE(p, size);
    p += size;
  }
  const to = p + length;
  return to > limit ? { data, tag, start: at, from: p, to: limit, next: limit, cut: true } : { data, tag, start: at, from: p, to, next: to, cut: false };
}

/** The elements inside a constructed one, as far as they can be read. */
function kids(node: Der): Der[] {
  const list: Der[] = [];
  for (let at = node.from; at < node.to; ) {
    const child = attempt(() => readDer(node.data, at, node.to), undefined);
    if (!child) {
      break;
    }
    list.push(child);
    at = child.next;
  }
  return list;
}

function need(node: Der | undefined, tag?: number): Der {
  if (!node || (tag !== undefined && node.tag !== tag)) {
    throw new Error('unexpected structure');
  }
  return node;
}

const content = (node: Der) => node.data.subarray(node.from, node.to);
/** The element with its header, as it is hashed, signed and compared. */
const whole = (node: Der) => node.data.subarray(node.start, node.next);

function oidOf(node: Der): string {
  const bytes = content(need(node, OID));
  const arcs: number[] = [];
  let value = 0;
  for (const byte of bytes) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      if (!arcs.length) {
        const first = Math.min(2, Math.floor(value / 40));
        arcs.push(first, value - first * 40);
      } else {
        arcs.push(value);
      }
      value = 0;
    }
  }
  return arcs.join('.');
}

/** A small non-negative INTEGER; counters, versions and path lengths. */
function numberOf(node: Der): number {
  const bytes = content(need(node, INTEGER));
  if (!bytes.length || bytes.length > 6 || bytes[0] & 0x80) {
    throw new Error('not a small number');
  }
  return bytes.readUIntBE(0, bytes.length);
}

/** Size of a positive INTEGER in bits, which is what "a 2048-bit key" counts. */
function bitLength(node: Der): number {
  const bytes = content(need(node, INTEGER));
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) {
    i++;
  }
  return (bytes.length - i - 1) * 8 + (32 - Math.clz32(bytes[i] ?? 0));
}

/** The bytes of a BIT STRING without the count of unused bits in front. */
const bitsOf = (node: Der) => content(need(node, BIT_STRING)).subarray(1);

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex').toUpperCase();
/** `AB:CD:EF`, the way openssl and browsers print fingerprints and identifiers. */
const colons = (bytes: Uint8Array) => (hex(bytes).match(/../g) ?? []).join(':');

function stringOf(node: Der): string {
  const bytes = content(node);
  switch (node.tag) {
    case 0x0c: // UTF8String
      return bytes.toString('utf8');
    case 0x1e: // BMPString, UTF-16 big-endian
      return new TextDecoder('utf-16be').decode(bytes);
    case 0x1c: {
      // UniversalString, UTF-32 big-endian
      let text = '';
      for (let i = 0; i + 4 <= bytes.length; i += 4) {
        text += attempt(() => String.fromCodePoint(bytes.readUInt32BE(i)), '\ufffd');
      }
      return text;
    }
    case 0x12: // NumericString
    case 0x13: // PrintableString
    case 0x14: // TeletexString, in practice Latin-1
    case 0x16: // IA5String
    case 0x1a: // VisibleString
      return bytes.toString('latin1');
    default:
      return `#${hex(whole(node))}`;
  }
}

const isString = (node: Der) => [0x0c, 0x12, 0x13, 0x14, 0x16, 0x1a, 0x1c, 0x1e].includes(node.tag);

function toPem(label: string, der: Uint8Array): string {
  const lines = Buffer.from(der).toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// ---- Names of things ----------------------------------------------------------

/** Attributes of a distinguished name: the short name openssl prints, and a readable one. */
const ATTRIBUTES: Record<string, [string, string]> = {
  '2.5.4.3': ['CN', 'Common name'],
  '2.5.4.4': ['SN', 'Surname'],
  '2.5.4.5': ['serialNumber', 'Serial number'],
  '2.5.4.6': ['C', 'Country'],
  '2.5.4.7': ['L', 'Locality'],
  '2.5.4.8': ['ST', 'State or province'],
  '2.5.4.9': ['street', 'Street address'],
  '2.5.4.10': ['O', 'Organization'],
  '2.5.4.11': ['OU', 'Organizational unit'],
  '2.5.4.12': ['title', 'Title'],
  '2.5.4.13': ['description', 'Description'],
  '2.5.4.15': ['businessCategory', 'Business category'],
  '2.5.4.17': ['postalCode', 'Postal code'],
  '2.5.4.20': ['telephoneNumber', 'Telephone number'],
  '2.5.4.41': ['name', 'Name'],
  '2.5.4.42': ['GN', 'Given name'],
  '2.5.4.43': ['initials', 'Initials'],
  '2.5.4.44': ['generationQualifier', 'Generation qualifier'],
  '2.5.4.45': ['x500UniqueIdentifier', 'Unique identifier'],
  '2.5.4.46': ['dnQualifier', 'DN qualifier'],
  '2.5.4.65': ['pseudonym', 'Pseudonym'],
  '2.5.4.97': ['organizationIdentifier', 'Organization identifier'],
  '1.2.840.113549.1.9.1': ['emailAddress', 'Email address'],
  '1.2.840.113549.1.9.2': ['unstructuredName', 'Unstructured name'],
  '0.9.2342.19200300.100.1.1': ['UID', 'User ID'],
  '0.9.2342.19200300.100.1.25': ['DC', 'Domain component'],
  '1.3.6.1.4.1.311.60.2.1.1': ['jurisdictionL', 'Jurisdiction locality'],
  '1.3.6.1.4.1.311.60.2.1.2': ['jurisdictionST', 'Jurisdiction state or province'],
  '1.3.6.1.4.1.311.60.2.1.3': ['jurisdictionC', 'Jurisdiction country'],
};

/** Digests: the name to show and the one Node knows it by. */
const HASHES: Record<string, [string, string]> = {
  '1.2.840.113549.2.5': ['MD5', 'md5'],
  '1.3.14.3.2.26': ['SHA-1', 'sha1'],
  '2.16.840.1.101.3.4.2.1': ['SHA-256', 'sha256'],
  '2.16.840.1.101.3.4.2.2': ['SHA-384', 'sha384'],
  '2.16.840.1.101.3.4.2.3': ['SHA-512', 'sha512'],
  '2.16.840.1.101.3.4.2.4': ['SHA-224', 'sha224'],
};

/** Signature algorithms: name, the kind of key that makes them, and the digest for Node. */
const SIGNATURES: Record<string, [string, string, string?]> = {
  '1.2.840.113549.1.1.2': ['MD2 with RSA', 'rsa', 'md2'],
  '1.2.840.113549.1.1.4': ['MD5 with RSA', 'rsa', 'md5'],
  '1.2.840.113549.1.1.5': ['SHA-1 with RSA', 'rsa', 'sha1'],
  '1.3.14.3.2.29': ['SHA-1 with RSA', 'rsa', 'sha1'],
  '1.2.840.113549.1.1.14': ['SHA-224 with RSA', 'rsa', 'sha224'],
  '1.2.840.113549.1.1.11': ['SHA-256 with RSA', 'rsa', 'sha256'],
  '1.2.840.113549.1.1.12': ['SHA-384 with RSA', 'rsa', 'sha384'],
  '1.2.840.113549.1.1.13': ['SHA-512 with RSA', 'rsa', 'sha512'],
  '1.2.840.113549.1.1.10': ['RSASSA-PSS', 'pss'],
  '1.2.840.10045.4.1': ['ECDSA with SHA-1', 'ec', 'sha1'],
  '1.2.840.10045.4.3.1': ['ECDSA with SHA-224', 'ec', 'sha224'],
  '1.2.840.10045.4.3.2': ['ECDSA with SHA-256', 'ec', 'sha256'],
  '1.2.840.10045.4.3.3': ['ECDSA with SHA-384', 'ec', 'sha384'],
  '1.2.840.10045.4.3.4': ['ECDSA with SHA-512', 'ec', 'sha512'],
  '1.2.840.10040.4.3': ['DSA with SHA-1', 'dsa', 'sha1'],
  '2.16.840.1.101.3.4.3.1': ['DSA with SHA-224', 'dsa', 'sha224'],
  '2.16.840.1.101.3.4.3.2': ['DSA with SHA-256', 'dsa', 'sha256'],
  '1.3.101.112': ['Ed25519', 'ed25519'],
  '1.3.101.113': ['Ed448', 'ed448'],
  '1.2.643.2.2.3': ['GOST R 34.10-2001', 'gost'],
  '1.2.643.7.1.1.3.2': ['GOST R 34.10-2012 (256 bits)', 'gost'],
  '1.2.643.7.1.1.3.3': ['GOST R 34.10-2012 (512 bits)', 'gost'],
  '1.2.156.10197.1.501': ['SM2 with SM3', 'sm2'],
  '2.16.840.1.101.3.4.3.17': ['ML-DSA-44', 'ml-dsa'],
  '2.16.840.1.101.3.4.3.18': ['ML-DSA-65', 'ml-dsa'],
  '2.16.840.1.101.3.4.3.19': ['ML-DSA-87', 'ml-dsa'],
};

const RSA = '1.2.840.113549.1.1.1';
const RSA_PSS = '1.2.840.113549.1.1.10';
const EC = '1.2.840.10045.2.1';
const DSA = '1.2.840.10040.4.1';

/** Key algorithms that need no more than a name, with the size where the algorithm fixes it. */
const KEYS: Record<string, [string, number?]> = {
  '1.3.101.110': ['X25519', 256],
  '1.3.101.111': ['X448', 448],
  '1.3.101.112': ['Ed25519', 256],
  '1.3.101.113': ['Ed448', 456],
  '1.2.840.113549.1.3.1': ['Diffie-Hellman'],
  '1.2.840.10046.2.1': ['Diffie-Hellman (X9.42)'],
  '1.2.643.2.2.19': ['GOST R 34.10-2001', 256],
  '1.2.643.7.1.1.1.1': ['GOST R 34.10-2012', 256],
  '1.2.643.7.1.1.1.2': ['GOST R 34.10-2012', 512],
  '2.16.840.1.101.3.4.3.17': ['ML-DSA-44'],
  '2.16.840.1.101.3.4.3.18': ['ML-DSA-65'],
  '2.16.840.1.101.3.4.3.19': ['ML-DSA-87'],
  '2.16.840.1.101.3.4.4.1': ['ML-KEM-512'],
  '2.16.840.1.101.3.4.4.2': ['ML-KEM-768'],
  '2.16.840.1.101.3.4.4.3': ['ML-KEM-1024'],
};

/** Named curves: the short name, the name openssl uses when it differs, and the key size. */
const CURVES: Record<string, [string, string, number]> = {
  '1.2.840.10045.3.1.1': ['P-192', 'prime192v1', 192],
  '1.3.132.0.33': ['P-224', 'secp224r1', 224],
  '1.2.840.10045.3.1.7': ['P-256', 'prime256v1', 256],
  '1.3.132.0.34': ['P-384', 'secp384r1', 384],
  '1.3.132.0.35': ['P-521', 'secp521r1', 521],
  '1.3.132.0.10': ['secp256k1', '', 256],
  '1.3.36.3.3.2.8.1.1.7': ['brainpoolP256r1', '', 256],
  '1.3.36.3.3.2.8.1.1.11': ['brainpoolP384r1', '', 384],
  '1.3.36.3.3.2.8.1.1.13': ['brainpoolP512r1', '', 512],
  '1.2.156.10197.1.301': ['SM2', '', 256],
};

const KEY_USAGE = [
  'Digital signature',
  'Non-repudiation',
  'Key encipherment',
  'Data encipherment',
  'Key agreement',
  'Certificate signing',
  'CRL signing',
  'Encipher only',
  'Decipher only',
];

const PURPOSES: Record<string, string> = {
  '2.5.29.37.0': 'Any purpose',
  '1.3.6.1.5.5.7.3.1': 'TLS server authentication',
  '1.3.6.1.5.5.7.3.2': 'TLS client authentication',
  '1.3.6.1.5.5.7.3.3': 'Code signing',
  '1.3.6.1.5.5.7.3.4': 'Email protection',
  '1.3.6.1.5.5.7.3.5': 'IPsec end system',
  '1.3.6.1.5.5.7.3.6': 'IPsec tunnel',
  '1.3.6.1.5.5.7.3.7': 'IPsec user',
  '1.3.6.1.5.5.7.3.8': 'Time stamping',
  '1.3.6.1.5.5.7.3.9': 'OCSP signing',
  '1.3.6.1.5.5.7.3.17': 'IPsec IKE intermediate',
  '1.3.6.1.5.2.3.4': 'Kerberos client authentication',
  '1.3.6.1.5.2.3.5': 'Kerberos KDC',
  '1.3.6.1.4.1.311.10.3.1': 'Microsoft trust list signing',
  '1.3.6.1.4.1.311.10.3.3': 'Microsoft server gated crypto',
  '1.3.6.1.4.1.311.10.3.4': 'Microsoft encrypting file system',
  '1.3.6.1.4.1.311.10.3.12': 'Microsoft document signing',
  '1.3.6.1.4.1.311.20.2.2': 'Microsoft smart card logon',
  '1.3.6.1.4.1.311.2.1.21': 'Microsoft individual code signing',
  '1.3.6.1.4.1.311.2.1.22': 'Microsoft commercial code signing',
  '2.16.840.1.113730.4.1': 'Netscape server gated crypto',
  '1.3.6.1.4.1.11129.2.4.4': 'Certificate Transparency log signing',
};

const POLICIES: Record<string, string> = {
  '2.5.29.32.0': 'Any policy',
  '2.23.140.1.1': 'Extended validation',
  '2.23.140.1.2.1': 'Domain validated',
  '2.23.140.1.2.2': 'Organization validated',
  '2.23.140.1.2.3': 'Individual validated',
  '2.23.140.1.3': 'Extended validation code signing',
  '2.23.140.1.4.1': 'Code signing',
  '2.23.140.1.5.1.1': 'S/MIME mailbox validated (legacy)',
  '2.23.140.1.5.1.2': 'S/MIME mailbox validated (multipurpose)',
  '2.23.140.1.5.1.3': 'S/MIME mailbox validated (strict)',
};

const SUBJECT_ALT_NAME = '2.5.29.17';

const EXTENSIONS: Record<string, string> = {
  '2.5.29.9': 'Subject directory attributes',
  '2.5.29.14': 'Subject key identifier',
  '2.5.29.15': 'Key usage',
  '2.5.29.16': 'Private key usage period',
  [SUBJECT_ALT_NAME]: 'Subject alternative names',
  '2.5.29.18': 'Issuer alternative names',
  '2.5.29.19': 'Basic constraints',
  '2.5.29.20': 'CRL number',
  '2.5.29.21': 'Reason code',
  '2.5.29.24': 'Invalidity date',
  '2.5.29.27': 'Delta CRL indicator',
  '2.5.29.28': 'Issuing distribution point',
  '2.5.29.30': 'Name constraints',
  '2.5.29.31': 'CRL distribution points',
  '2.5.29.32': 'Certificate policies',
  '2.5.29.33': 'Policy mappings',
  '2.5.29.35': 'Authority key identifier',
  '2.5.29.36': 'Policy constraints',
  '2.5.29.37': 'Extended key usage',
  '2.5.29.46': 'Freshest CRL',
  '2.5.29.54': 'Inhibit any policy',
  '1.3.6.1.5.5.7.1.1': 'Authority information access',
  '1.3.6.1.5.5.7.1.3': 'Qualified certificate statements',
  '1.3.6.1.5.5.7.1.11': 'Subject information access',
  '1.3.6.1.5.5.7.1.12': 'Logotype',
  '1.3.6.1.5.5.7.1.24': 'TLS feature',
  '1.3.6.1.5.5.7.48.1.5': 'OCSP no check',
  '1.3.6.1.4.1.11129.2.4.2': 'Signed certificate timestamps',
  '1.3.6.1.4.1.11129.2.4.3': 'Precertificate poison',
  '1.3.6.1.4.1.311.20.2': 'Microsoft certificate template name',
  '1.3.6.1.4.1.311.21.1': 'Microsoft CA version',
  '1.3.6.1.4.1.311.21.2': 'Microsoft previous CA certificate hash',
  '1.3.6.1.4.1.311.21.7': 'Microsoft certificate template',
  '1.3.6.1.4.1.311.21.10': 'Microsoft application policies',
  '1.3.6.1.4.1.311.25.2': 'Microsoft security identifier',
  '2.16.840.1.113730.1.1': 'Netscape certificate type',
  '2.16.840.1.113730.1.13': 'Netscape comment',
  '1.2.840.113533.7.65.0': 'Entrust version information',
};

/** Ways a private key is locked when the scheme carries its parameters in its own name. */
const OLD_ENCRYPTION: Record<string, string> = {
  '1.2.840.113549.1.5.3': 'MD5 and DES',
  '1.2.840.113549.1.5.10': 'SHA-1 and DES',
  '1.2.840.113549.1.12.1.1': 'SHA-1 and 128-bit RC4',
  '1.2.840.113549.1.12.1.3': 'SHA-1 and Triple DES',
  '1.2.840.113549.1.12.1.6': 'SHA-1 and 40-bit RC2',
};

const CIPHERS: Record<string, string> = {
  '2.16.840.1.101.3.4.1.2': 'AES-128-CBC',
  '2.16.840.1.101.3.4.1.22': 'AES-192-CBC',
  '2.16.840.1.101.3.4.1.42': 'AES-256-CBC',
  '2.16.840.1.101.3.4.1.6': 'AES-128-GCM',
  '2.16.840.1.101.3.4.1.26': 'AES-192-GCM',
  '2.16.840.1.101.3.4.1.46': 'AES-256-GCM',
  '1.2.840.113549.3.7': 'Triple DES',
  '1.3.14.3.2.7': 'DES',
};

const HMACS: Record<string, string> = {
  '1.2.840.113549.2.7': 'HMAC-SHA-1',
  '1.2.840.113549.2.8': 'HMAC-SHA-224',
  '1.2.840.113549.2.9': 'HMAC-SHA-256',
  '1.2.840.113549.2.10': 'HMAC-SHA-384',
  '1.2.840.113549.2.11': 'HMAC-SHA-512',
};

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

// ---- Distinguished names ------------------------------------------------------

interface Name {
  /** Readable rows, one per attribute. */
  rows: Row[];
  /** The name on one line, in the order of the file, as `openssl x509 -nameopt oneline` writes it without spaces around `=`. */
  text: string;
  /** The first value of an attribute by its short name. */
  first(short: string): string | undefined;
  /** What two names are compared by. */
  raw: Buffer;
  key: string;
}

/** RFC 4514 escaping, so that a comma inside a value can't be taken for the end of it. */
function escapeDn(value: string): string {
  return value
    .replace(/[,+"\\<>;]/g, '\\$&')
    .replace(/^[ #]/, '\\$&')
    .replace(/ $/, '\\ ')
    .replace(/[\0-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function readName(node: Der): Name {
  const rows: Row[] = [];
  const values = new Map<string, string>();
  const text = kids(need(node, SEQUENCE))
    .map((rdn) =>
      kids(rdn)
        .map((pair) => {
          const [type, value] = kids(pair);
          const oid = oidOf(type);
          const [short, long] = ATTRIBUTES[oid] ?? [oid, oid];
          const string = stringOf(need(value));
          rows.push({ label: long, value: string });
          if (!values.has(short)) {
            values.set(short, string);
          }
          return `${short}=${escapeDn(string)}`;
        })
        .join(' + '),
    )
    .join(', ');
  // Two spellings of a name that differ only in case and spacing mean the same directory entry.
  const key = text.toLowerCase().replace(/\s+/g, ' ');
  return { rows, text, first: (short) => values.get(short), raw: Buffer.from(whole(node)), key };
}

const sameName = (a: Name, b: Name) => a.raw.equals(b.raw) || a.key === b.key;

function nameSection(title: string, name: Name): Section {
  return { title, rows: [...name.rows, { label: 'DN', value: name.text || '(empty)', copy: true, mono: true }] };
}

// ---- Times --------------------------------------------------------------------

interface Time {
  ms?: number;
  text: string;
}

function readTime(node: Der): Time {
  const raw = content(node).toString('latin1');
  // UTCTime has a two-digit year, GeneralizedTime four; seconds and a zone other than Z occur in old certificates.
  const m = (node.tag === 0x17 ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?(Z|[+-]\d{4})?$/ : /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?(?:[.,]\d+)?(Z|[+-]\d{4})?$/).exec(raw);
  if (!m || (node.tag !== 0x17 && node.tag !== 0x18)) {
    throw new Error('not a time');
  }
  let year = Number(m[1]);
  if (node.tag === 0x17) {
    year += year < 50 ? 2000 : 1900;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, Number(m[2]) - 1, Number(m[3]));
  date.setUTCHours(Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  let ms = date.getTime();
  if (m[7] && m[7] !== 'Z') {
    ms -= Number(`${m[7][0]}1`) * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(3))) * 60000;
  }
  if (Number.isNaN(ms)) {
    throw new Error('not a time');
  }
  return { ms, text: timeText(ms) };
}

const timeText = (ms: number) => `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;

/** The date RFC 5280 gives a certificate that has no end of life. */
const NO_EXPIRY = Date.UTC(9999, 11, 31, 23, 59, 59);

function lifetime(from: number, to: number): string {
  const days = Math.round((to - from) / 86400000);
  if (days < 2) {
    return plural(Math.round((to - from) / 3600000), 'hour');
  }
  return days < 731 ? plural(days, 'day') : `${plural(days, 'day')} (about ${Math.round((days / 365.25) * 10) / 10} years)`;
}

// ---- Keys and signatures ------------------------------------------------------

interface Algorithm {
  oid: string;
  params?: Der;
}

function readAlgorithm(node: Der): Algorithm {
  const [oid, params] = kids(need(node, SEQUENCE));
  return { oid: oidOf(oid), params };
}

function pssParams(params: Der | undefined): { hash: [string, string]; salt: number } {
  let hash = HASHES['1.3.14.3.2.26'];
  let salt = 20;
  for (const field of params ? kids(params) : []) {
    if (field.tag === 0xa0) {
      hash = HASHES[readAlgorithm(kids(field)[0]).oid] ?? hash;
    } else if (field.tag === 0xa2) {
      salt = numberOf(kids(field)[0]);
    }
  }
  return { hash, salt };
}

function signatureName(algorithm: Algorithm): string {
  const known = SIGNATURES[algorithm.oid];
  if (!known) {
    return algorithm.oid;
  }
  return known[1] === 'pss' ? attempt(() => `RSASSA-PSS with ${pssParams(algorithm.params).hash[0]}`, known[0]) : known[0];
}

/** A structure of three parts: what is signed, how, and the signature. Certificates, requests and CRLs all have this shape. */
interface Signed {
  body: Der;
  algorithm: Algorithm;
  signature: Buffer;
}

function readSigned(top: Der): Signed | undefined {
  const [body, algorithm, signature] = kids(top);
  return attempt(() => ({ body, algorithm: readAlgorithm(algorithm), signature: bitsOf(signature) }), undefined);
}

/**
 * Whether the key made the signature. `undefined` when this runtime can't tell: VS Code's crypto is BoringSSL,
 * which lacks some digests and curves that OpenSSL has.
 */
function verify(signed: Signed | undefined, spki: Buffer | undefined): boolean | undefined {
  if (!signed || !spki || signed.body.cut) {
    return undefined;
  }
  return attempt(() => {
    const known = SIGNATURES[signed.algorithm.oid];
    if (!known) {
      return undefined;
    }
    const [, family, hash] = known;
    if (!['rsa', 'pss', 'ec', 'dsa', 'ed25519', 'ed448'].includes(family)) {
      return undefined;
    }
    const key = crypto.createPublicKey({ key: plainRsa(spki), format: 'der', type: 'spki' });
    // A key of another kind can't have made it, and asking anyway would only throw.
    if (key.asymmetricKeyType !== (family === 'pss' ? 'rsa' : family)) {
      return false;
    }
    const data = whole(signed.body);
    if (family === 'pss') {
      const { hash: digest, salt } = pssParams(signed.algorithm.params);
      return crypto.verify(digest[1], data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: salt }, signed.signature);
    }
    return crypto.verify(hash ?? null, data, key, signed.signature);
  }, undefined);
}

/** The AlgorithmIdentifier of a plain RSA key, and the object identifier of an EC one, as they stand in a SubjectPublicKeyInfo. */
const RSA_HEADER = Buffer.from('300d06092a864886f70d0101010500', 'hex');
const EC_OID = Buffer.from('06072a8648ce3d0201', 'hex');

function wrap(tag: number, ...parts: Uint8Array[]): Buffer {
  const body = Buffer.concat(parts);
  const size = body.length < 0x80 ? [body.length] : body.length < 0x100 ? [0x81, body.length] : body.length < 0x10000 ? [0x82, body.length >> 8, body.length & 0xff] : [0x83, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...size]), body]);
}

/** A key marked as "for RSA-PSS only" is an RSA key all the same, and BoringSSL reads it only under the plain name. */
function plainRsa(spki: Buffer): Buffer {
  return attempt(() => {
    const [algorithm, key] = kids(readDer(spki, 0));
    return readAlgorithm(algorithm).oid === RSA_PSS ? wrap(SEQUENCE, RSA_HEADER, whole(key)) : spki;
  }, spki);
}

interface KeyFacts {
  /** `RSA 2048 bits`, `EC P-256`: the key in a few words. */
  summary: string;
  rows: Row[];
}

/** Describes a key from its algorithm identifier and, for RSA, its modulus and exponent. */
function keyFacts(algorithm: Algorithm, modulus?: Der, exponent?: Der): KeyFacts {
  const { oid, params } = algorithm;
  if (oid === RSA || oid === RSA_PSS) {
    const name = oid === RSA ? 'RSA' : 'RSA-PSS';
    const rows: Row[] = [{ label: 'Algorithm', value: name }];
    // A number that the end of the data cuts short has no size to speak of.
    const bits = modulus && !modulus.cut && attempt(() => bitLength(modulus), undefined);
    if (bits) {
      rows.push({ label: 'Size', value: `${bits} bits` });
    }
    const e = exponent && attempt(() => numberOf(exponent), undefined);
    if (e) {
      rows.push({ label: 'Exponent', value: String(e) });
    }
    return { summary: bits ? `${name} ${bits} bits` : name, rows };
  }
  if (oid === EC) {
    const rows: Row[] = [{ label: 'Algorithm', value: 'Elliptic curve (EC)' }];
    if (params?.tag !== OID) {
      rows.push({ label: 'Curve', value: 'Given by explicit parameters' });
      return { summary: 'EC', rows };
    }
    const curveOid = oidOf(params);
    const [short, other, bits] = CURVES[curveOid] ?? [curveOid, '', 0];
    rows.push({ label: 'Curve', value: other ? `${short} (${other})` : short });
    if (bits) {
      rows.push({ label: 'Size', value: `${bits} bits` });
    }
    return { summary: `EC ${short}`, rows };
  }
  if (oid === DSA) {
    const bits = attempt(() => bitLength(kids(need(params, SEQUENCE))[0]), 0);
    return { summary: bits ? `DSA ${bits} bits` : 'DSA', rows: [{ label: 'Algorithm', value: 'DSA' }, ...(bits ? [{ label: 'Size', value: `${bits} bits` }] : [])] };
  }
  const [name, bits] = KEYS[oid] ?? [oid];
  return { summary: name, rows: [{ label: 'Algorithm', value: name }, ...(bits ? [{ label: 'Size', value: `${bits} bits` }] : [])] };
}

/** SHA-256 over the SubjectPublicKeyInfo, which is the same for a certificate, its request and its private key. */
const keyHash = (spki: Uint8Array) => colons(crypto.createHash('sha256').update(spki).digest());
const KEY_HASH = 'Public key SHA-256';

function readPublicKey(spki: Der): KeyFacts {
  const [algorithmNode, key, more] = kids(need(spki, SEQUENCE));
  const algorithm = readAlgorithm(algorithmNode);
  if (need(key, BIT_STRING) && more) {
    throw new Error('not a public key');
  }
  let facts: KeyFacts;
  if (algorithm.oid === RSA || algorithm.oid === RSA_PSS) {
    const bytes = bitsOf(key);
    const [modulus, exponent] = attempt(() => kids(readDer(bytes, 0)), []);
    facts = keyFacts(algorithm, modulus, exponent);
  } else {
    facts = keyFacts(algorithm);
  }
  if (!spki.cut) {
    facts.rows.push({ label: KEY_HASH, value: keyHash(whole(spki)), copy: true, mono: true });
  }
  return facts;
}

// ---- Extensions ---------------------------------------------------------------

function ipText(bytes: Buffer): string {
  if (bytes.length === 4) {
    return bytes.join('.');
  }
  if (bytes.length === 16) {
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      groups.push(bytes.readUInt16BE(i).toString(16));
    }
    // The longest run of zero groups is written as "::", as RFC 5952 asks.
    let best = -1;
    let bestLength = 1;
    for (let i = 0; i < 8; i++) {
      let j = i;
      while (j < 8 && groups[j] === '0') {
        j++;
      }
      if (j - i > bestLength) {
        best = i;
        bestLength = j - i;
      }
    }
    return best < 0 ? groups.join(':') : `${groups.slice(0, best).join(':')}::${groups.slice(best + bestLength).join(':')}`;
  }
  // Name constraints give an address and a mask of the same length.
  if (bytes.length === 8 || bytes.length === 32) {
    const half = bytes.length / 2;
    const mask = bytes.subarray(half);
    const bits = [...mask].map((byte) => byte.toString(2).padStart(8, '0')).join('');
    const prefix = bits.indexOf('0') < 0 ? bits.length : bits.indexOf('0');
    return `${ipText(bytes.subarray(0, half))}/${bits.lastIndexOf('1') < prefix ? prefix : ipText(mask)}`;
  }
  return `#${hex(bytes)}`;
}

/** One GeneralName as the label of its group and its value. */
function generalName(node: Der): [string, string] {
  const bytes = content(node);
  switch (node.tag) {
    case 0x81:
      return ['Email addresses', bytes.toString('latin1')];
    case 0x82: {
      const name = bytes.toString('latin1');
      // An internationalised name is stored in its ASCII form; both are worth seeing.
      const unicode = /(^|\.)xn--/i.test(name) ? attempt(() => domainToUnicode(name), '') : '';
      return ['DNS names', unicode && unicode !== name ? `${name} (${unicode})` : name];
    }
    case 0x86:
      return ['URIs', bytes.toString('latin1')];
    case 0x87:
      return ['IP addresses', ipText(bytes)];
    case 0x88:
      return ['Registered IDs', oidOf({ ...node, tag: OID })];
    case 0xa4:
      return ['Directory names', readName(kids(node)[0]).text];
    case 0xa0: {
      const [type, wrapped] = kids(node);
      const oid = oidOf(type);
      const value = wrapped && kids(wrapped)[0];
      const text = value ? (isString(value) ? stringOf(value) : `#${hex(whole(value))}`) : '';
      // The name Windows logs a user on by.
      return oid === '1.3.6.1.4.1.311.20.2.3' ? ['User principal names', text] : ['Other names', `${oid}: ${text}`];
    }
    default:
      return ['Other names', `#${hex(whole(node))}`];
  }
}

function groupNames(nodes: Der[]): Row[] {
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const [label, value] = attempt(() => generalName(node), ['Other names', `#${hex(whole(node))}`]);
    groups.set(label, [...(groups.get(label) ?? []), value]);
  }
  return [...groups].map(([label, values]) => ({ label, value: values.join('\n'), copy: true }));
}

/** Every URI in a structure, wherever it sits: distribution points nest them four levels deep. */
function urisIn(node: Der, found: string[] = []): string[] {
  for (const child of kids(node)) {
    if (child.tag === 0x86) {
      found.push(content(child).toString('latin1'));
    } else if (child.tag & 0x20) {
      urisIn(child, found);
    }
  }
  return found;
}

interface ExtensionFacts {
  /** Subject alternative names, grouped by kind. */
  names: Row[];
  /** Key usage, extended key usage and basic constraints. */
  usage: Row[];
  /** Key identifiers. */
  ids: Row[];
  /** Everything else. */
  other: Row[];
  ca: boolean;
  /** Whether the certificate says anything about being a CA. */
  constrained?: boolean;
  namesCritical?: boolean;
  /** Key identifiers as hex, for matching certificates with their issuers. */
  ski?: string;
  aki?: string;
}

function readExtensions(list: Der | undefined, problems: string[]): ExtensionFacts {
  const facts: ExtensionFacts = { names: [], usage: [], ids: [], other: [], ca: false };
  for (const extension of list ? kids(list) : []) {
    let name = '';
    try {
      {
        const fields = kids(need(extension, SEQUENCE));
        const oid = oidOf(fields[0]);
        name = EXTENSIONS[oid] ?? oid;
        const critical = fields[1]?.tag === 0x01 && content(fields[1])[0] !== 0;
        const outer = need(fields[fields.length - 1], OCTET_STRING);
        const label = critical ? `${name} (critical)` : name;
        const bytes = content(outer);
        const value = () => readDer(bytes, 0);
        switch (oid) {
          case SUBJECT_ALT_NAME:
            facts.names.push(...groupNames(kids(value())));
            facts.namesCritical = critical;
            break;
          case '2.5.29.15': {
            const bits = bitsOf(value());
            const set = KEY_USAGE.filter((_, i) => (bits[i >> 3] ?? 0) & (0x80 >> (i & 7)));
            facts.usage.push({ label, value: set.join(', ') || 'None' });
            break;
          }
          case '2.5.29.37':
            facts.usage.push({ label, value: kids(value()).map((node) => PURPOSES[oidOf(node)] ?? oidOf(node)).join(', ') });
            break;
          case '2.5.29.19': {
            const inner = kids(value());
            facts.ca = inner[0]?.tag === 0x01 && content(inner[0])[0] !== 0;
            facts.constrained = true;
            const length = inner.find((node) => node.tag === INTEGER);
            facts.usage.push({ label: critical ? 'Certificate authority (critical)' : 'Certificate authority', value: facts.ca ? 'Yes' : 'No' });
            if (length) {
              const n = numberOf(length);
              facts.usage.push({ label: 'Path length', value: n === 0 ? '0 (can issue end-entity certificates only)' : `${n} (at most ${plural(n, 'more CA')} below it)` });
            }
            break;
          }
          case '2.5.29.14':
            facts.ski = hex(content(value()));
            facts.ids.push({ label: 'Subject key ID', value: colons(content(value())), copy: true, mono: true });
            break;
          case '2.5.29.35': {
            const id = kids(value()).find((node) => node.tag === 0x80);
            if (id) {
              facts.aki = hex(content(id));
              facts.ids.push({ label: 'Authority key ID', value: colons(content(id)), copy: true, mono: true });
            } else {
              facts.other.push({ label, value: 'Names the issuer and its serial number instead of a key' });
            }
            break;
          }
          case '2.5.29.18':
            facts.other.push({ label, value: groupNames(kids(value())).map((row) => row.value).join('\n') });
            break;
          case '2.5.29.31':
          case '2.5.29.46':
            facts.other.push({ label, value: urisIn(value()).join('\n') || 'Present' });
            break;
          case '1.3.6.1.5.5.7.1.1':
          case '1.3.6.1.5.5.7.1.11': {
            const methods: Record<string, string> = {
              '1.3.6.1.5.5.7.48.1': 'OCSP',
              '1.3.6.1.5.5.7.48.2': 'CA issuers',
              '1.3.6.1.5.5.7.48.3': 'Time stamping',
              '1.3.6.1.5.5.7.48.5': 'CA repository',
            };
            const lines = kids(value()).map((access) => {
              const [method, location] = kids(access);
              return `${methods[oidOf(method)] ?? oidOf(method)}: ${generalName(need(location))[1]}`;
            });
            facts.other.push({ label, value: lines.join('\n') });
            break;
          }
          case '2.5.29.32': {
            const lines = kids(value()).map((policy) => {
              const id = oidOf(kids(policy)[0]);
              const text = POLICIES[id] ? `${POLICIES[id]} (${id})` : id;
              // The practice statement of the CA, when the policy links to one.
              const links: string[] = [];
              (function find(node: Der) {
                for (const child of kids(node)) {
                  if (child.tag === 0x16) {
                    links.push(stringOf(child));
                  } else if (child.tag & 0x20) {
                    find(child);
                  }
                }
              })(policy);
              return [text, ...links].join(' · ');
            });
            facts.other.push({ label, value: lines.join('\n') });
            break;
          }
          case '2.5.29.30': {
            const lines = kids(value()).map((subtrees) => {
              const names = kids(subtrees).map((subtree) => {
                const [kind, text] = generalName(need(kids(subtree)[0]));
                return `${kind.replace(/ (names|addresses)$|s$/, '')} ${text}`;
              });
              return `${subtrees.tag === 0xa0 ? 'Permitted' : 'Excluded'}: ${names.join(', ')}`;
            });
            facts.other.push({ label, value: lines.join('\n') });
            break;
          }
          case '1.3.6.1.5.5.7.1.24': {
            const features = kids(value()).map((node) => {
              const n = numberOf(node);
              return n === 5 ? 'OCSP must-staple (status_request)' : n === 17 ? 'status_request_v2' : String(n);
            });
            facts.other.push({ label, value: features.join(', ') });
            break;
          }
          case '1.3.6.1.4.1.11129.2.4.2': {
            // A TLS-style list inside the octet string: a two-byte total, then entries with two-byte lengths.
            const data = content(value());
            let count = 0;
            for (let at = 2; at + 2 <= data.length; at += 2 + data.readUInt16BE(at)) {
              count++;
            }
            facts.other.push({ label, value: `${plural(count, 'timestamp')} from Certificate Transparency logs` });
            break;
          }
          case '2.5.29.54':
            facts.other.push({ label, value: String(numberOf(value())) });
            break;
          default: {
            // A value that is one plain string is shown; anything else is only named.
            const inner = attempt(value, undefined);
            const text = inner && isString(inner) && !inner.cut && inner.next === bytes.length ? stringOf(inner) : '';
            facts.other.push({ label, value: text || (bytes.length ? plural(bytes.length, 'byte') : 'Present') });
          }
        }
      }
    } catch {
      // The name is known when the damage is in the value.
      problems.push(name ? `The extension “${name}” couldn't be read.` : "An extension couldn't be read.");
    }
  }
  return facts;
}

// ---- What is given back as PEM ------------------------------------------------
//
// A block is handed to the page as PEM only when all of it was recognised as a structure that is public by
// its nature: a certificate, a request without secrets, a revocation list, a public key. "All of it" is the
// point. The readers below tolerate damage, so they read past what they don't understand, and a private key
// can sit under any label and inside any wrapping. Looking like a certificate at the start is therefore enough
// to describe a block, and never enough to give its bytes back.

/** Whether an element and everything constructed inside it is whole: no length runs past its parent, and no bytes are left between or behind the parts. */
function intact(node: Der, depth = 0): boolean {
  if (node.cut) {
    return false;
  }
  if (!(node.tag & 0x20)) {
    return true;
  }
  let at = node.from;
  while (depth < 32 && at < node.to) {
    const child = attempt(() => readDer(node.data, at, node.to), undefined);
    if (!child || !intact(child, depth + 1)) {
      return false;
    }
    at = child.next;
  }
  return at === node.to;
}

/** Whether the elements that are there have these tags, in this order. Fewer is fine, since a block may be cut; another one or one more is not. */
const startsLike = (nodes: Der[], tags: number[]) => nodes.length <= tags.length && nodes.every((node, i) => node.tag === tags[i]);

/** Whether the elements are taken, in order and each at most once, from the optional fields that may end a structure. A time counts as 0x17 in either form. */
function inOrder(nodes: Der[], allowed: number[]): boolean {
  let at = 0;
  return nodes.every((node) => {
    at = allowed.indexOf(node.tag === 0x18 ? 0x17 : node.tag, at) + 1;
    return at > 0;
  });
}

const isTime = (node: Der | undefined) => node?.tag === 0x17 || node?.tag === 0x18;

/** An AlgorithmIdentifier: an object identifier and at most one element of parameters. */
function isAlgorithm(node: Der | undefined): boolean {
  const fields = node?.tag === SEQUENCE ? kids(node) : [];
  return fields[0]?.tag === OID && fields.length <= 2;
}

/** A distinguished name: sets of pairs, each a type and a value that is text (or the bit string of a unique identifier). */
function isName(node: Der | undefined): boolean {
  return (
    node?.tag === SEQUENCE &&
    kids(node).every((rdn) => {
      const pairs = kids(rdn);
      return (
        rdn.tag === SET &&
        pairs.length > 0 &&
        pairs.every((pair) => {
          const [type, value, more] = kids(pair);
          return pair.tag === SEQUENCE && type?.tag === OID && !!value && !more && (isString(value) || value.tag === BIT_STRING);
        })
      );
    })
  );
}

/** A SubjectPublicKeyInfo: an algorithm and the key as a bit string, and nothing else. */
function isSpki(node: Der | undefined): boolean {
  const fields = node?.tag === SEQUENCE ? kids(node) : [];
  return fields.length === 2 && isAlgorithm(fields[0]) && fields[1].tag === BIT_STRING;
}

/** A list of extensions: each an identifier, the optional "critical" and the value as an octet string. */
function isExtensionList(node: Der | undefined): boolean {
  return (
    node?.tag === SEQUENCE &&
    kids(node).every((extension) => {
      const fields = kids(extension);
      const value = fields[fields.length - 1];
      return extension.tag === SEQUENCE && fields[0]?.tag === OID && value.tag === OCTET_STRING && (fields.length === 2 || (fields.length === 3 && fields[1].tag === 0x01));
    })
  );
}

/**
 * The two numbers of an RSA public key, as PKCS #1 writes them: an odd modulus of a size a key can have, and an odd
 * exponent that is small beside it. The private exponent is odd too, but as long as the modulus; public ones stay
 * under 256 bits (FIPS 186) and are 65537 in practice.
 */
function isRsaPublicKey(node: Der | undefined): boolean {
  if (node?.tag !== SEQUENCE || !intact(node)) {
    return false;
  }
  const [modulus, exponent, more] = kids(node);
  if (modulus?.tag !== INTEGER || exponent?.tag !== INTEGER || more) {
    return false;
  }
  const odd = (number: Der) => {
    const bytes = content(number);
    return bytes.length > 0 && !(bytes[0] & 0x80) && (bytes[bytes.length - 1] & 1) === 1;
  };
  return odd(modulus) && odd(exponent) && bitLength(modulus) >= 256 && bitLength(exponent) >= 2 && bitLength(exponent) <= Math.min(256, bitLength(modulus) / 2);
}

/** A validity period: two times. */
const isValidity = (node: Der | undefined) => node?.tag === SEQUENCE && kids(node).length === 2 && kids(node).every(isTime);

/** What is said of a block that is whole but not, in all its parts, what it is taken for. */
const notSound = (what: string) => `Not all of the ${what} has the form of one, so it is not offered as PEM.`;

// ---- Blocks -------------------------------------------------------------------

/** A block and the facts its relations to the other blocks are worked out from. None of the extra fields leave this module. */
interface Item {
  block: Block;
  cert?: { subject?: Name; issuer?: Name; ski?: string; aki?: string; signed?: Signed; spki?: Buffer; ca: boolean; fingerprint?: string };
  /** SHA-256 of the public key, for matching keys, requests and certificates. */
  keyHash?: string;
  /** The block could not be read as what its label says. */
  unread?: boolean;
}

function newBlock(kind: Block['kind'], type: string, title: string): Block {
  return { kind, type, title, tags: [], sections: [], notes: [], problems: [], links: [] };
}

const fingerprint = (algorithm: string, der: Uint8Array) => colons(crypto.createHash(algorithm).update(der).digest());

function readCertificate(der: Buffer): Item {
  const top = need(readDer(der, 0), SEQUENCE);
  const parts = kids(top);
  const tbs = need(parts[0], SEQUENCE);
  const fields = kids(tbs);
  // Version 1 certificates have no version field.
  const shift = fields[0]?.tag === 0xa0 ? 1 : 0;
  // A block is described as a certificate when it has the skeleton of one: a serial number and an algorithm, and every
  // further field that is there in its place. A field may be damaged inside, or missing at a cut; one of another kind
  // (the octet string of a private key, say) means that this is something else.
  need(fields[shift], INTEGER);
  need(kids(need(fields[shift + 1], SEQUENCE))[0], OID);
  if (
    !startsLike(parts, [SEQUENCE, SEQUENCE, BIT_STRING]) ||
    !startsLike(fields.slice(shift, shift + 6), [INTEGER, SEQUENCE, SEQUENCE, SEQUENCE, SEQUENCE, SEQUENCE]) ||
    !inOrder(fields.slice(shift + 6), [0x81, 0x82, 0xa3])
  ) {
    throw new Error('not a certificate');
  }

  const block = newBlock('certificate', 'Certificate', '');
  const { problems } = block;
  if (top.cut) {
    problems.push('The certificate is cut short. What is left of it is shown.');
  }

  const version = shift ? attempt(() => numberOf(kids(fields[0])[0]) + 1, 1) : 1;
  const signed = readSigned(top);
  const subject = part(problems, 'The subject', () => readName(need(fields[shift + 4])), undefined);
  const issuer = part(problems, 'The issuer', () => readName(need(fields[shift + 2])), undefined);
  const times = attempt(() => kids(need(fields[shift + 3], SEQUENCE)), []);
  const from = part(problems, 'The start of the validity period', () => readTime(need(times[0])), undefined);
  const to = part(problems, 'The end of the validity period', () => readTime(need(times[1])), undefined);
  const spki = fields[shift + 5];
  const key = part(problems, 'The public key', () => readPublicKey(need(spki)), undefined);
  const list = fields.find((field, i) => i > shift + 5 && field.tag === 0xa3);
  const extensions = readExtensions(list && kids(list)[0], problems);
  // The whole of it recognised, which is what its fingerprints and its PEM stand on (see "What is given back as PEM").
  const sound =
    intact(top) &&
    parts.length === 3 &&
    isAlgorithm(parts[1]) &&
    (!shift || (kids(fields[0]).length === 1 && kids(fields[0])[0].tag === INTEGER)) &&
    isAlgorithm(fields[shift + 1]) &&
    isName(fields[shift + 2]) &&
    isValidity(fields[shift + 3]) &&
    isName(fields[shift + 4]) &&
    isSpki(spki) &&
    (!list || (kids(list).length === 1 && isExtensionList(kids(list)[0])));

  block.title = subject?.first('CN') ?? subject?.first('O') ?? subject?.first('OU') ?? extensions.names[0]?.value.split('\n')[0] ?? subject?.text ?? '';
  block.title ||= '(no subject)';
  block.validity = { from: from?.ms, to: to?.ms };
  block.key = key?.summary;
  if (issuer) {
    block.issuer = { name: issuer.first('CN') ?? issuer.first('O') ?? issuer.first('OU') ?? (issuer.text || '(no name)') };
  }

  const { sections } = block;
  if (subject) {
    sections.push(nameSection('Subject', subject));
  }
  if (issuer) {
    sections.push(nameSection('Issuer', issuer));
  }
  const validity: Row[] = [];
  if (from) {
    validity.push({ label: 'Not before', value: from.text });
  }
  if (to) {
    validity.push({ label: 'Not after', value: to.ms === NO_EXPIRY ? `${to.text} (no expiry date)` : to.text });
  }
  if (from?.ms !== undefined && to?.ms !== undefined && to.ms !== NO_EXPIRY) {
    validity.push({ label: 'Lifetime', value: lifetime(from.ms, to.ms) });
  }
  sections.push({ title: 'Validity', rows: validity, validity: true });
  if (extensions.names.length) {
    sections.push({ title: `Subject alternative names${extensions.namesCritical ? ' (critical)' : ''}`, rows: extensions.names });
  }
  if (key) {
    sections.push({ title: 'Public key', rows: key.rows });
  }

  const details: Row[] = [];
  part(
    problems,
    'The serial number',
    () => {
      const bytes = content(need(fields[shift], INTEGER));
      // The leading zero only keeps the number positive.
      const digits = bytes.length > 1 && bytes[0] === 0 ? bytes.subarray(1) : bytes;
      let extra = bytes.length <= 8 && !(bytes[0] & 0x80) ? ` (${BigInt(`0x${hex(bytes) || '0'}`)})` : '';
      if (bytes[0] & 0x80) {
        // Not allowed, but some old roots have one. The bytes are what browsers show, the magnitude what openssl prints.
        const magnitude = ((1n << BigInt(bytes.length * 8)) - BigInt(`0x${hex(bytes)}`)).toString(16).toUpperCase();
        extra = ` (negative: -${colons(Buffer.from(magnitude.padStart(bytes.length * 2, '0'), 'hex'))})`;
      }
      details.push({ label: 'Serial number', value: `${colons(digits)}${extra}`, copy: true, mono: true });
    },
    undefined,
  );
  if (signed) {
    details.push({ label: 'Signature algorithm', value: signatureName(signed.algorithm) });
  } else {
    problems.push("The signature couldn't be read.");
  }
  details.push({ label: 'Version', value: String(version) });
  // A fingerprint is that of a whole certificate, so one that is cut or not all a certificate has none.
  const der256 = sound ? fingerprint('sha256', whole(top)) : undefined;
  if (der256) {
    details.push({ label: 'SHA-256 fingerprint', value: der256, copy: true, mono: true }, { label: 'SHA-1 fingerprint', value: fingerprint('sha1', whole(top)), copy: true, mono: true });
    block.pem = toPem('CERTIFICATE', whole(top));
  } else if (!top.cut) {
    problems.push(notSound('certificate'));
  }
  sections.push({ title: 'Certificate', rows: details });
  // Without basic constraints a certificate is not a CA; the answer is given either way, and first.
  const usage = extensions.constrained ? extensions.usage : [{ label: 'Certificate authority', value: 'No' }, ...extensions.usage];
  const rank = (row: Row) => ['Certificate authority', 'Path length', 'Key usage', 'Extended key usage'].findIndex((label) => row.label.startsWith(label));
  sections.push({ title: 'Usage', rows: usage.sort((a, b) => rank(a) - rank(b)) });
  if (extensions.ids.length) {
    sections.push({ title: 'Key identifiers', rows: extensions.ids });
  }
  if (extensions.other.length) {
    sections.push({ title: 'Other extensions', rows: extensions.other });
  }
  // The tail of a "TRUSTED CERTIFICATE" block, which openssl writes with -trustout.
  if (top.next < der.length && der[top.next] === SEQUENCE) {
    block.notes.push('The block also carries OpenSSL trust settings, which are not shown.');
  }

  return {
    block,
    cert: { subject, issuer, ski: extensions.ski, aki: extensions.aki, signed, spki: spki && !spki.cut ? Buffer.from(whole(spki)) : undefined, ca: extensions.ca, fingerprint: der256 },
    keyHash: spki && !spki.cut ? keyHash(whole(spki)) : undefined,
  };
}

const EXTENSION_REQUEST = ['1.2.840.113549.1.9.14', '1.3.6.1.4.1.311.2.1.14'];
const CHALLENGE_PASSWORD = '1.2.840.113549.1.9.7';
/** The attributes whose value is shown: those known to hold nothing that is between the requester and the CA. */
const REQUEST_ATTRIBUTES: Record<string, string> = {
  '1.2.840.113549.1.9.2': 'Unstructured name',
  '1.2.840.113549.1.9.8': 'Unstructured address',
  '1.3.6.1.4.1.311.13.2.2': 'Microsoft enrollment provider',
  '1.3.6.1.4.1.311.13.2.3': 'Microsoft OS version',
  '1.3.6.1.4.1.311.21.20': 'Microsoft client information',
  '1.3.6.1.4.1.311.20.2': 'Microsoft certificate template name',
};

/** A PKCS #10 certificate request. */
function readRequest(der: Buffer): Item {
  const top = need(readDer(der, 0), SEQUENCE);
  const parts = kids(top);
  const info = need(parts[0], SEQUENCE);
  const fields = kids(info);
  // The skeleton, as for a certificate: a version, a name made of sets, and what follows in its place.
  need(fields[0], INTEGER);
  if (!kids(need(fields[1], SEQUENCE)).every((rdn) => rdn.tag === SET) || !startsLike(parts, [SEQUENCE, SEQUENCE, BIT_STRING]) || !startsLike(fields, [INTEGER, SEQUENCE, SEQUENCE, 0xa0])) {
    throw new Error('not a request');
  }

  const block = newBlock('request', 'Certificate request', '');
  const { problems, sections } = block;
  if (top.cut) {
    problems.push('The request is cut short. What is left of it is shown.');
  }
  const signed = readSigned(top);
  const subject = part(problems, 'The subject', () => readName(fields[1]), undefined);
  const spki = fields[2];
  const key = part(problems, 'The public key', () => readPublicKey(need(spki)), undefined);

  let extensions: ExtensionFacts = { names: [], usage: [], ids: [], other: [], ca: false };
  const attributes: Row[] = [];
  // Why the request is not given back as PEM, when it isn't: the PEM is the whole request, with every attribute in it.
  let withheld = '';
  // Every attribute an identifier and a set of values, and the requested extensions a list of them.
  let sound = intact(top) && parts.length === 3 && isAlgorithm(parts[1]) && isName(fields[1]) && isSpki(fields[2]);
  for (const attribute of fields[3] ? kids(fields[3]) : []) {
    let oid = '';
    try {
      const [type, values, more] = kids(need(attribute, SEQUENCE));
      oid = oidOf(type);
      const value = need(kids(need(values, SET))[0]);
      sound &&= !more;
      if (EXTENSION_REQUEST.includes(oid)) {
        sound &&= isExtensionList(value);
        extensions = readExtensions(value, problems);
      } else if (oid === CHALLENGE_PASSWORD) {
        // A secret between the requester and the CA.
        attributes.push({ label: 'Challenge password', value: 'Present (not shown)' });
        withheld ||= 'The request carries a challenge password, so it is not offered as PEM: the password would be in it.';
      } else if (REQUEST_ATTRIBUTES[oid]) {
        attributes.push({ label: REQUEST_ATTRIBUTES[oid], value: isString(value) ? stringOf(value) : plural(value.next - value.start, 'byte') });
      } else {
        // What an attribute nobody here knows holds can't be told, so neither its value nor the request around it is passed on.
        attributes.push({ label: oid, value: `${plural(values.to - values.from, 'byte')} (not shown)` });
        withheld ||= 'The request has an attribute that is not known here. Its value is not shown, and the request is not offered as PEM.';
      }
    } catch {
      sound = false;
      problems.push(oid ? `The attribute ${REQUEST_ATTRIBUTES[oid] ?? oid} couldn't be read.` : "An attribute couldn't be read.");
    }
  }

  block.title = (subject?.first('CN') ?? subject?.first('O') ?? extensions.names[0]?.value.split('\n')[0] ?? subject?.text) || '(no subject)';
  block.key = key?.summary;
  if (subject) {
    sections.push(nameSection('Subject', subject));
  }
  if (extensions.names.length) {
    sections.push({ title: 'Subject alternative names', rows: extensions.names });
  }
  if (key) {
    sections.push({ title: 'Public key', rows: key.rows });
  }
  const details: Row[] = [];
  if (signed) {
    // A request is signed with the key it asks a certificate for, which proves the requester holds it.
    const valid = verify(signed, spki && !spki.cut ? Buffer.from(whole(spki)) : undefined);
    details.push(
      { label: 'Signature algorithm', value: signatureName(signed.algorithm) },
      { label: 'Signature', value: valid === undefined ? 'Not checked' : valid ? "Valid, made with the request's own key" : "Invalid: not made with the request's own key" },
    );
    if (valid === false) {
      problems.push("The signature doesn't match the key in the request.");
    }
  }
  if (sound && !withheld) {
    block.pem = toPem('CERTIFICATE REQUEST', whole(top));
  } else if (sound) {
    block.notes.push(withheld);
  } else if (!top.cut) {
    problems.push(notSound('request'));
  }
  sections.push({ title: 'Request', rows: details });
  const requested = [...extensions.usage, ...extensions.ids, ...extensions.other];
  if (requested.length) {
    sections.push({ title: 'Requested extensions', rows: requested });
  }
  if (attributes.length) {
    sections.push({ title: 'Attributes', rows: attributes });
  }
  return { block, keyHash: spki && !spki.cut ? keyHash(whole(spki)) : undefined };
}

/** A revocation list, in summary: whose it is, how fresh, and how many certificates it revokes. */
function readCrl(der: Buffer): Item {
  const top = need(readDer(der, 0), SEQUENCE);
  const parts = kids(top);
  const fields = kids(need(parts[0], SEQUENCE));
  const shift = fields[0]?.tag === INTEGER ? 1 : 0;
  // The skeleton: an algorithm, a name, the date of the list, and after it only what a list may end with.
  need(kids(need(fields[shift], SEQUENCE))[0], OID);
  if (
    !kids(need(fields[shift + 1], SEQUENCE)).every((rdn) => rdn.tag === SET) ||
    !startsLike(parts, [SEQUENCE, SEQUENCE, BIT_STRING]) ||
    !inOrder(fields.slice(shift + 2), [0x17, 0x17, SEQUENCE, 0xa0])
  ) {
    throw new Error('not a revocation list');
  }
  const issuer = readName(fields[shift + 1]);
  const block = newBlock('crl', 'Certificate revocation list', issuer.first('CN') ?? issuer.first('O') ?? (issuer.text || '(no name)'));
  const { problems } = block;
  const signed = readSigned(top);
  const details: Row[] = [];
  const thisUpdate = part(problems, 'The date of the list', () => readTime(need(fields[shift + 2])), undefined);
  if (thisUpdate) {
    details.push({ label: 'Issued', value: thisUpdate.text });
  }
  let at = shift + 3;
  if (fields[at]?.tag === 0x17 || fields[at]?.tag === 0x18) {
    const next = attempt(() => readTime(fields[at]), undefined);
    if (next) {
      details.push({ label: 'Next update', value: next.text });
    }
    at++;
  }
  const entries = fields[at]?.tag === SEQUENCE ? kids(fields[at]) : [];
  const revoked = entries.length;
  const last = fields[fields.length - 1];
  // All of it recognised: every revoked entry a serial number and a date, and the extensions a list of them.
  const sound =
    intact(top) &&
    parts.length === 3 &&
    isAlgorithm(parts[1]) &&
    isAlgorithm(fields[shift]) &&
    isName(fields[shift + 1]) &&
    isTime(fields[shift + 2]) &&
    entries.every((entry) => entry.tag === SEQUENCE && kids(entry)[0]?.tag === INTEGER && isTime(kids(entry)[1]) && (kids(entry).length === 2 || (kids(entry).length === 3 && isExtensionList(kids(entry)[2])))) &&
    (last.tag !== 0xa0 || (kids(last).length === 1 && isExtensionList(kids(last)[0])));
  details.push({ label: 'Revoked certificates', value: revoked.toLocaleString('en-US') });
  if (signed) {
    details.push({ label: 'Signature algorithm', value: signatureName(signed.algorithm) });
  }
  block.tags.push(`${revoked.toLocaleString('en-US')} revoked`);
  block.sections.push(nameSection('Issuer', issuer), { title: 'List', rows: details });
  block.notes.push('The revoked serial numbers are not listed here.');
  if (sound) {
    block.pem = toPem('X509 CRL', whole(top));
  } else {
    problems.push(top.cut ? 'The list is cut short. What is left of it is shown.' : notSound('list'));
  }
  return { block };
}

/** The certificates inside a PKCS #7 (`.p7b`) bundle, each as its own DER. */
function readPkcs7(der: Buffer): Buffer[] | string {
  const [type, wrapped] = kids(need(readDer(der, 0), SEQUENCE));
  const oid = oidOf(type);
  if (oid !== '1.2.840.113549.1.7.2') {
    const kinds: Record<string, string> = { '1.2.840.113549.1.7.1': 'plain data', '1.2.840.113549.1.7.3': 'encrypted (enveloped) data', '1.2.840.113549.1.7.6': 'encrypted data' };
    return kinds[oid] ?? oid;
  }
  const signedData = need(kids(need(wrapped, 0xa0))[0], SEQUENCE);
  const set = kids(signedData).find((node) => node.tag === 0xa0);
  return set ? kids(set).filter((node) => node.tag === SEQUENCE).map((node) => Buffer.from(whole(node))) : [];
}

// ---- Keys ---------------------------------------------------------------------

/** Appended to every private key block. */
const KEY_HIDDEN = 'The key itself is not shown and never leaves the extension.';

function publicKeyBlock(label: string, der: Buffer): Item {
  const block = newBlock('public', 'Public key', '');
  const top = readDer(der, 0);
  // A key is its bits, so one that is cut is not a key, and what is shown as a public key must be nothing but one:
  // a private key under this label starts the same way and goes on.
  let spki: Buffer;
  if (label === 'RSA PUBLIC KEY') {
    if (!isRsaPublicKey(top)) {
      throw new Error('not a public key');
    }
    // PKCS #1 holds the bare modulus and exponent; wrapped in the usual header, its hash is comparable with the others.
    spki = wrap(SEQUENCE, RSA_HEADER, wrap(BIT_STRING, Buffer.from([0]), whole(top)));
  } else {
    if (!intact(top) || !isSpki(top)) {
      throw new Error('not a public key');
    }
    spki = Buffer.from(whole(top));
  }
  const key = readDer(spki, 0);
  const [algorithm, bits] = kids(key);
  const { oid } = readAlgorithm(algorithm);
  if (oid === RSA || oid === RSA_PSS) {
    const inner = readDer(bitsOf(bits), 0);
    if (!isRsaPublicKey(inner) || inner.next !== inner.data.length) {
      throw new Error('not a public key');
    }
  }
  const facts = readPublicKey(key);
  block.title = facts.summary;
  block.sections.push({ title: 'Public key', rows: [{ label: 'Format', value: label === 'RSA PUBLIC KEY' ? 'PKCS #1 (RSA only)' : 'SubjectPublicKeyInfo' }, ...facts.rows] });
  // Given back as PEM when the algorithm is one whose keys are known here to be public keys in this form.
  if (oid === RSA || oid === RSA_PSS || oid === EC || oid === DSA || KEYS[oid]) {
    block.pem = toPem(label, whole(top));
  } else {
    block.notes.push('The algorithm of this key is not known here, so the key is not offered as PEM.');
  }
  return { block, keyHash: keyHash(spki) };
}

/** How an encrypted PKCS #8 key is locked: the cipher and the function that turns the password into its key. */
function encryptionText(algorithm: Algorithm): string {
  if (algorithm.oid !== '1.2.840.113549.1.5.13') {
    return OLD_ENCRYPTION[algorithm.oid] ?? algorithm.oid;
  }
  const [derivation, cipher] = kids(need(algorithm.params, SEQUENCE)).map(readAlgorithm);
  const parts = [CIPHERS[cipher.oid] ?? cipher.oid];
  const fields = derivation.params ? kids(derivation.params) : [];
  if (derivation.oid === '1.2.840.113549.1.5.12') {
    const prf = fields.find((field) => field.tag === SEQUENCE);
    const iterations = attempt(() => numberOf(fields[1]), 0);
    parts.push(`PBKDF2 with ${prf ? (HMACS[readAlgorithm(prf).oid] ?? readAlgorithm(prf).oid) : 'HMAC-SHA-1'}${iterations ? `, ${plural(iterations, 'iteration')}` : ''}`);
  } else if (derivation.oid === '1.3.6.1.4.1.11591.4.11') {
    const [n, r, p] = fields.slice(1, 4).map((field) => attempt(() => numberOf(field), 0));
    parts.push(`scrypt (N=${n}, r=${r}, p=${p})`);
  } else {
    parts.push(derivation.oid);
  }
  return parts.join(', ');
}

/** Reads a length-prefixed field of the OpenSSH key format. */
function sshString(data: Buffer, at: number): { value: Buffer; next: number } {
  const length = data.readUInt32BE(at);
  if (at + 4 + length > data.length) {
    throw new Error('truncated');
  }
  return { value: data.subarray(at + 4, at + 4 + length), next: at + 4 + length };
}

/**
 * An OpenSSH private key. Its header and the public key are stored in the clear, in front of the private part,
 * so the kind of key is known even when it is encrypted. Nothing past the public key is read.
 */
function readOpenSsh(data: Buffer, rows: Row[]): { summary: string; encrypted: boolean } {
  const magic = 'openssh-key-v1\0';
  if (data.toString('latin1', 0, magic.length) !== magic) {
    throw new Error('not an OpenSSH key');
  }
  const cipher = sshString(data, magic.length);
  const kdf = sshString(data, cipher.next);
  const options = sshString(data, kdf.next);
  const blob = sshString(data, options.next + 4);
  const type = sshString(blob.value, 0);
  const typeName = type.value.toString('latin1');
  let summary = typeName;
  if (typeName === 'ssh-rsa') {
    const exponent = sshString(blob.value, type.next);
    const modulus = sshString(blob.value, exponent.next).value;
    const digits = modulus[0] === 0 ? modulus.subarray(1) : modulus;
    summary = `RSA ${(digits.length - 1) * 8 + (32 - Math.clz32(digits[0] ?? 0))} bits`;
  } else if (typeName === 'ssh-ed25519') {
    summary = 'Ed25519';
  } else if (typeName.startsWith('ecdsa-sha2-nistp')) {
    summary = `EC P-${typeName.slice(16)}`;
  } else if (typeName === 'ssh-dss') {
    summary = 'DSA';
  }
  const cipherName = cipher.value.toString('latin1');
  const encrypted = cipherName !== 'none';
  rows.push(
    { label: 'Format', value: 'OpenSSH' },
    { label: 'Algorithm', value: `${summary} (${typeName})` },
    { label: 'Protection', value: encrypted ? `Encrypted with a passphrase (${cipherName}, ${kdf.value.toString('latin1')})` : 'Not encrypted' },
    // What `ssh-keygen -l` prints, and what servers log.
    { label: 'SSH fingerprint', value: `SHA256:${crypto.createHash('sha256').update(blob.value).digest('base64').replace(/=+$/, '')}`, copy: true, mono: true },
  );
  return { summary, encrypted };
}

/**
 * Describes a private key without showing any of it: the format, the algorithm and the size, and whether a
 * password protects it. Only the description is returned; the bytes stay in this function.
 */
function privateKeyBlock(label: string, der: Buffer, headers: Map<string, string>): Item {
  const block = newBlock('private', 'Private key', '');
  const rows: Row[] = [];
  let summary = '';
  let encrypted = false;
  /** How Node reads this encoding, when it can derive the public key from it. */
  let type: 'pkcs8' | 'pkcs1' | 'sec1' | undefined;
  /** The public key, where the private one spells it out. Built by hand so that it doesn't depend on what the runtime's crypto supports. */
  let spki: Buffer | undefined;
  /** The key is not whole, so what is read of it is said with that reservation and nothing is derived from it. */
  let damaged = false;

  if (label === 'OPENSSH PRIVATE KEY') {
    ({ summary, encrypted } = readOpenSsh(der, rows));
  } else if (headers.get('proc-type')?.includes('ENCRYPTED')) {
    // The pre-PKCS #8 way: the PEM header names the cipher and the body is ciphertext, so only the label tells the algorithm.
    encrypted = true;
    summary = label.replace(/ ?PRIVATE KEY$/, '') || 'Unknown algorithm';
    rows.push(
      { label: 'Format', value: 'Traditional OpenSSL, encrypted in the PEM layer' },
      { label: 'Algorithm', value: summary },
      { label: 'Protection', value: `Encrypted with a password (${headers.get('dek-info')?.split(',')[0] || 'unknown cipher'})` },
    );
  } else if (label === 'ENCRYPTED PRIVATE KEY') {
    encrypted = true;
    const top = need(readDer(der, 0), SEQUENCE);
    damaged = !intact(top);
    const [algorithm, data] = kids(top);
    need(data, OCTET_STRING);
    rows.push(
      { label: 'Format', value: 'PKCS #8, encrypted' },
      { label: 'Protection', value: `Encrypted with a password (${attempt(() => encryptionText(readAlgorithm(algorithm)), 'unknown scheme')})` },
    );
  } else {
    const top = need(readDer(der, 0), SEQUENCE);
    damaged = !intact(top);
    const fields = kids(top);
    need(fields[0], INTEGER);
    let facts: KeyFacts;
    let format: string;
    if (label === 'RSA PRIVATE KEY') {
      format = 'PKCS #1 (traditional RSA)';
      type = 'pkcs1';
      facts = keyFacts({ oid: RSA }, need(fields[1], INTEGER), fields[2]);
      if (fields[2]?.tag === INTEGER) {
        spki = wrap(SEQUENCE, RSA_HEADER, wrap(BIT_STRING, Buffer.from([0]), wrap(SEQUENCE, whole(fields[1]), whole(fields[2]))));
      }
    } else if (label === 'EC PRIVATE KEY') {
      format = 'SEC 1 (traditional EC)';
      type = 'sec1';
      need(fields[1], OCTET_STRING);
      const curve = fields.find((field) => field.tag === 0xa0);
      const point = fields.find((field) => field.tag === 0xa1);
      facts = keyFacts({ oid: EC, params: curve && kids(curve)[0] });
      if (curve && point) {
        spki = wrap(SEQUENCE, wrap(SEQUENCE, EC_OID, whole(kids(curve)[0])), whole(need(kids(point)[0], BIT_STRING)));
      }
    } else if (label === 'DSA PRIVATE KEY') {
      format = 'Traditional OpenSSL DSA';
      const bits = need(fields[1], INTEGER).cut ? 0 : bitLength(fields[1]);
      facts = { summary: bits ? `DSA ${bits} bits` : 'DSA', rows: [{ label: 'Algorithm', value: 'DSA' }, ...(bits ? [{ label: 'Size', value: `${bits} bits` }] : [])] };
    } else {
      format = 'PKCS #8';
      type = 'pkcs8';
      const algorithm = readAlgorithm(need(fields[1]));
      const inner = need(fields[2], OCTET_STRING);
      // RSA and EC keys carry their public half inside: the modulus and exponent that start an RSA key, the point at the end of an EC one.
      const key = [RSA, RSA_PSS, EC].includes(algorithm.oid) ? attempt(() => readDer(content(inner), 0), undefined) : undefined;
      const inside = key ? kids(key) : [];
      damaged ||= !!key && !(intact(key) && key.next === key.data.length);
      const rsa = algorithm.oid === EC ? [] : inside;
      const point = algorithm.oid === EC ? inside.find((field) => field.tag === 0xa1) : undefined;
      facts = keyFacts(algorithm, rsa[1], rsa[2]);
      if (rsa[1]?.tag === INTEGER && rsa[2]?.tag === INTEGER) {
        spki = wrap(SEQUENCE, whole(fields[1]), wrap(BIT_STRING, Buffer.from([0]), wrap(SEQUENCE, whole(rsa[1]), whole(rsa[2]))));
      } else if (point) {
        spki = attempt(() => wrap(SEQUENCE, whole(fields[1]), whole(need(kids(point)[0], BIT_STRING))), undefined);
      }
    }
    summary = facts.summary;
    rows.push({ label: 'Format', value: format }, ...facts.rows.filter((row) => row.label !== 'Exponent'), { label: 'Protection', value: 'Not encrypted' });
  }

  if (damaged) {
    block.problems.push('The key is cut short or damaged.');
    spki = undefined;
    type = undefined;
  }
  // For the other algorithms the public half is derived by Node. Either way only its hash is kept.
  const publicHash = spki
    ? keyHash(spki)
    : type &&
      attempt(() => {
        const key = crypto.createPublicKey(crypto.createPrivateKey({ key: der, format: 'der', type: type! }));
        return keyHash(key.export({ format: 'der', type: 'spki' }));
      }, undefined);
  if (publicHash) {
    rows.push({ label: KEY_HASH, value: publicHash, copy: true, mono: true });
  }
  block.title = summary || 'Algorithm hidden by the encryption';
  block.tags.push(encrypted ? 'Encrypted' : 'Not encrypted');
  block.sections.push({ title: 'Private key', rows });
  block.notes.push(KEY_HIDDEN);
  return { block, keyHash: publicHash };
}

function parametersBlock(label: string, der: Buffer): Item {
  const top = readDer(der, 0);
  const block = newBlock('other', 'Parameters', '');
  if (label === 'EC PARAMETERS') {
    block.type = 'Elliptic curve parameters';
    const facts = keyFacts({ oid: EC, params: top });
    block.title = facts.summary.replace(/^EC ?/, '') || 'Explicit parameters';
    block.sections.push({ title: 'Parameters', rows: facts.rows.slice(1) });
  } else {
    block.type = label.includes('DSA') ? 'DSA parameters' : 'Diffie-Hellman parameters';
    const bits = bitLength(need(kids(need(top, SEQUENCE))[0], INTEGER));
    block.title = `${bits} bits`;
    block.sections.push({ title: 'Parameters', rows: [{ label: 'Size of the prime', value: `${bits} bits` }] });
  }
  return { block };
}

/** A block that is named but not decoded. */
function plainBlock(kind: Block['kind'], type: string, title: string, note?: string): Item {
  const block = newBlock(kind, type, title);
  if (note) {
    block.notes.push(note);
  }
  return { block };
}

const CERTIFICATE_LABELS = ['CERTIFICATE', 'X509 CERTIFICATE', 'TRUSTED CERTIFICATE'];
const NOT_DECODED: Record<string, [string, string]> = {
  PKCS12: ['PKCS #12 archive', 'PKCS #12 files are protected by a password and are not opened here.'],
  'ATTRIBUTE CERTIFICATE': ['Attribute certificate', 'Attribute certificates are not decoded.'],
  'OCSP REQUEST': ['OCSP request', ''],
  'OCSP RESPONSE': ['OCSP response', ''],
  'SSL SESSION PARAMETERS': ['TLS session', 'A saved TLS session holds secrets, so nothing of it is shown.'],
  'PGP PUBLIC KEY BLOCK': ['PGP public key', 'PGP data is not decoded.'],
  'PGP MESSAGE': ['PGP message', 'PGP data is not decoded.'],
  'PGP SIGNATURE': ['PGP signature', 'PGP data is not decoded.'],
  'SSH2 PUBLIC KEY': ['SSH public key', ''],
};

/** Turns one block of the file into what the page shows. A block that breaks its reader is still listed, with what went wrong. */
function decodeBlock(label: string, der: Buffer, headers: Map<string, string>): Item[] {
  const secret = /PRIVATE|SECRET|STATIC KEY|SESSION/.test(label);
  try {
    if (!der.length) {
      throw new Error('empty');
    }
    if (CERTIFICATE_LABELS.includes(label)) {
      return [readCertificate(der)];
    }
    if (label === 'CERTIFICATE REQUEST' || label === 'NEW CERTIFICATE REQUEST') {
      return [readRequest(der)];
    }
    if (label === 'X509 CRL') {
      return [readCrl(der)];
    }
    if (label === 'PKCS7' || label === 'CMS') {
      const inside = readPkcs7(der);
      if (typeof inside === 'string') {
        return [plainBlock('other', 'PKCS #7 message', inside, 'Only PKCS #7 certificate bundles are decoded.')];
      }
      if (!inside.length) {
        return [plainBlock('other', 'PKCS #7 bundle', 'No certificates inside')];
      }
      return inside.flatMap((certificate) => decodeBlock('CERTIFICATE', certificate, headers));
    }
    if (label === 'PUBLIC KEY' || label === 'RSA PUBLIC KEY') {
      return [publicKeyBlock(label, der)];
    }
    if (/^(RSA |EC |DSA |ENCRYPTED |OPENSSH )?PRIVATE KEY$/.test(label)) {
      return [privateKeyBlock(label, der, headers)];
    }
    if (/^(X9\.42 )?DH PARAMETERS$|^(DSA|EC) PARAMETERS$/.test(label)) {
      return [parametersBlock(label, der)];
    }
    if (NOT_DECODED[label]) {
      return [plainBlock(secret ? 'private' : 'other', NOT_DECODED[label][0], '', NOT_DECODED[label][1])];
    }
  } catch {
    const item = plainBlock(secret ? 'private' : 'other', label === 'CERTIFICATE' ? 'Certificate' : `“${label}” block`, 'Unreadable');
    item.block.problems.push(`This block is labelled ${label}, but it couldn't be read as one: it is damaged or holds something else.`);
    if (secret) {
      item.block.notes.push(KEY_HIDDEN);
    }
    item.unread = true;
    return [item];
  }
  // An unknown label may well stand for a secret, so nothing but the label and the size is passed on.
  return [plainBlock(secret ? 'private' : 'other', secret ? 'Private key' : 'Unknown block', `“${label}”`, `${plural(der.length, 'byte')}, not decoded.`)];
}

/** What a DER file holds, told from its shape, since nothing labels it. The answer is the PEM label the same content would have. */
function guessLabel(data: Buffer): string | undefined {
  const top = attempt(() => readDer(data, 0), undefined);
  if (top?.tag !== SEQUENCE) {
    return undefined;
  }
  const parts = kids(top);
  const [first, second, third] = parts;
  const firstKids = first?.tag === SEQUENCE ? kids(first) : [];
  // A file that is cut is read with its last element ending where the file does, so a private key cut short can have
  // the shape of something smaller and public. The kinds that are told by their exact shape are told only when whole.
  const complete = intact(top);
  if (first?.tag === OID) {
    return 'PKCS7';
  }
  if (first?.tag === SEQUENCE && (parts.length === 1 || second?.tag === SEQUENCE) && firstKids.length > 1) {
    // The signed kind. A request starts with a version and a name; a certificate has an algorithm before its names,
    // and a CRL has dates where a certificate has its fourth sequence.
    const shift = firstKids[0].tag === 0xa0 ? 1 : 0;
    const afterNumber = firstKids[shift]?.tag === INTEGER ? firstKids[shift + 1] : undefined;
    if (afterNumber?.tag === SEQUENCE) {
      const inside = kids(afterNumber)[0]?.tag;
      if (inside === SET || (!shift && inside === undefined && firstKids[2]?.tag === SEQUENCE && (firstKids[3] === undefined || firstKids[3].tag === 0xa0))) {
        return 'CERTIFICATE REQUEST';
      }
      if (inside === OID) {
        const fourth = firstKids[shift + 3];
        // Without the version field in front, a version 1 certificate and a list begin alike: a number, an algorithm,
        // a name. A file that is cut before the fourth field can be either, and is not called one of them.
        return shift ? 'CERTIFICATE' : !fourth ? undefined : isTime(fourth) ? 'X509 CRL' : 'CERTIFICATE';
      }
    }
    if (firstKids[0].tag === SEQUENCE && kids(firstKids[0])[0]?.tag === OID && firstKids[1]?.tag === SEQUENCE && (firstKids[2]?.tag === 0x17 || firstKids[2]?.tag === 0x18)) {
      return 'X509 CRL';
    }
  }
  if (first?.tag === SEQUENCE && firstKids[0]?.tag === OID && parts.length === 2) {
    if (second.tag === BIT_STRING && complete) {
      return 'PUBLIC KEY';
    }
    if (second.tag === OCTET_STRING) {
      return 'ENCRYPTED PRIVATE KEY';
    }
  }
  if (first?.tag === INTEGER) {
    const version = attempt(() => numberOf(first), -1);
    if (second?.tag === SEQUENCE && kids(second)[0]?.tag === OID && version === 3) {
      return 'PKCS12';
    }
    // PKCS #8, also when the file ends before the key itself.
    if (second?.tag === SEQUENCE && kids(second)[0]?.tag === OID && (third ? third.tag === OCTET_STRING : !complete)) {
      return 'PRIVATE KEY';
    }
    if (second?.tag === OCTET_STRING) {
      return 'EC PRIVATE KEY';
    }
    if (parts.every((node) => node.tag === INTEGER)) {
      // The traditional private keys are runs of numbers behind a version: nine or more for RSA, six for DSA. So is
      // the start of one, which is what a cut file holds; there the third number tells them apart, the small public
      // exponent of RSA or the long q of DSA.
      if (version === 0 || version === 1) {
        if (complete) {
          return parts.length === 6 ? 'DSA PRIVATE KEY' : parts.length >= 9 ? 'RSA PRIVATE KEY' : undefined;
        }
        return third && third.to - third.from > 8 ? 'DSA PRIVATE KEY' : 'RSA PRIVATE KEY';
      }
      if (parts.length === 2 && complete) {
        // Two numbers are an RSA public key or Diffie-Hellman parameters; the generator of those is 2 or 5.
        return [2, 5].includes(attempt(() => numberOf(second), 0)) ? 'DH PARAMETERS' : 'RSA PUBLIC KEY';
      }
    }
  }
  return undefined;
}

// ---- The file -----------------------------------------------------------------

interface PemBlock {
  label: string;
  der: Buffer;
  headers: Map<string, string>;
  /** The END line is missing. */
  open: boolean;
}

function scanPem(text: string): PemBlock[] {
  const blocks: PemBlock[] = [];
  // A block runs to its END line, or, when that is missing, to the next BEGIN or the end of the file.
  const pattern = /-----BEGIN ([^-\r\n]{1,64}?)-----([^]*?)(-----END [^-\r\n]{0,64}-----|(?=-----BEGIN )|$)/g;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const headers = new Map<string, string>();
    // Certificates pasted into JSON or an environment variable carry their line breaks as "\n".
    const lines = m[2].replace(/\\[rn]/g, '\n').split(/\r?\n|\r/);
    let at = 0;
    while (at < lines.length && !lines[at].trim()) {
      at++;
    }
    // RFC 1421 headers ("Proc-Type: 4,ENCRYPTED") come first and end at an empty line. Base64 has no colon.
    for (; at < lines.length; at++) {
      const header = /^\s*([A-Za-z0-9-]+):\s*(.*)$/.exec(lines[at]);
      if (header) {
        headers.set(header[1].toLowerCase(), header[2].trim());
      } else if (!headers.size || !/^\s+\S/.test(lines[at])) {
        // Anything but the continuation of a long header ends them.
        break;
      }
    }
    // PGP armor ends with a checksum line that starts with "=".
    const base64 = lines
      .slice(at)
      .filter((line) => !/^=/.test(line))
      .join('')
      .replace(/[^A-Za-z0-9+/]/g, '');
    blocks.push({ label: m[1].trim().toUpperCase(), der: Buffer.from(base64, 'base64'), headers, open: !m[3] });
  }
  return blocks;
}

function looksLikeText(data: Buffer): boolean {
  const head = data.subarray(0, 4096);
  let odd = 0;
  for (const byte of head) {
    if (byte === 0) {
      return false;
    }
    if (byte < 9 || (byte > 13 && byte < 32)) {
      odd++;
    }
  }
  return odd * 20 <= head.length;
}

/** Works out who issued which certificate, which key belongs to what, and whether the certificates form a chain as they stand. */
function relate(items: Item[]): CertFile['chain'] {
  const label = (index: number) => `${index + 1}. ${items[index].block.title}`;

  // The same certificate twice is common in hand-made bundles.
  const seen = new Map<string, number>();
  items.forEach((item, index) => {
    const print = item.cert?.fingerprint;
    if (!print) {
      return;
    }
    const original = seen.get(print);
    if (original === undefined) {
      seen.set(print, index);
    } else {
      item.block.tags.push('Duplicate');
      item.block.links.push({ label: 'Same certificate as', index: original });
    }
  });

  const certs = items.map((item, index) => ({ ...item.cert, block: item.block, index })).filter((entry) => entry.subject || entry.issuer);
  for (const cert of certs) {
    const { block, issuer, subject } = cert;
    if (!issuer || !block.issuer) {
      continue;
    }
    if (subject && sameName(subject, issuer)) {
      const own = verify(cert.signed, cert.spki);
      // Without a check, a certificate that names itself and has no other candidate in the file is taken at its word.
      if (own !== false) {
        block.selfSigned = true;
        block.issuer.checked = own;
        continue;
      }
    }
    let unchecked: number | undefined;
    for (const candidate of certs) {
      if (candidate === cert || !candidate.subject || !sameName(candidate.subject, issuer) || (cert.fingerprint && candidate.fingerprint === cert.fingerprint)) {
        continue;
      }
      // Two CAs may share a name; the key identifiers tell them apart before any signature is checked.
      if (cert.aki && candidate.ski && cert.aki !== candidate.ski) {
        continue;
      }
      const signedBy = verify(cert.signed, candidate.spki);
      if (signedBy) {
        block.issuer.index = candidate.index;
        block.issuer.checked = true;
        break;
      }
      if (signedBy === undefined) {
        unchecked ??= candidate.index;
      }
    }
    if (block.issuer.index === undefined && unchecked !== undefined) {
      block.issuer.index = unchecked;
    }
  }
  for (const { block, ca } of certs) {
    if (block.selfSigned) {
      block.tags.unshift(ca ? 'Root CA' : 'Self-signed');
    } else if (ca) {
      block.tags.unshift('Intermediate CA');
    }
  }

  // Keys, requests and certificates that share a public key belong together.
  const byKey = new Map<string, number[]>();
  items.forEach((item, index) => {
    if (item.keyHash) {
      byKey.set(item.keyHash, [...(byKey.get(item.keyHash) ?? []), index]);
    }
  });
  const ROLES: Record<string, string> = { certificate: 'Certificate', request: 'Request', private: 'Private key', public: 'Public key' };
  for (const group of byKey.values()) {
    for (const index of group) {
      const { block } = items[index];
      const isKey = block.kind === 'private' || block.kind === 'public';
      for (const other of group) {
        const { kind } = items[other].block;
        // Certificates that share a key (a renewal, a cross-signed CA) are not each other's business here.
        if (other !== index && (block.kind !== 'certificate' || kind !== 'certificate')) {
          const key = kind === 'private' || kind === 'public';
          block.links.push({ label: kind === block.kind ? 'Same key as' : key ? ROLES[kind] : `${ROLES[kind]} ${isKey ? 'with this key' : 'with the same key'}`, index: other });
        }
      }
    }
  }

  if (certs.length < 2) {
    return undefined;
  }
  const count = plural(certs.length, 'certificate');
  const parent = new Map<number, number>();
  const children = new Map<number, number>();
  for (const { block, index } of certs) {
    if (block.issuer?.index !== undefined) {
      parent.set(index, block.issuer.index);
      children.set(block.issuer.index, (children.get(block.issuer.index) ?? 0) + 1);
    }
  }
  if (!parent.size) {
    const roots = certs.filter(({ block }) => block.selfSigned).length;
    return {
      state: 'none',
      text: `${count}, none of them issued by another one in this file${roots === certs.length ? ': a bundle of self-signed certificates, not a chain.' : roots ? ` (${roots} self-signed): a bundle, not a chain.` : ': not a chain.'}`,
    };
  }
  const leaves = certs.filter(({ index }) => !children.has(index));
  const single = parent.size === certs.length - 1 && leaves.length === 1 && [...children.values()].every((n) => n === 1);
  if (!single) {
    return { state: 'none', text: `${count} that don't form one chain: ${parent.size} of them ${parent.size === 1 ? 'is' : 'are'} issued by another certificate in this file.` };
  }
  const path = [leaves[0].index];
  while (parent.has(path[path.length - 1]) && path.length <= certs.length) {
    path.push(parent.get(path[path.length - 1])!);
  }
  const order = certs.map(({ index }) => index);
  const top = items[path[path.length - 1]].block;
  const unchecked = path.slice(0, -1).some((index) => !items[index].block.issuer?.checked);
  const tail =
    (top.selfSigned ? ` It ends at the self-signed “${top.title}”.` : ` It ends at “${top.title}”, whose issuer “${top.issuer?.name ?? ''}” is not in this file.`) +
    (unchecked ? ' Not every signature could be checked here; those links follow the names and key identifiers.' : '');
  if (path.every((index, i) => index === order[i])) {
    return { state: 'ordered', text: `${count} forming a chain in the order of the file: each one is issued by the next.${tail}` };
  }
  if (path.every((index, i) => index === order[order.length - 1 - i])) {
    return { state: 'reversed', text: `${count} forming a chain, but the file lists it from the top down. Servers expect the leaf first and every issuer after the certificate it issued.${tail}` };
  }
  return { state: 'mixed', text: `${count} forming a chain, but not in the order of the file. Leaf first, the order is ${path.map(label).join(' → ')}.${tail}` };
}

/** Reads a certificate file: PEM with any number of blocks, or one DER structure. Never throws. */
export function parseCertFile(bytes: Uint8Array): CertFile {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const file: CertFile = { format: '', text: true, blocks: [], notes: [] };
  if (!data.length) {
    file.message = 'The file is empty.';
    return file;
  }

  // PEM is ASCII, so Latin-1 reads it without loss. UTF-16 is what PowerShell's ">" writes, and what openssl then refuses.
  let text: string;
  const utf16 = (data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff) ? (data[0] === 0xff ? 'utf-16le' : 'utf-16be') : data.length > 8 && data[1] === 0 && data[3] === 0 && data[0] === 0x2d ? 'utf-16le' : '';
  if (utf16) {
    text = new TextDecoder(utf16).decode(data);
  } else {
    file.text = looksLikeText(data);
    text = data.toString('latin1');
  }

  let items: Item[] = [];
  let skipped = 0;
  if (text.includes('-----BEGIN ')) {
    file.format = 'PEM';
    const blocks = scanPem(text);
    for (const block of blocks) {
      if (items.length >= MAX_BLOCKS) {
        skipped++;
        continue;
      }
      const decoded = decodeBlock(block.label, block.der, block.headers);
      if ((block.label === 'PKCS7' || block.label === 'CMS') && decoded[0].block.kind === 'certificate') {
        decoded.forEach((item) => item.block.notes.push('From a PKCS #7 bundle in the file.'));
      }
      if (block.open) {
        decoded[0].block.problems.unshift('The block has no END line: the file is cut short or damaged.');
      }
      items.push(...decoded);
    }
    if (utf16) {
      file.notes.push('The file is encoded as UTF-16. OpenSSL and most servers read PEM only as plain ASCII, so they will reject it as it is.');
    }
  } else {
    let der: Buffer | undefined;
    let label: string | undefined;
    const top = data[0] === SEQUENCE ? attempt(() => readDer(data, 0), undefined) : undefined;
    // A text file may start with "0" too; then the length that follows almost never fits.
    if (top && (!top.cut || !file.text) && !utf16) {
      label = guessLabel(data);
      if (label) {
        der = data;
        file.format = 'DER';
        file.text = false;
      }
    }
    if (!label && file.text) {
      // Base64 of a DER structure, without the BEGIN and END lines.
      const bare = text.replace(/\s+/g, '');
      if (bare.length >= 16 && /^M[A-Za-z0-9+/]+=*$/.test(bare)) {
        der = Buffer.from(bare, 'base64');
        label = guessLabel(der);
        if (label) {
          file.format = 'Base64';
          file.notes.push('The file is Base64 without the BEGIN and END lines of PEM, which most tools need.');
        }
      }
    }
    if (der && label) {
      items = decodeBlock(label, der, new Map());
      // The label was only a guess: content that then isn't what it looked like is a file of no known kind,
      // unless it looked like a private key, which is worth saying even of a damaged one.
      if (items[0].unread && items[0].block.kind !== 'private') {
        items = [];
        file.format = '';
      } else if (items[0].unread) {
        items = [plainBlock('private', 'Private key', 'Cut short or damaged', KEY_HIDDEN)];
        items[0].block.problems.push('The file starts as a private key does, but it is cut short or damaged.');
      }
      if (label === 'PKCS7' && items[0]?.block.kind === 'certificate') {
        file.notes.push('The certificates come from a PKCS #7 bundle.');
      }
    }
  }

  if (!items.length) {
    file.notes = [];
    file.message = file.text
      ? 'No certificate, key or other PEM block was found in this file.'
      : 'This file is not a certificate, a certificate request, a key or a PKCS #7 bundle in DER form.';
    return file;
  }
  if (skipped) {
    file.notes.push(`Only the first ${MAX_BLOCKS.toLocaleString('en-US')} blocks are shown; ${skipped.toLocaleString('en-US')} more follow.`);
  }
  file.chain = relate(items);
  file.blocks = items.map((item) => item.block);
  return file;
}
