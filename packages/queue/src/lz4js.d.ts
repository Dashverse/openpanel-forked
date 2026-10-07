// Minimal ambient types for the pure-JS `lz4js` package (ships no .d.ts).
// We only use the self-describing LZ4 frame format (compress/decompress).
declare module 'lz4js' {
  export function compress(data: Uint8Array): Uint8Array;
  export function decompress(data: Uint8Array): Uint8Array;
}
