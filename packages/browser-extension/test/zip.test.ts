import { describe, expect, it } from 'vitest';
import { listZipEntries, readZipEntryBytes } from '../src/zip.js';
import { buildTestZip } from './zipFixture.js';

describe('listZipEntries', () => {
  it('lists entries in archive order', () => {
    const zip = buildTestZip([
      { name: 'a.txt', content: 'hello' },
      { name: 'sub/b.txt', content: 'world' },
    ]);
    const entries = listZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('reports the correct compression method for stored vs deflated entries', () => {
    const zip = buildTestZip([
      { name: 'stored.txt', content: 'x'.repeat(50), store: true },
      { name: 'deflated.txt', content: 'y'.repeat(50) },
    ]);
    const entries = listZipEntries(zip);
    expect(entries.find((e) => e.name === 'stored.txt')?.compressionMethod).toBe(0);
    expect(entries.find((e) => e.name === 'deflated.txt')?.compressionMethod).toBe(8);
  });

  it('throws for a buffer with no end-of-central-directory record', () => {
    expect(() => listZipEntries(new ArrayBuffer(10))).toThrow(/end-of-central-directory/);
  });

  it('throws when a central directory entry signature is corrupted', () => {
    const zip = buildTestZip([{ name: 'a.txt', content: 'x' }]);
    const corrupted = zip.slice(0);
    const view = new DataView(corrupted);
    const eocdOffset = corrupted.byteLength - 22;
    const centralDirOffset = view.getUint32(eocdOffset + 16, true);
    view.setUint32(centralDirOffset, 0, true);
    expect(() => listZipEntries(corrupted)).toThrow(/central directory entry signature mismatch/);
  });

  it('handles an empty archive', () => {
    expect(listZipEntries(buildTestZip([]))).toEqual([]);
  });

  it('finds the end-of-central-directory record even behind trailing bytes (e.g. an EOCD comment)', () => {
    const zip = buildTestZip([{ name: 'a.txt', content: 'x' }]);
    const padded = new Uint8Array(zip.byteLength + 5);
    padded.set(new Uint8Array(zip), 0);
    padded.set([1, 2, 3, 4, 5], zip.byteLength); // bytes after EOCD, as a real comment would add
    const entries = listZipEntries(padded.buffer);
    expect(entries.map((e) => e.name)).toEqual(['a.txt']);
  });
});

describe('readZipEntryBytes', () => {
  it('round-trips a deflated entry', async () => {
    const zip = buildTestZip([{ name: 'data.csv', content: 'id,name\n1,Ada\n' }]);
    const [entry] = listZipEntries(zip);
    const bytes = await readZipEntryBytes(zip, entry!);
    expect(new TextDecoder().decode(bytes)).toBe('id,name\n1,Ada\n');
  });

  it('round-trips a stored (uncompressed) entry', async () => {
    const zip = buildTestZip([{ name: 'data.csv', content: 'id,name\n1,Ada\n', store: true }]);
    const [entry] = listZipEntries(zip);
    const bytes = await readZipEntryBytes(zip, entry!);
    expect(new TextDecoder().decode(bytes)).toBe('id,name\n1,Ada\n');
  });

  it('reads the correct bytes for a later entry, not just the first', async () => {
    const zip = buildTestZip([
      { name: 'first.txt', content: 'FIRST' },
      { name: 'second.txt', content: 'SECOND' },
    ]);
    const entries = listZipEntries(zip);
    const second = entries.find((e) => e.name === 'second.txt')!;
    const bytes = await readZipEntryBytes(zip, second);
    expect(new TextDecoder().decode(bytes)).toBe('SECOND');
  });

  it('throws for an unsupported compression method', async () => {
    const zip = buildTestZip([{ name: 'a.txt', content: 'x', methodOverride: 99 }]);
    const [entry] = listZipEntries(zip);
    await expect(readZipEntryBytes(zip, entry!)).rejects.toThrow(/Unsupported ZIP compression method \(99\)/);
  });

  it('throws when the local file header signature is corrupted', async () => {
    const zip = buildTestZip([{ name: 'a.txt', content: 'x' }]);
    const [entry] = listZipEntries(zip);
    const corrupted = zip.slice(0);
    new DataView(corrupted).setUint32(entry!.localHeaderOffset, 0, true);
    await expect(readZipEntryBytes(corrupted, entry!)).rejects.toThrow(/local file header signature mismatch/);
  });

  it('refuses an entry whose actual decompressed size differs from the declared one (bomb guard floor)', async () => {
    const zip = buildTestZip([{ name: 'liar.csv', content: 'a,b\n1,2\n'.repeat(50) }]);
    const [entry] = listZipEntries(zip);
    await expect(readZipEntryBytes(zip, { ...entry!, uncompressedSize: 3 })).rejects.toThrow(/misdeclares/);
  });
});
