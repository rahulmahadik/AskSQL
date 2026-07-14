/**
 * Pure client + formatting logic (no DOM): SSE frame parsing across chunk
 * boundaries, cell formatting (NULL vs empty vs binary vs json), CSV export.
 */
import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/client.js';
import { formatCell, toCsv } from '../src/format.js';
import type { CellValue, ResultColumn } from '@asksql/core';

describe('SseParser', () => {
  it('parses complete frames', () => {
    const p = new SseParser();
    const events = p.push('data: {"type":"stage","stage":"llm"}\n\ndata: {"type":"done"}\n\n');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'stage', stage: 'llm' });
    expect(events[1]).toMatchObject({ type: 'done' });
  });

  it('handles a frame split across chunks', () => {
    const p = new SseParser();
    expect(p.push('data: {"type":"sq')).toHaveLength(0);
    expect(p.push('l","sql":"SELECT 1"}\n\n')).toMatchObject([{ type: 'sql', sql: 'SELECT 1' }]);
  });

  it('ignores heartbeat comment lines', () => {
    const p = new SseParser();
    const events = p.push(': ping\n\ndata: {"type":"done"}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('done');
  });

  it('skips malformed frames without throwing', () => {
    const p = new SseParser();
    const events = p.push('data: not json\n\ndata: {"type":"done"}\n\n');
    expect(events).toHaveLength(1);
  });
});

describe('formatCell', () => {
  it('NULL vs empty string are distinct', () => {
    expect(formatCell(null).kind).toBe('null');
    expect(formatCell(null).text).toBe('NULL');
    const empty = formatCell('');
    expect(empty.kind).toBe('null');
    expect(empty.text).toBe('(empty)');
  });
  it('binary renders size + hex title', () => {
    const cell = formatCell({ __binary: { bytes: 2048, hexPreview: 'deadbeef' } } as CellValue);
    expect(cell.kind).toBe('binary');
    expect(cell.text).toContain('2.0 KB');
    expect(cell.title).toContain('deadbeef');
  });
  it('json detected', () => {
    expect(formatCell('{"a":1}').kind).toBe('json');
    expect(formatCell('[1,2,3]').kind).toBe('json');
  });
  it('bigint string preserved verbatim', () => {
    expect(formatCell('999999999999').text).toBe('999999999999');
  });
});

describe('toCsv', () => {
  it('quotes fields with commas/quotes/newlines', () => {
    const cols: ResultColumn[] = [{ name: 'a', kind: 'text' }, { name: 'b', kind: 'text' }];
    const rows: CellValue[][] = [['hello, world', 'say "hi"'], ['line\nbreak', null]];
    const csv = toCsv(cols, rows);
    expect(csv).toContain('"hello, world"');
    expect(csv).toContain('"say ""hi"""');
    // NULL becomes an empty field; the multiline value stays quoted as one field.
    expect(csv).toContain('"line\nbreak",');
    expect(csv.endsWith('"line\nbreak",')).toBe(true);
  });
});
