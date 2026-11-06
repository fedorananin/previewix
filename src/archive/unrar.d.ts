// The Emscripten module of UnRAR, which node-unrar-js ships without types of its own. See rar.ts.
declare module 'node-unrar-js/dist/js/unrar' {
  const createUnrar: (options: { wasmBinary: Uint8Array }) => Promise<unknown>;
  export default createUnrar;
}
