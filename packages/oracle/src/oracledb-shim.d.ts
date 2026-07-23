// oracledb ships no bundled TypeScript declarations and there is no
// @types/oracledb package, so declare the module as `any`. The connector never
// relies on the driver's real types: the lazy `import('oracledb')` is cast
// through `unknown` to the minimal structural interfaces in index.ts.
declare module 'oracledb';
