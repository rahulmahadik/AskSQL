/**
 * A reasoning model narrates before it answers. Reported from a real install on Groq's qwen3.6: the whole
 * "<think> The user wants to show me users. Looking at the schema..." monologue was shown to the reader as
 * the query's description, and through Explain, which never passes through extractSql at all.
 *
 * Mirrors packages/jetbrains/.../engine/ReasoningStripTest.kt.
 */
import { describe, expect, it } from 'vitest';
import { createReasoningFilter, extractSql, extractImpossible, withoutReasoning } from '../src/extract.js';

describe('a reasoning model never narrates at the reader', () => {
  it('drops a closed block and keeps the answer', () => {
    const reply =
      '<think>\nThe user wants a count. The clients table is right.\n</think>\n' +
      '```sql\nSELECT COUNT(*) FROM clients\n```\nCounts the clients.';
    const extracted = extractSql(reply)!;
    expect(extracted.sql).toBe('SELECT COUNT(*) FROM clients');
    expect(extracted.explanation).toBe('Counts the clients.');
    expect(extracted.explanation).not.toMatch(/<think|The user wants/i);
  });

  it('yields no query when the reply ran out mid-thought', () => {
    // Unclosed tag: the model was still reasoning when the tokens ran out, so there is no answer at all.
    expect(extractSql('<think>\nThe user wants users. Looking at the schema, there is a clients')).toBeNull();
  });

  it('matches the tag whatever it is called', () => {
    for (const tag of ['think', 'thinking', 'reasoning']) {
      expect(withoutReasoning(`<${tag}>hidden</${tag}> visible`), tag).toBe('visible');
    }
  });

  it('leaves a reply with no reasoning untouched', () => {
    const extracted = extractSql('```sql\nSELECT 1\n```\nPlain answer.')!;
    expect(extracted.sql).toBe('SELECT 1');
    expect(extracted.explanation).toBe('Plain answer.');
  });

  it('reads an IMPOSSIBLE verdict past the narration', () => {
    expect(extractImpossible('<think>\nNo such table.\n</think>\nIMPOSSIBLE: there is no orders table')).toMatch(
      /no orders table/i,
    );
  });

  it('keeps a mention of thinking that is not a tag', () => {
    expect(withoutReasoning('I was thinking about the clients table')).toBe('I was thinking about the clients table');
  });
});

describe('a think tag inside the answer is content, not narration', () => {
  // Unanchored, the strip truncated `WHERE body LIKE '%<think>%'` to an unterminated literal that the
  // guard then rejected, so a question about log or prompt data was unanswerable with no signal.
  it('keeps a literal tag in the SQL', () => {
    const reply = "```sql\nSELECT id FROM messages WHERE body LIKE '%<think>%'\n```\nFinds them.";
    expect(extractSql(reply)!.sql).toBe("SELECT id FROM messages WHERE body LIKE '%<think>%'");
  });

  it('keeps a literal tag in the explanation', () => {
    expect(withoutReasoning('Rows whose body has a <think> marker, left by the importer.')).toBe(
      'Rows whose body has a <think> marker, left by the importer.',
    );
  });
});

describe('the token stream hides narration as it arrives', () => {
  // The whole-text strip runs on the assembled reply, so a streaming host forwarded the monologue to
  // viewers live and only cleaned it up at the end.
  const run = (chunks: string[]): string => {
    const filter = createReasoningFilter();
    return chunks.map((c) => filter(c)).join('');
  };

  it('drops a block whose tags are split across chunks', () => {
    expect(run(['<thi', 'nk>The user wa', 'nts a count.</thi', 'nk>SELECT ', '1'])).toBe('SELECT 1');
  });

  it('passes a stream with no narration through untouched', () => {
    expect(run(['SELECT ', '1'])).toBe('SELECT 1');
  });

  it('emits nothing when the reply never stops narrating', () => {
    expect(run(['<think>still going'])).toBe('');
  });

  it('keeps a tag that arrives after the answer has started', () => {
    expect(run(["WHERE body LIKE '%", '<think>', "%'"])).toBe("WHERE body LIKE '%<think>%'");
  });

  it('allows whitespace before the opening tag', () => {
    expect(run(['\n  ', '<think>x</think>', 'SELECT 1'])).toBe('SELECT 1');
  });
});
