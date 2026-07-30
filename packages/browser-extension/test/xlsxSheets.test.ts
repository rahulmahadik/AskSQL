// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { listXlsxSheets } from '../src/xlsxSheets.js';
import { buildTestZip } from './zipFixture.js';

const WORKBOOK_XML = (sheetNames: readonly string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${sheetNames.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n    ')}
  </sheets>
</workbook>`;

function xlsxFile(sheetNames: readonly string[]): File {
  const zip = buildTestZip([{ name: 'xl/workbook.xml', content: WORKBOOK_XML(sheetNames) }]);
  return new File([zip], 'workbook.xlsx');
}

describe('listXlsxSheets', () => {
  it('lists a single sheet', async () => {
    expect(await listXlsxSheets(xlsxFile(['Sheet1']))).toEqual(['Sheet1']);
  });

  it('lists multiple sheets in tab order', async () => {
    expect(await listXlsxSheets(xlsxFile(['Sheet1', 'Q1 Data', 'Summary']))).toEqual(['Sheet1', 'Q1 Data', 'Summary']);
  });

  it('returns [] for a file with no xl/workbook.xml entry (not a real .xlsx)', async () => {
    const zip = buildTestZip([{ name: 'random.txt', content: 'not a workbook' }]);
    expect(await listXlsxSheets(new File([zip], 'fake.xlsx'))).toEqual([]);
  });

  it('returns [] for a file that is not a ZIP at all, and warns why', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await listXlsxSheets(new File(['not a zip'], 'broken.xlsx'))).toEqual([]);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('broken.xlsx'), expect.anything());
    consoleWarn.mockRestore();
  });

  it('returns [] for malformed workbook.xml instead of throwing', async () => {
    const zip = buildTestZip([{ name: 'xl/workbook.xml', content: '<not-valid-xml' }]);
    expect(await listXlsxSheets(new File([zip], 'broken.xlsx'))).toEqual([]);
  });
});
