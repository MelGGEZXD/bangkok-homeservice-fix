// Test bootstrap. Each test FILE is its own process under `node --test`, so importing this once at
// the top of a file gives that file an isolated in-memory database.
//
// IMPORTANT: this module sets NODE_ENV/DB_PATH and THEN dynamically imports the DB layer, using
// top-level await. Because it must be the FIRST import in every test file, its env vars are in
// place before any route handler's static graph (config, db) is evaluated. getDb() also resolves
// the path at open time, so :memory: is guaranteed regardless of ESM import ordering.
process.env.NODE_ENV = "test";
process.env.DB_PATH = ":memory:";

const { bootstrapDb } = await import("../lib/db/bootstrap.js");
const { getDb, closeDb } = await import("../lib/db/index.js");

export function freshBoot() {
  return bootstrapDb();
}

export { getDb, closeDb };
