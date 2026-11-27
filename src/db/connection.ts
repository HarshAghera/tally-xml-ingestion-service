import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDatabase(dbPath: string): Db {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);

  // SQLite leaves FK checks off unless asked; we rely on them for ownership.
  db.pragma("foreign_keys = ON");
  // WAL lets readers work while an import is being written.
  if (dbPath !== ":memory:") db.pragma("journal_mode = WAL");
  // A second writer waits for the lock instead of failing at once.
  db.pragma("busy_timeout = 5000");
  return db;
}
