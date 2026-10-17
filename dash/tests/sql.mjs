// Does the SQL in store.js name columns that actually exist?
//
// store.js reads schema.sql through a wrangler rule, so Node cannot load it
// and no unit test ever executes a line of it. esbuild bundles it happily --
// a column name is just text inside a string. D1 is the first thing that
// looks, which means a typo reaches production and takes the whole dash down
// with it, because every request runs ensureSchema.
//
// That is exactly what happened: a migration wrote `updated_at` into the meta
// table, whose column is `applied_at`. Every other migration had it right.
//
// So this reads both files as text and checks them against each other. It is
// not a parser and does not try to be; it catches the one mistake that is
// invisible everywhere else.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(HERE, '..', 'worker', 'schema.sql'), 'utf8');
const store = fs.readFileSync(path.join(HERE, '..', 'worker', 'store.js'), 'utf8');

let ran = 0;
let failed = 0;
const fail = (msg) => { failed++; console.log('  FAIL ' + msg); };

// table -> Set(columns), from CREATE TABLE blocks.
const tables = new Map();
for (const m of schema.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const cols = new Set();
  for (const line of m[2].split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('--')) continue;
    const c = t.match(/^(\w+)/);
    // Skip table-level constraints, which are not columns.
    if (c && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(c[1])) cols.add(c[1]);
  }
  tables.set(m[1], cols);
}

// Columns added by ALTER after the fact are just as real as the ones in the
// CREATE, and store.js writes to them.
for (const m of store.matchAll(/\[\s*'(\w+)'\s*,\s*'(\w+)[^']*'\s*\]/g)) {
  if (tables.has(m[1])) tables.get(m[1]).add(m[2]);
}

console.log('schema: ' + [...tables.keys()].join(', '));

// INSERT INTO <table> (a, b, c)
for (const m of store.matchAll(/INTO\s+(\w+)\s*\(([^)]*)\)/gi)) {
  const [, table, cols] = m;
  ran++;
  if (!tables.has(table)) { fail('no such table: ' + table); continue; }
  for (const raw of cols.split(',')) {
    const col = raw.trim();
    if (!col || !/^\w+$/.test(col)) continue;
    if (!tables.get(table).has(col)) {
      fail(table + ' has no column ' + col + '  (it has: '
        + [...tables.get(table)].join(', ') + ')');
    }
  }
}

// UPDATE <table> SET a = ?, b = ?
for (const m of store.matchAll(/UPDATE\s+(\w+)\s+SET\s+([\s\S]*?)(?:\s+WHERE\b|')/gi)) {
  const [, table, sets] = m;
  ran++;
  if (!tables.has(table)) { fail('no such table: ' + table); continue; }
  for (const part of sets.split(',')) {
    const col = (part.trim().match(/^(\w+)\s*=/) || [])[1];
    if (!col) continue;
    if (!tables.get(table).has(col)) {
      fail(table + ' has no column ' + col + '  (it has: '
        + [...tables.get(table)].join(', ') + ')');
    }
  }
}

console.log(ran + ' statements checked, ' + (failed ? failed + ' FAILED' : 'all name real columns'));
process.exit(failed ? 1 : 0);
