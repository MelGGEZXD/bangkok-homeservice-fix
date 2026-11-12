// Applies SCHEMA_SQL to the given connection. Called on every boot — this monolith reseeds from
// scratch each time it starts, which is what keeps a fresh `docker compose up` deterministic.
import { schemaSql } from "./schema.js";

export function migrate(db, options) {
  db.exec(schemaSql(options));
}
