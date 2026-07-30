/**
 * List the sheet names in an .xlsx workbook, in tab order.
 *
 * DuckDB's `excel` extension has no sheet-listing function (a still-open
 * upstream feature request: github.com/duckdb/duckdb-excel/issues/54) - only
 * `read_xlsx(file, sheet = 'name')` for a *known* name. So discovery happens
 * here instead: an .xlsx is a ZIP archive, and its sheet names live in
 * `xl/workbook.xml`'s `<sheet name="...">` entries.
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
    // workbook.xml declares a default namespace, so `querySelectorAll('sheet')`
    // (which only matches the null namespace) silently matches nothing against
    // a real file - getElementsByTagNameNS('*', ...) matches regardless.
    return [...doc.getElementsByTagNameNS('*', 'sheet')]
      .map((el) => el.getAttribute('name'))
      .filter((name): name is string => Boolean(name));
  } catch (err) {
    console.warn(`AskSQL: could not read sheet names from "${file.name}" - loading it as a single table instead`, err);
    return [];
  }
}
