import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import { openDatabase, type Db } from "./connection.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

// Applies migrations/NNN_*.sql in order, each once, each in its own transaction,
// so a failed migration leaves the schema unchanged.
export function runMigrations(db: Db): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").pluck().all() as string[],
  );
  const pending = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .filter((f) => !applied.has(f));

  const record = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
  for (const file of pending) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    })();
  }
  return pending;
}

// `npm run migrate` runs this file directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const applied = runMigrations(db);
  db.close();
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
}
