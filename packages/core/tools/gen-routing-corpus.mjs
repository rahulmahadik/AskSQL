/**
 * Regenerates test/fixtures/routing-corpus.txt from templates x slot fills x surface forms.
 * Deterministic: an unchanged template set rewrites the same file.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENT = [
  'orders',
  'customers',
  'users',
  'products',
  'invoices',
  'payments',
  'shipments',
  'subscriptions',
  'tickets',
  'sessions',
  'events',
  'transactions',
  'refunds',
  'employees',
  'accounts',
  'bookings',
  'deliveries',
  'campaigns',
  'leads',
  'contracts',
  'reviews',
  'articles',
  'devices',
  'suppliers',
];
const SING = {
  orders: 'order',
  customers: 'customer',
  users: 'user',
  products: 'product',
  invoices: 'invoice',
  payments: 'payment',
  shipments: 'shipment',
  subscriptions: 'subscription',
  tickets: 'ticket',
  sessions: 'session',
  events: 'event',
  transactions: 'transaction',
  refunds: 'refund',
  employees: 'employee',
  accounts: 'account',
  bookings: 'booking',
  deliveries: 'delivery',
  campaigns: 'campaign',
  leads: 'lead',
  contracts: 'contract',
  reviews: 'review',
  articles: 'article',
  devices: 'device',
  suppliers: 'supplier',
};
const MEASURE = ['revenue', 'spend', 'sales', 'cost', 'quantity', 'discount', 'profit', 'margin', 'total value'];
const DIM = [
  'region',
  'status',
  'category',
  'country',
  'channel',
  'month',
  'customer',
  'product',
  'department',
  'currency',
];
const TIME = [
  'last week',
  'last month',
  'yesterday',
  'this quarter',
  'in March',
  'since January',
  'in the last 30 days',
  'year to date',
  'today',
  'this year',
  'last year',
  'this week',
  'in the last six months',
  'over the weekend',
];
const N = ['5', '10', '20', '3', '50', '100'];
const COL = ['status', 'priority', 'email', 'country', 'archived_at', 'external_id'];

const T = {
  data: [
    'how many {ent} were created {time}',
    'how many {ent} are there {time}',
    'count the {ent} {time}',
    'count {ent} per {dim}',
    'total {measure} by {dim}',
    'what is the total {measure} {time}',
    'average {measure} per {dim}',
    'the average {measure} by {dim} {time}',
    'list the top {n} {ent} by {measure}',
    'top {n} {ent} by {measure} {time}',
    'which {ent} had the highest {measure} {time}',
    'show me all {ent} from {time}',
    'show me the {ent} with the largest {measure}',
    '{measure} by {dim} {time}',
    'breakdown of {ent} by {dim}',
    '{ent} per {dim} {time}',
    'find {ent} where {measure} is above 100',
    'list {ent} created {time}',
    'which {dim} has the most {ent}',
    'running total of {measure} by day {time}',
    'month over month change in {ent}',
    'the median {measure} per {dim}',
    '{ent} grouped by {dim} {time}',
    'give me the {n} newest {ent}',
    'what was the biggest single {measure} {time}',
    'rank {ent} by {measure} within each {dim}',
    'the share of {measure} from the top {n} percent of {ent}',
    'how many distinct {dim} values are in {ent}',
    'sum of {measure} for each {dim} {time}',
    'i want to see {measure} by {dim}',
    'pull the {ent} that changed {time}',
    'everything in {ent} {time}',
    'first {n} {ent} ordered by {measure}',
    '{ent} with a null {col}',
    'are there duplicate {col} values in {ent}',
    'how many {ent} have an empty {col}',
    'compare {measure} by {dim} between this year and last year',
    'the {n} most recent {ent} per {dim}',
    'cumulative {measure} by {dim}',
    'what percentage of {ent} were cancelled {time}',
    'the daily {measure} trend {time}',
    '{ent} that have never had a {sing2}',
    'the earliest and latest {sing} {time}',
    'how much {measure} did each {dim} bring in {time}',
    'total {measure} minus {measure2} by {dim}',
    'which {ent} appear more than once',
    'the number of {ent} by {dim} and month',
    '{ent} sorted by {measure} descending',
    'weekly {measure} for the top {n} {dim} values',
    'the {dim} with the lowest average {measure}',
  ],
  write: [
    'delete all cancelled {ent}',
    'delete the {sing} with id 42',
    'delete every {sing} older than 2020',
    'remove all {ent} created {time}',
    'remove the {sing} whose {col} is null',
    'drop the {ent} table',
    'truncate the {ent} table',
    'update the {ent} table set {col} to archived',
    'update every {sing} in the {ent} table',
    'insert a new {sing} into {ent}',
    'alter the {ent} table to add a {col} column',
    'rename the {ent} table',
    'write a query to delete {ent} created {time}',
    'write a statement that deletes cancelled {ent}',
    'give me the sql that drops the {ent} table',
    'generate a migration to add a {col} column to {ent}',
    'i need a statement that updates the {ent} table',
    'how do i write an update statement for {ent}',
    'create a script that truncates {ent}',
    'produce the ddl to rename the {ent} table',
    'draft a query to remove {ent} with a null {col}',
    'show me the sql to insert a new {sing}',
    'give me a delete statement for old {ent}',
    'write the command that alters {ent}',
    'i want a migration that drops the {col} column',
    'compose a statement to truncate {ent}',
    'write a DELETE that removes cancelled {ent}',
    'write an UPDATE that sets {col} on {ent}',
    'give me a DELETE for old {ent}',
    'generate an INSERT to add a {sing}',
    'wipe the {ent} table',
    'purge all old {ent}',
    'clear the {ent} table',
    'erase all {ent}',
    'empty the {ent} table',
    'flush the {ent} table',
    'nuke the {ent} table',
    'write a query that wipes the {ent} table',
    'give me the sql that purges old {ent}',
    'delete the {ent} where {col} is null',
    'update all {ent} set {col} to 0',
    'insert the new {sing} record',
    'drop the {col} column from {ent}',
  ],
  advice: [
    'how can i improve the performance of my {ent} queries',
    'what index should i add to speed up {ent} lookups',
    'is this schema normalized properly',
    'should i partition the {ent} table',
    'why is my query on {ent} so slow',
    'what are the pros and cons of denormalizing {ent}',
    'review my schema',
    'any suggestions for the {ent} table design',
    'what would you change about this schema',
    'how should i model {ent} and {dim}',
    'my joins on {ent} are slow',
    'do i need an index on {col}',
    'is my {ent} table missing an index',
    'how do i make this query faster',
    'what is the best way to store {measure}',
    'can you critique the design of {ent}',
    'suggest a better structure for {ent}',
    'the {ent} query is really slow',
    'what needs fixing in this schema',
    'are there redundant indexes on {ent}',
    'explain what this query does',
    'why is {ent} growing so fast',
    'should i shard {ent}',
    'give me your thoughts on this data model',
    'what are the tradeoffs of adding an index to {ent}',
    'how would you optimise the {ent} table',
    'take a look at my schema',
    'is it worth archiving old {ent}',
    'what is the difference between a view and a materialized view',
    'when should i denormalise {ent}',
    'do you see any problems with the {ent} design',
    'how does this schema scale as {ent} grow',
    'are there unused indexes on {ent}',
    'recommend an indexing strategy for {ent}',
    'is the {ent} table modelled correctly',
    'what is wrong with my {ent} schema',
    'would you normalise {ent} further',
    'my {ent} report takes forever',
    'audit the design of this database',
    'how do i speed up joins between {ent} and {dim}',
  ],
  // Questions about AskSQL rather than about the data. These read like write requests, and the
  // answer is written in code, so the two must not be confused.
  capability: [
    'can you delete my data',
    'can you drop my tables',
    'could you update the records',
    'will you ever delete anything',
    'are you able to modify my database',
    'do you write to the db',
    'can you change my schema',
    'is this read-only',
    'are you safe',
    'what can you do',
    'how do you work',
    'what is asksql',
    'is asksql read only',
    'can you insert rows',
    'would you delete something',
  ],
  listing: [
    'show me the tables',
    'list all the tables',
    'what tables do we have',
    'list the columns in {ent}',
    'which columns does {ent} have',
    'show me the columns of the {ent} table',
    'list the indexes on {ent}',
    'show the foreign keys',
    'what views exist',
    'how many tables are there',
    'name the tables in this database',
    'display the columns in {ent}',
    'do we have a {ent} table',
    'list the primary keys',
    'show the constraints on {ent}',
    'enumerate the tables',
    'what triggers exist',
    'list the sequences',
    'which tables have foreign keys',
    'show me the fields in {ent}',
    'what columns are in {ent}',
    'tell me the tables in this schema',
    'get the list of views',
    'which routines are defined',
  ],
};

const BANKS = {
  ent: ENT,
  ent2: ENT,
  sing: ENT,
  sing2: ENT,
  measure: MEASURE,
  measure2: MEASURE,
  dim: DIM,
  dim2: DIM,
  time: TIME,
  n: N,
  col: COL,
};

function fills(tpl) {
  const slots = [...new Set([...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];
  if (slots.length === 0) return [tpl];
  const max = Math.max(...slots.map((s) => BANKS[s].length));
  const out = [];
  for (let i = 0; i < max; i++) {
    let text = tpl;
    slots.forEach((s, k) => {
      const bank = BANKS[s];
      const value = bank[(i + k * 5) % bank.length];
      text = text.split(`{${s}}`).join(s.startsWith('sing') ? SING[value] : value);
    });
    out.push(text);
  }
  return out;
}

// Surface forms people actually type; the politeness wrappers defeat an anchored pattern.
const VARIANTS = [
  (q) => q,
  (q) => `${q}?`,
  (q) => q[0].toUpperCase() + q.slice(1),
  (q) => `please ${q}`,
  (q) => `can you ${q}`,
  (q) => `${q} please`,
];

const corpus = [];
const seen = new Set();
for (const [route, templates] of Object.entries(T)) {
  templates.forEach((tpl, ti) => {
    fills(tpl).forEach((base, bi) => {
      for (let v = 0; v < VARIANTS.length; v++) {
        // Stride so every variant is exercised without multiplying the corpus sixfold.
        if (v !== 0 && (ti + bi) % VARIANTS.length !== v) continue;
        const q = VARIANTS[v](base);
        if (seen.has(q)) continue;
        seen.add(q);
        corpus.push([route, q]);
      }
    });
  });
}
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'routing-corpus.txt');
const header = [
  '# Generated by tools/gen-routing-corpus.mjs - do not edit by hand.',
  '# <route>\\t<question>, where route is data, write, advice or listing.',
  `# ${corpus.length} questions.`,
].join('\n');
writeFileSync(out, `${header}\n${corpus.map(([route, q]) => `${route}\t${q}`).join('\n')}\n`);
console.log(`wrote ${corpus.length} questions -> ${out}`);
for (const r of Object.keys(T)) console.log(' ', r, corpus.filter((c) => c[0] === r).length);
