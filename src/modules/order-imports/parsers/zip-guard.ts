import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import { ImportFileError } from './import-file.error';

class UncompressedLimitReached extends Error {}

/**
 * Lists a ZIP package's entries while inflating every one of them, counting
 * the bytes actually produced.
 *
 * The sizes in ZIP headers are attacker-controlled, so they are never trusted:
 * the count comes from the inflater's output and reading stops the moment it
 * passes `maxUncompressedBytes`. A zip bomb is therefore refused after
 * inflating at most the cap plus one chunk, before any XLSX reader sees it.
 */
export function inspectZipEntries(
  bytes: Uint8Array,
  maxUncompressedBytes: number,
  checkDeadline: () => void,
): string[] {
  const names: string[] = [];
  let total = 0;
  let unfinished = 0;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file) => {
    names.push(file.name);
    unfinished++;
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      total += chunk.length;
      if (total > maxUncompressedBytes) throw new UncompressedLimitReached();
      if (final) unfinished--;
      checkDeadline();
    };
    file.start();
  };
  try {
    unzip.push(bytes, true);
  } catch (error) {
    if (error instanceof UncompressedLimitReached)
      throw new ImportFileError('IMPORT_FILE_UNREADABLE', 'uncompressed_limit');
    if (error instanceof ImportFileError) throw error;
    throw new ImportFileError('IMPORT_FILE_UNREADABLE', 'zip_corrupt');
  }
  // The streaming reader ends quietly on a truncated entry, so an upload cut
  // off mid-transfer is caught by the entry that never finished.
  if (unfinished !== 0 || names.length === 0)
    throw new ImportFileError('IMPORT_FILE_UNREADABLE', 'zip_corrupt');
  return names;
}
