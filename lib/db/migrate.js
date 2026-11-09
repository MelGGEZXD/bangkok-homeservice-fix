// Applies SCHEMA_SQL to the given connection. Called on every boot — this monolith reseeds from
// scratch each time it starts, which is what keeps a fresh `docker compose up` deterministic.
import { SCHEMA_SQL } from "./schema.js";

export function migrate(db) {
  db.exec(SCHEMA_SQL);
}
