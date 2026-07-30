/** Hand-rolled minimal ZIP writer, test-only: builds a real, valid ZIP archive in memory (deflate via Node's zlib) so zip.ts's reader can be tested against genuine ZIP bytes without a fixture dependency. */
import { deflateRawSync } from 'node:zlib';

export interface ZipFixtureEntry {
  readonly name: string;
  readonly content: string;
  /** Force store (uncompressed) instead of deflate, to exercise that code path too. */
  readonly store?: boolean;
  /** Write this compression method value instead of the real one - test-only, for exercising the "unsupported method" error path. */
  readonly methodOverride?: number;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

export function buildTestZip(entries: readonly ZipFixtureEntry[]): ArrayBuffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const contentBuf = Buffer.from(entry.content, 'utf8');
    const compressed = entry.store ? contentBuf : deflateRawSync(contentBuf);
    const method = entry.methodOverride ?? (entry.store ? 0 : 8);

    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0), // flags
      u16(method),
      u16(0), // mod time
      u16(0), // mod date
      u32(0), // crc-32 (unchecked by the reader under test)
      u32(compressed.length),
      u32(contentBuf.length),
      u16(nameBuf.length),
      u16(0), // extra length
      nameBuf,
    ]);
    const localEntry = Buffer.concat([localHeader, compressed]);
    localParts.push(localEntry);

    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16(20), // version made by
      u16(20), // version needed
      u16(0), // flags
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(compressed.length),
      u32(contentBuf.length),
      u16(nameBuf.length),
      u16(0), // extra length
      u16(0), // comment length
      u16(0), // disk number start
      u16(0), // internal attrs
      u32(0), // external attrs
      u32(offset), // local header offset
      nameBuf,
    ]);
    centralParts.push(centralHeader);
    offset += localEntry.length;
  }

  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), // disk number
    u16(0), // disk with central dir
    u16(entries.length),
    u16(entries.length),
    u32(centralSection.length),
    u32(localSection.length), // central dir offset = end of local section
    u16(0), // comment length
  ]);

  const full = Buffer.concat([localSection, centralSection, eocd]);
  return full.buffer.slice(full.byteOffset, full.byteOffset + full.byteLength);
}
