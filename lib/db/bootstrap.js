// One call that gets a fresh, migrated, seeded database ready to serve. Used by instrumentation.js
// on real boot and by test-helpers/boot.js to stand up an isolated in-process app per test file.
import { getDb } from "./index.js";
import { migrate } from "./migrate.js";
import { seed } from "./seed.js";
import { logger } from "../logger.js";

export function bootstrapDb() {
  const db = getDb();
  migrate(db);
  seed(db);
  logger.info("database migrated and seeded");
  return db;
}
