import { describe, expect, it } from 'vitest';
import { expandZipFile, isZipFile, type ZipLimits } from '../src/zipUpload.js';
import { buildTestZip } from './zipFixture.js';

function zipFile(entries: Parameters<typeof buildTestZip>[0]): File {
  return new File([buildTestZip(entries)], 'archive.zip');
}

describe('isZipFile', () => {
  it('matches .zip case-insensitively', () => {
    expect(isZipFile(new File([''], 'export.zip'))).toBe(true);
    expect(isZipFile(new File([''], 'export.ZIP'))).toBe(true);
  });

  it('does not match other extensions', () => {
    expect(isZipFile(new File([''], 'data.csv'))).toBe(false);
  });
});

describe('expandZipFile', () => {
  it('extracts every supported file and preserves content', async () => {
    const file = zipFile([
      { name: 'sales.csv', content: 'id,amount\n1,10\n' },
      { name: 'notes.sql', content: 'CREATE TABLE t (a INT);' },
    ]);
    const { files, skipped } = await expandZipFile(file);
    expect(files.map((f) => f.name).sort()).toEqual(['notes.sql', 'sales.csv']);
    expect(skipped).toEqual([]);
    const salesText = await files.find((f) => f.name === 'sales.csv')!.text();
    expect(salesText).toBe('id,amount\n1,10\n');
  });

  it('extracts every file type the upload picker accepts, so a zip is never more restrictive', async () => {
    const accepted = ['a.csv', 'b.tsv', 'c.json', 'd.ndjson', 'e.parquet', 'f.xlsx', 'g.sql'];
    const file = zipFile(accepted.map((name) => ({ name, content: 'x' })));
    const { files, skipped } = await expandZipFile(file);
    expect(files.map((f) => f.name).sort()).toEqual([...accepted].sort());
    expect(skipped).toEqual([]);
  });

  it('skips unsupported file types without failing the rest', async () => {
    const file = zipFile([
      { name: 'sales.csv', content: 'id\n1\n' },
      { name: 'README.md', content: '# notes' },
      { name: 'archive.tar', content: 'binary-ish' },
    ]);
    const { files, skipped } = await expandZipFile(file);
    expect(files.map((f) => f.name)).toEqual(['sales.csv']);
    expect(skipped).toEqual(['README.md', 'archive.tar']);
  });

  it('skips directory entries without listing them as skipped', async () => {
    const file = zipFile([
      { name: 'folder/', content: '' },
      { name: 'folder/sales.csv', content: 'id\n1\n' },
    ]);
    const { files, skipped } = await expandZipFile(file);
    expect(files.map((f) => f.name)).toEqual(['sales.csv']);
    expect(skipped).toEqual([]);
  });

  it('skips __MACOSX junk and hidden dotfiles', async () => {
    const file = zipFile([
      { name: '__MACOSX/._sales.csv', content: 'junk' },
      { name: '.DS_Store', content: 'junk' },
      { name: 'sales.csv', content: 'id\n1\n' },
    ]);
    const { files, skipped } = await expandZipFile(file);
    expect(files.map((f) => f.name)).toEqual(['sales.csv']);
    expect(skipped).toEqual(['__MACOSX/._sales.csv', '.DS_Store']);
  });

  it('strips the archive-internal path down to a basename', async () => {
    const file = zipFile([{ name: 'exports/2026/sales.csv', content: 'id\n1\n' }]);
    const { files } = await expandZipFile(file);
    expect(files[0]!.name).toBe('sales.csv');
  });

  it('returns an empty file list for a zip with nothing usable', async () => {
    const file = zipFile([{ name: 'README.md', content: '# notes' }]);
    const { files, skipped } = await expandZipFile(file);
    expect(files).toEqual([]);
    expect(skipped).toEqual(['README.md']);
  });

  it('skips a file with no extension at all', async () => {
    const file = zipFile([
      { name: 'LICENSE', content: 'MIT' },
      { name: 'sales.csv', content: 'id\n1\n' },
    ]);
    const { files, skipped } = await expandZipFile(file);
    expect(files.map((f) => f.name)).toEqual(['sales.csv']);
    expect(skipped).toEqual(['LICENSE']);
  });

  const tightLimits: ZipLimits = { maxEntries: 3, maxTotalUncompressedBytes: 1000, maxCompressionRatio: 5 };

  it('rejects a zip with more entries than the configured limit', async () => {
    const file = zipFile(
      Array.from({ length: 4 }, (_, i) => ({ name: `f${i}.csv`, content: 'x' })),
    );
    await expect(expandZipFile(file, tightLimits)).rejects.toThrow(/entries, over the 3 limit/);
  });

  it('rejects a zip whose declared uncompressed total exceeds the configured limit', async () => {
    const file = zipFile([{ name: 'big.csv', content: 'x'.repeat(2000), store: true }]);
    await expect(expandZipFile(file, tightLimits)).rejects.toThrow(/exceed the .* MB limit/);
  });

  it('rejects a single entry whose compression ratio looks like a zip bomb', async () => {
    // Highly repetitive content deflates far past a 5x ratio for real, without
    // needing to fabricate header values or allocate a genuinely huge fixture.
    const file = zipFile([{ name: 'bomb.csv', content: 'a'.repeat(100_000) }]);
    await expect(expandZipFile(file, tightLimits)).rejects.toThrow(/compression ratio/);
  });

  it('accepts a zip within all configured limits', async () => {
    const file = zipFile([{ name: 'sales.csv', content: 'id\n1\n' }]);
    const { files } = await expandZipFile(file, tightLimits);
    expect(files.map((f) => f.name)).toEqual(['sales.csv']);
  });
});
