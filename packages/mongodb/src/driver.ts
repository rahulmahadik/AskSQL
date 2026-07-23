/**
 * Minimal structural views over the parts of the `mongodb` driver this
 * connector uses. The dynamic import is cast through `unknown` to these, so the
 * package typechecks against its own contract rather than the driver's ambient
 * types (which pull a large BSON type surface).
 */

export interface MongoModule {
  MongoClient: new (uri: string, options?: Record<string, unknown>) => MongoClientLike;
  /** Extended JSON codec; deserialize turns {$date}/{$oid}/{$numberDecimal} into BSON types. */
  EJSON: { deserialize(value: unknown, options?: Record<string, unknown>): unknown };
}

export interface MongoClientLike {
  connect(): Promise<MongoClientLike>;
  close(): Promise<void>;
  db(name?: string): DbLike;
}

export interface CollectionListEntry {
  readonly name: string;
  readonly type?: string;
}

export interface DbLike {
  command(command: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  listCollections(
    filter?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): { toArray(): Promise<CollectionListEntry[]> };
  collection(name: string): CollectionLike;
}

export interface CollectionLike {
  aggregate(pipeline: unknown[], options?: Record<string, unknown>): AggregationCursorLike;
  estimatedDocumentCount(options?: Record<string, unknown>): Promise<number>;
}

export interface AggregationCursorLike {
  toArray(): Promise<Record<string, unknown>[]>;
  hasNext(): Promise<boolean>;
  next(): Promise<Record<string, unknown> | null>;
  close(): Promise<void>;
}
