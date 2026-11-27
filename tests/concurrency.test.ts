// Optional extension 3: simultaneous uploads of identical bytes produce one import.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrate.js";
import { RECEIPT } from "./support/samples.js";
import { countRows, createTestApp, upload } from "./support/testApp.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKER = fileURLToPath(new URL("./support/concurrentUpload.ts", import.meta.url));
const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function runWorker(dbPath: string, xmlPath: string, startAt: number): Promise<{ importId: string; duplicate: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WORKER, dbPath, xmlPath, String(startAt)], { cwd: ROOT });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `exit ${code}`))));
  });
}

describe("concurrent identical uploads", () => {
  it("parallel HTTP requests on one server create exactly one import", async () => {
    const app = await createTestApp();
    const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => upload(app, RECEIPT, `copy-${i}.xml`)));

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(9);
    expect(new Set(responses.map((r) => r.json().importId)).size).toBe(1);
    expect(countRows(app, "imports")).toBe(1);
    expect(countRows(app, "vouchers")).toBe(1);
    await app.close();
  });

  it(
    "separate processes with their own DB connections create exactly one import",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "tally-concurrency-"));
      tempDirs.push(dir);
      const dbPath = path.join(dir, "test.db");
      const xmlPath = path.join(dir, "receipt.xml");
      writeFileSync(xmlPath, RECEIPT);
      const setup = openDatabase(dbPath);
      runMigrations(setup);
      setup.close();

      // All processes wait for the same moment, then insert at once.
      const startAt = Date.now() + 3000;
      const results = await Promise.all(Array.from({ length: 6 }, () => runWorker(dbPath, xmlPath, startAt)));

      expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(new Set(results.map((r) => r.importId)).size).toBe(1);

      const db = openDatabase(dbPath);
      expect(db.prepare("SELECT count(*) FROM imports").pluck().get()).toBe(1);
      expect(db.prepare("SELECT count(*) FROM vouchers").pluck().get()).toBe(1);
      expect(db.prepare("SELECT count(*) FROM ledger_entries").pluck().get()).toBe(2);
      db.close();
    },
    30_000,
  );
});
