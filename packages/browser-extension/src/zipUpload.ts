/**
 * Expand an uploaded .zip into the data files inside it. Only recognized formats
 * are extracted; anything else is skipped rather than failing the whole upload.
 */
import { listZipEntries, readZipEntryBytes, type ZipEntry } from './zip.js';

// Must stay in step with ACCEPTED_UPLOAD_EXTENSIONS in fileConnections.ts.
// `tsv` is read by the same read_csv_auto path as `csv` (DuckDB sniffs the delimiter).
const SUPPORTED_EXTENSIONS = new Set(['csv', 'tsv', 'json', 'ndjson', 'parquet', 'xlsx', 'sql']);

// Zip-bomb caps - a DuckDB-WASM instance shares the tab's memory. Overridable for tests.
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
    // Checked against the *declared* sizes before touching the decompressor.
    if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio) {
      throw new Error(`"${entry.name}" has a suspiciously high compression ratio - refusing to extract it.`);
    }
    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > limits.maxTotalUncompressedBytes) {
      throw new Error(
        `This zip's contents exceed the ${limits.maxTotalUncompressedBytes / (1024 * 1024)} MB limit once extracted.`,
      );
    }
    const bytes = await readZipEntryBytes(buffer, entry);
    const basename = entry.name.split('/').pop()!;
    // .slice() copies into a fresh ArrayBuffer; the "stored" path returns a view into the archive.
    files.push(new File([bytes.slice()], basename));
  }
  return { files, skipped };
}

export function isZipFile(file: File): boolean {
  return /\.zip$/i.test(file.name);
}
