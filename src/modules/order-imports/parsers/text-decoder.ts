import { decode } from 'iconv-lite';
import type { TextEncoding } from './grid.types';

export interface DecodedText {
  text: string;
  encoding: TextEncoding;
}

/**
 * Decodes a text import in a fixed order:
 * 1. a byte-order mark (UTF-8, UTF-16 LE/BE), which is stripped;
 * 2. strict UTF-8, which fails on any invalid sequence;
 * 3. Windows-1256, the Arabic code page older Excel versions save CSV in.
 *
 * Windows-1256 maps every byte, so it always succeeds; strict UTF-8 must come
 * first or valid UTF-8 Arabic would be read as mojibake.
 */
export function decodeImportText(bytes: Buffer): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return {
      text: new TextDecoder('utf-8').decode(bytes.subarray(3)),
      encoding: 'utf-8',
    };
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return {
      text: decode(bytes.subarray(2), 'utf-16le'),
      encoding: 'utf-16le',
    };
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return {
      text: decode(bytes.subarray(2), 'utf-16be'),
      encoding: 'utf-16be',
    };
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      encoding: 'utf-8',
    };
  } catch {
    return { text: decode(bytes, 'windows-1256'), encoding: 'windows-1256' };
  }
}
