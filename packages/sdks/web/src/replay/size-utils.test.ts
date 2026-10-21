import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_IMAGE_DATA_URI,
  shrinkDataUris,
  utf8ByteLength,
} from './size-utils';

const bigBase64 = (n: number) => 'A'.repeat(n);

describe('utf8ByteLength', () => {
  it.each([
    '',
    'plain ascii {"type":3}',
    'café üß',
    '€ 中文',
    'emoji 😀👍 end',
    JSON.stringify({ text: 'mixed é 😀 中' }),
  ])('matches TextEncoder for %j', (str) => {
    expect(utf8ByteLength(str)).toBe(new TextEncoder().encode(str).length);
  });
});

describe('shrinkDataUris', () => {
  it('replaces image data URIs with the placeholder and strips others', () => {
    const png = `data:image/png;base64,${bigBase64(5000)}`;
    const font = `data:font/woff2;base64,${bigBase64(5000)}`;
    const event = {
      type: 2,
      data: {
        node: {
          attributes: { src: png },
          childNodes: [
            {
              attributes: {
                _cssText: `@font-face{src:url("${font}")} .a{background:url(${png})}`,
              },
            },
          ],
        },
      },
    };
    const json = JSON.stringify(event);
    const out = shrinkDataUris(json);

    expect(out.length).toBeLessThan(json.length / 10);
    expect(out).not.toContain(bigBase64(100));
    // Still valid JSON with the same structure (the CSS case is JSON-escaped
    // as url(\"data:...\"), which must not break the string literal).
    const parsed = JSON.parse(out);
    expect(parsed.data.node.attributes.src).toBe(PLACEHOLDER_IMAGE_DATA_URI);
    expect(parsed.data.node.childNodes[0].attributes._cssText).toBe(
      `@font-face{src:url("")} .a{background:url(${PLACEHOLDER_IMAGE_DATA_URI})}`,
    );
  });

  it('handles mime parameters and svg+xml', () => {
    const svg = `data:image/svg+xml;charset=utf-8;base64,${bigBase64(2000)}`;
    const out = shrinkDataUris(JSON.stringify({ src: svg }));
    expect(JSON.parse(out)).toEqual({ src: PLACEHOLDER_IMAGE_DATA_URI });
  });

  it('stops at whitespace (srcset) and keeps small data URIs', () => {
    const small = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    const large = `data:image/png;base64,${bigBase64(3000)}`;
    const json = JSON.stringify({ srcset: `${large} 1x, ${small} 2x` });
    expect(JSON.parse(shrinkDataUris(json))).toEqual({
      srcset: `${PLACEHOLDER_IMAGE_DATA_URI} 1x, ${small} 2x`,
    });
  });

  it('returns the same string when there is nothing to shrink', () => {
    const json = JSON.stringify({
      type: 3,
      data: { source: 0, text: 'data: hi' },
    });
    expect(shrinkDataUris(json)).toBe(json);
  });
});
