// Size helpers for the replay recorder. Pure (no DOM, no rrweb) so they can
// be unit-tested in Node.

const NON_ASCII = /[\u0080-￿]/;

/**
 * Exact UTF-8 byte length of a string without allocating an encoded copy
 * (TextEncoder would allocate a buffer per event). rrweb JSON is almost all
 * ASCII, so the common case is one native regex scan + `.length`.
 */
export function utf8ByteLength(str: string): number {
  if (!NON_ASCII.test(str)) return str.length;
  let bytes = str.length;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) continue;
    if (code < 0x800) {
      bytes += 1;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      // Surrogate pair: 2 UTF-16 units encode to 4 bytes.
      i += 1;
      bytes += 2;
    } else {
      bytes += 2;
    }
  }
  return bytes;
}

/**
 * Tiny grey "image removed" SVG, the same placeholder PostHog uses
 * (sessionrecording-utils.ts `replacementImageURI`).
 */
export const PLACEHOLDER_IMAGE_DATA_URI =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiBmaWxsPSJibGFjayIvPgo8cGF0aCBkPSJNOCAwSDE2TDAgMTZWOEw4IDBaIiBmaWxsPSIjMkQyRDJEIi8+CjxwYXRoIGQ9Ik0xNiA4VjE2SDhMMTYgOFoiIGZpbGw9IiMyRDJEMkQiLz4KPC9zdmc+Cg==';

// Data URIs shorter than this are left alone: they cost almost nothing, and
// small inline icons are what makes a replay look right.
const MIN_DATA_URI_CHARS_TO_SHRINK = 1024;

// `data:<mime>[;param[=value]]*,<data>` inside JSON text. Same idea as
// PostHog's ensureMaxMessageSize regex, but the data part stops at `"`, `\`,
// quote, paren or whitespace. It runs on JSON.stringify output, where a CSS
// `url("data:...")` appears as `url(\"data:...\")`; PostHog's `[^)"]*` eats
// that backslash and the result is no longer valid JSON. Never consuming `"`
// or `\` keeps every match inside one JSON string literal, so the output
// always parses.
const DATA_URI_IN_JSON =
  /data:([\w.+-]+\/[\w.+-]+)((?:;[\w.+-]+(?:=[\w.+-]*)?)*),[^"'()\\\s]*/gi;

/**
 * Safety net for a single oversized rrweb event (PostHog's
 * ensureMaxMessageSize). Takes the event's JSON text and replaces image data
 * URIs with a small placeholder image and strips every other data URI (fonts,
 * etc.), which is almost always what makes a FullSnapshot huge. Base64
 * barely compresses, so this is the only thing that really shrinks such an
 * event. Returns the input unchanged when nothing matched.
 */
export function shrinkDataUris(json: string): string {
  return json.replace(DATA_URI_IN_JSON, (match: string, mime: string) => {
    if (match.length < MIN_DATA_URI_CHARS_TO_SHRINK) return match;
    return mime.toLowerCase().startsWith('image/')
      ? PLACEHOLDER_IMAGE_DATA_URI
      : '';
  });
}
