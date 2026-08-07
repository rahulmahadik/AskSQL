/**
 * Minimal ZIP reader (Central Directory + per-entry inflate), no dependency.
 * Backs xlsxSheets.ts and zip-upload support. `DecompressionStream('deflate-raw')`
 * is a standard Web API within the manifest's minimum_chrome_version 116 floor.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

export interface ZipEntry {
  readonly name: string;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

function findEndOfCentralDirectory(view: DataView): number {
  // The EOCD record starts within the last 65 557 bytes of the file; scan backward from there.
  const maxCommentLength = 65_535;
  const searchStart = Math.max(0, view.byteLength - 22 - maxCommentLength);
  for (let i = view.byteLength - 22; i >= searchStart; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new Error('Not a valid ZIP file (no end-of-central-directory record found).');
}

/** Every entry in a ZIP's central directory, in archive order. Throws for a non-ZIP or corrupt file. */
export function listZipEntries(buffer: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error('Malformed ZIP file (central directory entry signature mismatch).');
    }
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameBytes = new Uint8Array(buffer, offset + 46, nameLength);
    entries.push({
      name: decoder.decode(nameBytes),
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Decompressed bytes of one entry (store or deflate; other methods throw). */
export async function readZipEntryBytes(buffer: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(buffer);
  const { localHeaderOffset } = entry;
  if (view.getUint32(localHeaderOffset, true) !== LOCAL_FILE_SIGNATURE) {
    throw new Error('Malformed ZIP file (local file header signature mismatch).');
  }
  const nameLength = view.getUint16(localHeaderOffset + 26, true);
  const extraLength = view.getUint16(localHeaderOffset + 28, true);
  const dataStart = localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = new Uint8Array(buffer, dataStart, entry.compressedSize);

  if (entry.compressionMethod === 0) return compressed;
  if (entry.compressionMethod !== 8) {
    throw new Error(`Unsupported ZIP compression method (${entry.compressionMethod}) for "${entry.name}".`);
  }
  // jsdom has no Blob.prototype.stream, so this feeds the writer directly.
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  // Cancelling the read half errors this one; that is the size guard working, not a failure.
  void writer
    .write(compressed)
    .then(() => writer.close())
    .catch(() => {});

  // Read to the declared size and no further. Buffering the whole stream first would let an entry
  // that declares 1 KB and inflates to gigabytes exhaust memory before any size check could run.
  const mismatch = (): Error =>
    new Error(
      `"${entry.name}" does not decompress to its declared ${entry.uncompressedSize} bytes - refusing an archive that misdeclares its sizes.`,
    );
  const out = new Uint8Array(entry.uncompressedSize);
  const reader = ds.readable.getReader();
  let written = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (written + value.byteLength > out.byteLength) {
      await reader.cancel();
      throw mismatch();
    }
    out.set(value, written);
    written += value.byteLength;
  }
  if (written !== out.byteLength) throw mismatch();
  return out;
}
