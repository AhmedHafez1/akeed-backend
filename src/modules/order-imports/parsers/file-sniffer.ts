import { CFB } from 'xlsx';
import { ImportFileError } from './import-file.error';
import { inspectZipEntries } from './zip-guard';

/** The compound-file reader bundled with SheetJS; its typings declare `any`. */
const cfb = CFB as {
  read(data: Buffer, options: { type: 'buffer' }): { FullPaths: string[] };
};

export type SniffedFile = { kind: 'xlsx' } | { kind: 'text' };

const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY_ARCHIVE = [0x50, 0x4b, 0x05, 0x06];
const OLE2_HEADER = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Signatures of common binary files that are otherwise mostly printable. */
const BINARY_SIGNATURES: readonly number[][] = [
  [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF8
  [0x1f, 0x8b], // gzip
  [0x52, 0x61, 0x72, 0x21], // Rar!
  [0x37, 0x7a, 0xbc, 0xaf], // 7z
  [0x7b, 0x5c, 0x72, 0x74, 0x66], // {\rtf
];

const TEXT_SAMPLE_BYTES = 8192;

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return (
    bytes.length >= signature.length &&
    signature.every((value, index) => bytes[index] === value)
  );
}

function hasUtf16Bom(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff]);
}

/**
 * Text files contain no NUL bytes (outside UTF-16) and almost no C0 control
 * characters other than tab, line feed, carriage return and form feed.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  if (hasUtf16Bom(bytes)) return true;
  const sample = bytes.subarray(0, TEXT_SAMPLE_BYTES);
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0x00) return false;
    if (
      byte < 0x20 &&
      byte !== 0x09 &&
      byte !== 0x0a &&
      byte !== 0x0d &&
      byte !== 0x0c
    )
      controls++;
  }
  return controls <= sample.length / 100;
}

function classifyZip(
  bytes: Buffer,
  maxUncompressedBytes: number,
  checkDeadline: () => void,
): SniffedFile {
  const names = new Set(
    inspectZipEntries(bytes, maxUncompressedBytes, checkDeadline).map((name) =>
      name.replace(/\\/g, '/').toLowerCase(),
    ),
  );
  // Macros are refused whatever the extension says: an .xlsx renamed from
  // .xlsm still carries the VBA project.
  if ([...names].some((name) => name.endsWith('vbaproject.bin')))
    throw new ImportFileError('IMPORT_FILE_TYPE_UNSUPPORTED', 'macro_workbook');
  if (names.has('xl/workbook.xml')) return { kind: 'xlsx' };
  if (names.has('xl/workbook.bin'))
    throw new ImportFileError(
      'IMPORT_FILE_TYPE_UNSUPPORTED',
      'binary_workbook',
    );
  throw new ImportFileError('IMPORT_FILE_UNREADABLE', 'zip_without_workbook');
}

/**
 * An OLE2 compound file is either a legacy .xls or an encrypted OOXML package:
 * Excel wraps a password-protected .xlsx in OLE2 with these two streams.
 */
function classifyOle2(bytes: Buffer): never {
  let streams: string[];
  try {
    streams = cfb
      .read(bytes, { type: 'buffer' })
      .FullPaths.map((path) => path.toLowerCase());
  } catch {
    throw new ImportFileError('IMPORT_FILE_UNREADABLE', 'ole2_unknown');
  }
  const has = (name: string) => streams.some((path) => path.endsWith(name));
  if (has('/encryptioninfo') && has('/encryptedpackage'))
    throw new ImportFileError('IMPORT_FILE_PROTECTED', 'encrypted_package');
  if (has('/workbook') || has('/book'))
    throw new ImportFileError('IMPORT_FILE_TYPE_UNSUPPORTED', 'legacy_xls');
  throw new ImportFileError('IMPORT_FILE_UNREADABLE', 'ole2_unknown');
}

/**
 * Decides the format from the bytes alone. The file name and the client's
 * MIME type are never consulted: a .csv that is really a workbook is read as
 * one, and a renamed PDF is refused.
 */
export function sniffImportFile(
  bytes: Buffer,
  maxUncompressedBytes: number,
  checkDeadline: () => void,
): SniffedFile {
  if (bytes.length === 0)
    throw new ImportFileError('IMPORT_FILE_EMPTY', 'no_header');
  if (startsWith(bytes, ZIP_LOCAL_HEADER))
    return classifyZip(bytes, maxUncompressedBytes, checkDeadline);
  if (startsWith(bytes, ZIP_EMPTY_ARCHIVE))
    throw new ImportFileError('IMPORT_FILE_UNREADABLE', 'zip_without_workbook');
  if (startsWith(bytes, OLE2_HEADER)) classifyOle2(bytes);
  if (
    BINARY_SIGNATURES.some((signature) => startsWith(bytes, signature)) ||
    !looksLikeText(bytes)
  )
    throw new ImportFileError('IMPORT_FILE_UNREADABLE', 'binary_content');
  return { kind: 'text' };
}
