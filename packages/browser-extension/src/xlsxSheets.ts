/**
 * List the sheet names in an .xlsx workbook, in tab order. DuckDB's `excel`
 * extension has no sheet-listing function (github.com/duckdb/duckdb-excel/issues/54),
 * so the names come out of the ZIP archive's `xl/workbook.xml` entries.
 */
import { listZipEntries, readZipEntryBytes } from './zip.js';

const WORKBOOK_ENTRY = 'xl/workbook.xml';

/** Sheet names in tab order, or `[]` if the file isn't a readable .xlsx (never throws for a bad file). */
export async function listXlsxSheets(file: File): Promise<string[]> {
  try {
    const buffer = await file.arrayBuffer();
    const entries = listZipEntries(buffer);
    const workbookEntry = entries.find((e) => e.name === WORKBOOK_ENTRY);
    if (!workbookEntry) return [];
    const bytes = await readZipEntryBytes(buffer, workbookEntry);
    const xml = new TextDecoder('utf-8').decode(bytes);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) return [];
    // workbook.xml declares a default namespace, which `querySelectorAll('sheet')` never matches.
    return [...doc.getElementsByTagNameNS('*', 'sheet')]
      .map((el) => el.getAttribute('name'))
      .filter((name): name is string => Boolean(name));
  } catch (err) {
    console.warn(`AskSQL: could not read sheet names from "${file.name}" - loading it as a single table instead`, err);
    return [];
  }
}
