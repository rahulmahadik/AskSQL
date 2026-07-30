import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  contributes: {
    commands: { command: string; title: string; icon?: string }[];
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
  };
};
const src = readFileSync(fileURLToPath(new URL('../src/extension.ts', import.meta.url)), 'utf8');
const tree = readFileSync(fileURLToPath(new URL('../src/tree.ts', import.meta.url)), 'utf8');

describe('Ask About This Table', () => {
  it('is declared as a command', () => {
    const cmd = pkg.contributes.commands.find((c) => c.command === 'asksql.askAboutTable');
    expect(cmd?.title).toBe('Ask About This Table');
  });

  it('is registered in the extension, or the menu entry would do nothing', () => {
    expect(src).toContain("'asksql.askAboutTable'");
  });

  it('targets the same contextValue the tree actually sets on a table row', () => {
    const menu = pkg.contributes.menus['view/item/context']?.find((m) => m.command === 'asksql.askAboutTable');
    expect(menu?.when).toContain('viewItem == asksql.table');
    // A when-clause naming a contextValue the tree never sets fails silently.
    expect(tree).toContain("item.contextValue = 'asksql.table'");
  });

  it('appears inline on the row, not buried in a submenu', () => {
    const menu = pkg.contributes.menus['view/item/context']?.find((m) => m.command === 'asksql.askAboutTable');
    expect(menu?.group).toMatch(/^inline/);
  });

  it('is hidden from the command palette, where there is no table to act on', () => {
    const pal = pkg.contributes.menus['commandPalette']?.find((m) => m.command === 'asksql.askAboutTable');
    expect(pal?.when).toBe('false');
  });

  it('prefills a concrete question and acts only on table nodes', () => {
    expect(src).toContain('Show me 10 rows from');
    expect(src).toContain("node.kind !== 'table'");
  });

  it('focuses the chat view using the id the manifest declares', () => {
    expect(src).toContain("executeCommand('asksql.chat.focus')");
    expect(JSON.stringify(pkg)).toContain('"asksql.chat"');
  });
});
