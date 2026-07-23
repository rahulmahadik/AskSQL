import { describe, expect, it } from 'vitest';
import { extractImpossible, extractSql } from '../src/extract.js';

describe('extractSql fence language tags', () => {
  it('extracts SQL from a fence tagged with any dialect name', () => {
    for (const tag of ['sql', 'postgresql', 'postgres', 'mysql', 'oracle', 'plsql', 'SQL']) {
      const e = extractSql('Here:\n```' + tag + '\nSELECT 1 FROM dual\n```');
      expect(e?.sql, tag).toBe('SELECT 1 FROM dual');
    }
  });
  it('still rejects a non-SQL fenced block', () => {
    expect(extractSql('```python\nprint("hi")\n```')).toBeNull();
  });
});

// Inputs are verbatim model output captured from live runs against real databases.
describe('extractImpossible humanizing', () => {
  it('never leaks the internal sentinel word, even when repeated', () => {
    const out = extractImpossible('IMPOSSIBLE: IMPOSSIBLE: there is no revenue column in this schema')!;
    expect(out).not.toMatch(/IMPOSSIBLE/i);
    expect(out).toContain('revenue column');
  });

  it('collapses an off-topic refusal to one plain sentence', () => {
    const a = extractImpossible(
      'IMPOSSIBLE: The question cannot be answered as it is not related to the schema provided and does not request any data from the tables available.',
    );
    expect(a).toBe("That question isn't about the data in this database.");
  });

  it('rewrites stiff schema phrasing but keeps the specifics', () => {
    const out = extractImpossible(
      'IMPOSSIBLE: The schema does not contain any information about countries or their capitals.',
    )!;
    expect(out).toBe("This database doesn't have anything about countries or their capitals.");
  });

  it('keeps only the first line when the model rambles', () => {
    const out = extractImpossible('IMPOSSIBLE: no revenue column\nAlso you would need a joins table\n```sql')!;
    expect(out).toBe('No revenue column');
  });
});
