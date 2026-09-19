export const MAX_FILE_NAME_LENGTH = 150;

/**
 * C0/C1 controls, zero-width marks, bidi embeddings, overrides and isolates,
 * and the byte-order mark. A right-to-left override can make `evil.exe.csv`
 * read as `evil.vsc.exe`, so none of these survive into a stored name.
 */
const UNSAFE_CODE_POINTS: readonly [number, number][] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function isUnsafe(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return UNSAFE_CODE_POINTS.some(
    ([first, last]) => codePoint >= first && codePoint <= last,
  );
}

/**
 * The upload's name as it is stored and shown back (AC12): the last path
 * segment only, without control or bidi characters, NFC-normalized, trimmed
 * and at most 150 characters. It is display text; it is never used to build a
 * filesystem path.
 */
export function sanitizeImportFileName(original: string | undefined): string {
  const lastSegment = (original ?? '').split(/[\\/]/).pop() ?? '';
  const characters = Array.from(lastSegment.normalize('NFC')).filter(
    (character) => !isUnsafe(character),
  );
  const name = characters.slice(0, MAX_FILE_NAME_LENGTH).join('').trim();
  return name === '' || name === '.' || name === '..' ? 'upload' : name;
}
