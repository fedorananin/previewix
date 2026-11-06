/**
 * What Windows-1252 has in the 32 places where Latin-1 has control characters: the euro sign, curly quotes,
 * dashes, "œ". The five places the page leaves undefined keep their control character, as in every browser.
 */
const UPPER = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

/** Node.js 22.17 to 22.20 and 24.0, which VS Code 1.103 and some versions after it run on, read Windows-1252 as Latin-1. */
const broken = new TextDecoder('windows-1252').decode(Uint8Array.of(0x80)) !== '€';

export interface Decoder {
  decode(bytes?: Uint8Array, options?: { stream?: boolean }): string;
}

const windows1252: Decoder = {
  // One byte is one character, so a chunk can't end inside one and `stream` has nothing to keep.
  decode(bytes) {
    return bytes
      ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          .toString('latin1')
          .replace(/[\x80-\x9f]/g, (c) => UPPER[c.charCodeAt(0) - 0x80])
      : '';
  },
};

/**
 * `new TextDecoder(label, options)`, except that Windows-1252 (also under its other names: `latin1`,
 * `iso-8859-1`, `ascii`) is decoded here where the runtime gets it wrong. Throws for an unknown label, as the constructor does.
 */
export function textDecoder(label: string, options?: TextDecoderOptions): Decoder {
  const decoder = new TextDecoder(label, options);
  return broken && decoder.encoding === 'windows-1252' ? windows1252 : decoder;
}
