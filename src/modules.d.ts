declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  export const gfm: TurndownService.Plugin;
}

// pako ships no types. Only what tiffDecode.ts uses to bound a Deflate strip is declared.
declare module 'pako' {
  class Inflate {
    constructor(options?: { raw?: boolean; chunkSize?: number });
    err: number;
    msg: string;
    onData(chunk: Uint8Array): void;
    onEnd(status: number): void;
    push(data: Uint8Array, final: boolean): boolean;
  }
  const pako: { Inflate: typeof Inflate; inflateRaw(input: Uint8Array): Uint8Array };
  export default pako;
}
