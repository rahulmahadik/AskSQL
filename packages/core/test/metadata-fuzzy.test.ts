import { describe, expect, it } from 'vitest';
import { catalogQueryHint, closestTableName, isMetadataQuestion } from '../src/schema-match.js';
import type { SchemaCatalog, TableInfo } from '../src/types.js';

function table(name: string): TableInfo {
  return {
    name,
    kind: 'table',
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    uniques: [],
    checks: [],
    indexes: [],
  };
}

function catalog(...names: string[]): SchemaCatalog {
  return { engine: 'postgres', tables: names.map(table) };
}

describe('isMetadataQuestion', () => {
  it('accepts common structure phrasings', () => {
    for (const q of [
      'show tables',
      'list all tables',
      'show me the tables',
      'what tables are there',
      'what tables do we have',
      'which tables exist',
      'how many tables are in the database',
      'describe the columns',
      'give me the list of views',
      'tell me the schema',
      'what is the database structure',
      'list the columns of every table',
    ]) {
      expect(isMetadataQuestion(q), q).toBe(true);
    }
  });

  it('rejects ordinary data questions', () => {
    for (const q of [
      'how many customers signed up last month',
      'total revenue by region',
      'top 10 products by sales',
      'who placed the most orders',
    ]) {
      expect(isMetadataQuestion(q), q).toBe(false);
    }
  });
});

describe('catalogQueryHint', () => {
  it('uses sqlite_master for sqlite', () => {
    expect(catalogQueryHint('sqlite')).toContain('sqlite_master');
  });
  it('scopes mysql to the current database', () => {
    expect(catalogQueryHint('mysql')).toContain('DATABASE()');
  });
  it('excludes system schemas for postgres/duckdb', () => {
    expect(catalogQueryHint('postgres')).toContain('pg_catalog');
    expect(catalogQueryHint('duckdb')).toContain('information_schema');
  });
});

describe('closestTableName', () => {
  it('matches a misspelled table to the real one', () => {
    expect(closestTableName('show me the custommers', catalog('customers', 'orders'))).toBe('customers');
    expect(closestTableName('appointmnts today', catalog('appointments'))).toBe('appointments');
  });
  it('returns null on an exact match (nothing to correct)', () => {
    expect(closestTableName('list customers', catalog('customers'))).toBeNull();
  });
  it('returns null when nothing is close', () => {
    expect(closestTableName('galactic starships', catalog('customers', 'orders'))).toBeNull();
  });
});
