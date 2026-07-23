// @vitest-environment jsdom
/**
 * SchemaBrowser: expand a table to reveal columns with PK/FK/enum/required
 * hints, filter by search, the Ask affordance, and the empty state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SchemaBrowser } from '../src/SchemaBrowser.js';
import type { SchemaCatalog, TableInfo } from '@asksql/core';

afterEach(cleanup);

const orders: TableInfo = {
  name: 'orders',
  kind: 'table',
  columns: [
    { name: 'id', dbType: 'bigint', nullable: false },
    { name: 'status', dbType: 'order_status', nullable: false, enumValues: ['paid', 'shipped'] },
    { name: 'customer_id', dbType: 'bigint', nullable: true },
  ],
  primaryKey: ['id'],
  foreignKeys: [{ columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] }],
  uniques: [],
  checks: [],
  indexes: [],
  source: 'file',
};

const catalog: SchemaCatalog = {
  engine: 'postgres',
  schemas: ['public'],
  tables: [orders, { ...orders, name: 'products', primaryKey: ['id'], foreignKeys: [], source: 'db' }],
  enums: [],
  sequences: [],
  triggers: [],
  routines: [],
  warnings: [],
  fetchedAt: 'now',
};

describe('SchemaBrowser', () => {
  it('expands a table and shows column hints', async () => {
    const user = userEvent.setup();
    render(<SchemaBrowser catalog={catalog} />);
    await user.click(screen.getByRole('button', { name: /Toggle orders/i }));
    expect(screen.getByText('status')).toBeTruthy();
    expect(screen.getByText('PK')).toBeTruthy();
    expect(screen.getByText(/FK→customers/)).toBeTruthy();
    expect(screen.getByText('enum')).toBeTruthy();
    expect(screen.getAllByText('required').length).toBeGreaterThan(0);
  });

  it('filters tables by the search box', async () => {
    const user = userEvent.setup();
    render(<SchemaBrowser catalog={catalog} />);
    await user.type(screen.getByRole('textbox', { name: /Search schema/i }), 'products');
    expect(screen.queryByRole('button', { name: /Toggle orders/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Toggle products/i })).toBeTruthy();
  });

  it('shows "No matches." when the filter excludes everything', async () => {
    const user = userEvent.setup();
    render(<SchemaBrowser catalog={catalog} />);
    await user.type(screen.getByRole('textbox', { name: /Search schema/i }), 'zzz');
    expect(screen.getByText('No matches.')).toBeTruthy();
  });

  it('invokes onPick from the Ask button', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<SchemaBrowser catalog={catalog} onPick={onPick} />);
    const ordersRow = screen.getByRole('button', { name: /Toggle orders/i }).closest('.asksql-schema-row')!;
    await user.click(within(ordersRow as HTMLElement).getByRole('button', { name: 'Ask' }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: 'orders' }));
  });

  it('renders a friendly empty state for a catalog with no tables', () => {
    render(<SchemaBrowser catalog={{ ...catalog, tables: [] }} />);
    expect(screen.getByText(/No tables found/i)).toBeTruthy();
  });
});
