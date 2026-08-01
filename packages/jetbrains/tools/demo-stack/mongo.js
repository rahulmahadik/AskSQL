// ============================================================================
// AskSQL JetBrains live tests - MERGED MongoDB fixture (localhost:57017)
//
// Serves, in one database, every MongoDB-backed assertion in:
//   engine/MongoEndToEndTest.kt                          (2 tests)
//   engine/MongoExecuteCollectionVerificationLiveTest.kt (2 tests)
//   engine/MongoAdvancedPipelineExecutionTest.kt         (4 tests - needs NO fixture)
//   engine/EdgeCaseAccuracyEvalTest.kt                   (mongodb edge cases)
//   engine/FailedQuestionsRetestTest.kt                  (mongodb truth pipelines,
//                                                         run OUTSIDE try/catch)
//
// Load:
//   mongosh "mongodb://localhost:57017/asksql_demo" --file asksql-demo-mongo.js
//
// Server requirements, all derived rather than assumed:
//   * MongoDB >= 5.0 - $setWindowFields/$rank (MongoAdvancedPipelineExecutionTest.kt:162-186).
//   * Authentication DISABLED - every descriptor omits `user` and passes
//     password = null, and MongoClientFactory.kt:33-36 attaches a MongoCredential
//     only when user AND password are both non-blank.
//   * Writable - MongoAdvancedPipelineExecutionTest.kt:52-69 inserts directly.
// Neither packages/postgres/test/fixture.sql nor packages/mysql/test/fixture.sql
// contributes anything here: no test in this group asserts on a SchemaCatalog,
// and MongoIntrospector infers shape purely by $sample.
// ============================================================================

const demo = db.getSiblingDB('asksql_demo');

// ---------------------------------------------------------------------------
// NEGATIVE requirement.
// MongoExecuteCollectionVerificationLiveTest.kt:57-72 expects execute() to throw
// with userMessage containing "doesn't exist" for this exact name, which
// MongoEnginePipeline.kt:305-310 only does when NOTHING in the catalog matches it
// case-insensitively. Creating it would break the test.
// ---------------------------------------------------------------------------
demo.getCollection('definitely_not_a_real_collection_xyz').drop();

// ---------------------------------------------------------------------------
// orders - lowercase, non-empty, with at least one status:'completed'.
//   * MongoExecuteCollectionVerificationLiveTest.kt:82-88 runs [{"$match":{}}]
//     against "ORDERS" and asserts rows.isNotEmpty().
//   * MongoEndToEndTest.kt:59-69 "How many completed orders are there?" ->
//     rows.isNotEmpty(). A $count/$group emits ZERO documents when its $match
//     matches nothing, so the literal must really be there.
//   * customerId must reference customers._id: the $lookup at
//     FailedQuestionsRetestTest.kt:218 uses localField _id / foreignField customerId.
//   * totalCents must sum to 13600 (EdgeCaseAccuracyEvalTest.kt:227).
// EXACTLY ONE collection may match /^orders$/i - MongoEnginePipeline.kt:305 uses
// firstOrNull, so "orders" plus "Orders" would resolve ambiguously.
// Unlike the SQL engines, MongoIntrospector.kt:113 DOES record scalar sample
// values, and CatalogPruner.kt:80-81 renders them as "sample values:
// completed|pending", so the model can actually see the literal here.
// ---------------------------------------------------------------------------
demo.getCollection('orders').drop();
demo.getCollection('orders').insertMany([
  { _id: 1, customerId: 1, status: 'completed', totalCents: 2500, placedAt: new Date('2026-01-15T10:00:00Z') },
  { _id: 2, customerId: 1, status: 'pending',   totalCents: 1200, placedAt: new Date('2026-02-03T09:30:00Z') },
  { _id: 3, customerId: 2, status: 'completed', totalCents: 9900, placedAt: new Date('2026-02-20T16:45:00Z') },
]);

// ---------------------------------------------------------------------------
// customers - 3 documents, with customer 3 (Carol) deliberately having NO orders.
//   * EdgeCaseAccuracyEvalTest.kt:224-226 truth "3".
//   * FailedQuestionsRetestTest.kt:221-229 truth pipelines run at :241 OUTSIDE
//     the try block against collection "customers" and project "name", so the
//     collection must exist or MongoEnginePipeline.kt:305-310 throws out of the test.
//   * Carol having zero orders is what makes the "never placed an order" truth
//     return exactly one row instead of an empty set.
// Customer/order assignment is identical to the Postgres and MySQL fixtures.
// ---------------------------------------------------------------------------
demo.getCollection('customers').drop();
demo.getCollection('customers').insertMany([
  { _id: 1, name: 'Alice Johnson', email: 'alice@example.com', region: 'NA' },
  { _id: 2, name: 'Bob Smith',     email: 'bob@example.com',   region: 'EU' },
  { _id: 3, name: 'Carol White',   email: 'carol@example.com', region: 'NA' },
]);

// ---------------------------------------------------------------------------
// products - HETEROGENEOUS documents (differing field sets), exactly one named
// "Widget", which must have a price.
//   * MongoEndToEndTest.kt:80-91 "What is the price of the Widget product?" ->
//     rows.isNotEmpty(). Varying fields are the test's stated premise (:79).
//   * FailedQuestionsRetestTest.kt:231-235 truth pipeline needs `tags` and `price`.
//   * EdgeCaseAccuracyEvalTest.kt:228 tallies Widget's price as "9.99".
// Only Widget and Gadget carry the 'hardware' tag, so the hardware average is a
// deterministic (9.99+19.50)/2 = 14.745 rather than depending on the price-less
// document below.
// ---------------------------------------------------------------------------
demo.getCollection('products').drop();
demo.getCollection('products').insertMany([
  // The document every Widget assertion depends on.
  { _id: 1, name: 'Widget', price: 9.99,  tags: ['hardware', 'popular'], stock: 12 },
  // Same core shape plus one extra field.
  { _id: 2, name: 'Gadget', price: 19.50, tags: ['hardware'], stock: 0, discontinued: true },
  // Nested sub-document and a free-text field the others lack.
  { _id: 3, name: 'Doohickey', price: 125.0, tags: ['software'], notes: 'ships from the EU warehouse', dimensions: { widthMm: 40, heightMm: 12 } },
  // Deliberately has NO price field at all - this is the heterogeneity under test.
  { _id: 4, name: 'Gizmo', tags: ['accessory'], stock: 3 },
]);

// ---------------------------------------------------------------------------
// Hygiene only. MongoAdvancedPipelineExecutionTest creates AND drops
// advtest_customers / advtest_orders itself (:54-68, :76-77); these drops just
// clean up after a run that crashed between @Before and @After. Do NOT pre-seed
// them: a leftover copy would be sampled into the prompt for the eval tests,
// where "customers" would become ambiguous with advtest_customers.
// ---------------------------------------------------------------------------
demo.getCollection('advtest_customers').drop();
demo.getCollection('advtest_orders').drop();

// ---------------------------------------------------------------------------
// Self-check: every REQUIRED fact, plus the two truth pipelines that run outside
// a try/catch in FailedQuestionsRetestTest.
// ---------------------------------------------------------------------------
function check(label, ok) {
  print((ok ? 'OK   ' : 'FAIL ') + label);
  if (!ok) throw new Error('fixture check failed: ' + label);
}

const names = demo.getCollectionNames();
check('collection "orders" exists, exact lowercase', names.indexOf('orders') !== -1);
check('collection "products" exists, exact lowercase', names.indexOf('products') !== -1);
check('collection "customers" exists, exact lowercase', names.indexOf('customers') !== -1);
check('exactly one collection matches /^orders$/i',
  names.filter(function (n) { return n.toLowerCase() === 'orders'; }).length === 1);
check('"definitely_not_a_real_collection_xyz" is absent',
  names.indexOf('definitely_not_a_real_collection_xyz') === -1);
check('orders has at least one document', demo.getCollection('orders').countDocuments({}) > 0);
check('orders has at least one status:"completed" document',
  demo.getCollection('orders').countDocuments({ status: 'completed' }) > 0);
check('a $count over completed orders emits exactly one row',
  demo.getCollection('orders').aggregate([{ $match: { status: 'completed' } }, { $count: 'n' }]).toArray().length === 1);
check('order totals sum to 13600',
  demo.getCollection('orders').aggregate([{ $group: { _id: null, t: { $sum: '$totalCents' } } }]).toArray()[0].t === 13600);
check('customers has exactly 3 documents', demo.getCollection('customers').countDocuments({}) === 3);
check('exactly one product is named "Widget" and it has a price',
  demo.getCollection('products').countDocuments({ name: 'Widget', price: { $exists: true } }) === 1);
check('products is heterogeneous (at least one document without a price)',
  demo.getCollection('products').countDocuments({ price: { $exists: false } }) > 0);

// FailedQuestionsRetestTest.kt:221-225 - must return exactly Carol White.
const neverOrdered = demo.getCollection('customers').aggregate([
  { $lookup: { from: 'orders', localField: '_id', foreignField: 'customerId', as: 'o' } },
  { $project: { _id: 0, name: 1, n: { $size: '$o' } } },
  { $match: { n: 0 } },
  { $project: { _id: 0, name: 1 } },
]).toArray();
check('truth pipeline "never placed an order" returns exactly [Carol White]',
  neverOrdered.length === 1 && neverOrdered[0].name === 'Carol White');

// FailedQuestionsRetestTest.kt:231-235 - must return a non-empty average.
const hardwareAvg = demo.getCollection('products').aggregate([
  { $match: { tags: 'hardware' } },
  { $group: { _id: null, avg: { $avg: '$price' } } },
]).toArray();
check('truth pipeline "average price of hardware products" is non-empty',
  hardwareAvg.length === 1 && hardwareAvg[0].avg > 0);

// MongoAdvancedPipelineExecutionTest.kt:162-186 needs MongoDB >= 5.0.
check('$setWindowFields/$rank is supported by this server',
  demo.getCollection('orders').aggregate([
    { $setWindowFields: { partitionBy: '$customerId', sortBy: { totalCents: -1 }, output: { rank: { $rank: {} } } } },
  ]).toArray().length === 3);

// MongoAdvancedPipelineExecutionTest.kt:52-69 writes directly, unauthenticated.
check('the database accepts unauthenticated writes', (function () {
  demo.getCollection('__asksql_write_probe').insertOne({ ok: 1 });
  const n = demo.getCollection('__asksql_write_probe').countDocuments({});
  demo.getCollection('__asksql_write_probe').drop();
  return n === 1;
})());

print('');
print('asksql_demo fixture loaded: ' + demo.getCollectionNames().join(', '));
