// Child-process worker for the concurrency test: opens its own DB connection
// and saves the given bytes, starting at a shared moment so writes collide.
import { readFileSync } from "node:fs";
import { openDatabase } from "../../src/db/connection.js";
import { ImportRepository } from "../../src/db/importRepository.js";
import { processDocument } from "../../src/tally/process.js";
import { sha256 } from "./testApp.js";

const [dbPath, xmlPath, startAt] = process.argv.slice(2) as [string, string, string];
const bytes = readFileSync(xmlPath);
const processed = processDocument(bytes);
const db = openDatabase(dbPath);

while (Date.now() < Number(startAt)) {
  // busy-wait so every process starts its transaction at the same instant
}
const { stored, duplicate } = new ImportRepository(db).saveImport({
  contentHash: sha256(bytes),
  bytes,
  originalFilename: null,
  processed,
});
db.close();
process.stdout.write(JSON.stringify({ importId: stored.id, duplicate }));
