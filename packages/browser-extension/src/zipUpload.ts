/**
 * Expand an uploaded .zip into the data files inside it. Only recognized
 * formats are extracted - anything else (a README, a folder, an unrelated
 * file type) is silently skipped rather than failing the whole upload, since
 * a zip of "everything from this export" routinely has files AskSQL can't
 * use alongside the ones it can.
 */
import { listZipEntries, readZipEntryBytes, type ZipEntry } from './zip.js';

// Must stay in step with ACCEPTED_UPLOAD_EXTENSIONS in fileConnections.ts, or a
// file type the picker accepts would be silently dropped from inside a zip.
// `tsv` is read by the same read_csv_auto path as `csv` (DuckDB sniffs the delimiter).
const SUPPORTED_EXTENSIONS = new Set(['csv', 'tsv', 'json', 'ndjson', 'parquet', 'xlsx', 'sql']);

// A DuckDB-WASM instance shares the tab's memory, so an unbounded zip bomb
// (a tiny compressed file claiming to inflate to gigabytes) can crash the
// side panel. These defaults are generous for real data exports, not a bomb;
// exposed as overridable limits so tests don't need to allocate real gigabytes.
export interface ZipLimits {
  readonly maxEntries: number;
  readonly maxTotalUncompressedBytes: number;
  readonly maxCompressionRatio: number;
}
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxTotalUncompressedBytes: 500 * 1024 * 1024,
  maxCompressionRatio: 200,
};

function extensionOf(name: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1]!.toLowerCase() : null;
}

// Callers filter directory entries before this runs, so it only ever sees files.
function isEligible(entry: ZipEntry): boolean {
  if (entry.name.startsWith('__MACOSX/')) return false; // macOS zip junk
  const basename = entry.name.split('/').pop()!; // never empty: split() on any string returns >= 1 element
  if (basename.startsWith('.')) return false; // hidden file
  const ext = extensionOf(basename);
  return ext !== null && SUPPORTED_EXTENSIONS.has(ext);
}

export interface ZipExpansion {
  readonly files: readonly File[];
  /** Archive-internal paths that were present but not extracted (unsupported type, directory, junk). */
  readonly skipped: readonly string[];
}

export async function expandZipFile(zipFile: File, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ZipExpansion> {
  const buffer = await zipFile.arrayBuffer();
  const entries = listZipEntries(buffer);
  if (entries.length > limits.maxEntries) {
    throw new Error(`This zip has ${entries.length} entries, over the ${limits.maxEntries} limit.`);
  }

  const files: File[] = [];
  const skipped: string[] = [];
  let totalUncompressed = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue; // directories aren't "skipped", just not files
    if (!isEligible(entry)) {
      skipped.push(entry.name);
      continue;
    }
    // Checked against the *declared* sizes before touching the decompressor -
    // a real zip bomb is a tiny compressedSize claiming a huge uncompressedSize.
    if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio) {
      throw new Error(`"${entry.name}" has a suspiciously high compression ratio - refusing to extract it.`);
    }
    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > limits.maxTotalUncompressedBytes) {
      throw new Error(`This zip's contents exceed the ${limits.maxTotalUncompressedBytes / (1024 * 1024)} MB limit once extracted.`);
    }
    const bytes = await readZipEntryBytes(buffer, entry);
    const basename = entry.name.split('/').pop()!;
    // .slice() copies into a fresh, non-shared ArrayBuffer - readZipEntryBytes'
    // "stored" (uncompressed) path returns a view into the whole archive
    // buffer, not an isolated copy, so this also guards against a Blob
    // implementation reading past the entry's own bytes.
    files.push(new File([bytes.slice()], basename));
  }
  return { files, skipped };
}

export function isZipFile(file: File): boolean {
  return /\.zip$/i.test(file.name);
}
