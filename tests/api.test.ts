// HTTP contract, persistence relationships and security behaviour.
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECEIPT, SALES_INVOICE, TALLY_ERROR_RESPONSE } from "./support/samples.js";
import { TEST_MAX_UPLOAD_BYTES, countRows, createTestApp, getDetails, getVouchers, multipart, sha256, upload } from "./support/testApp.js";

let app: FastifyInstance;
beforeEach(async () => {
  app = await createTestApp();
});
afterEach(async () => {
  await app.close();
});

describe("API contract", () => {
  it("GET /health returns 200", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("upload response has the required shape", async () => {
    const res = await upload(app, RECEIPT);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      importId: expect.any(String),
      documentType: "voucherExport",
      status: "completed",
      duplicate: false,
      summary: { vouchers: 1, ledgerEntries: 2, inventoryEntries: 0, warnings: 0, errors: 0 },
    });
  });

  it("details expose the exact-byte SHA-256 and the same summary", async () => {
    const upl = (await upload(app, RECEIPT)).json();
    const details = await getDetails(app, upl.importId);

    expect(details).toMatchObject({
      importId: upl.importId,
      documentType: "voucherExport",
      status: "completed",
      contentHash: sha256(RECEIPT),
      detectedEncoding: "UTF-8",
      summary: upl.summary,
      warnings: [],
      errors: [],
    });
    expect(details.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(details).not.toHaveProperty("tallyResponse");
  });

  it("voucher items carry source.importId, contentHash and voucherIndex", async () => {
    const { importId } = (await upload(app, RECEIPT)).json();
    const { items, count } = await getVouchers(app, importId);

    expect(count).toBe(1);
    expect(items[0].source).toEqual({ importId, contentHash: sha256(RECEIPT), voucherIndex: 0 });
    expect(items[0]).toMatchObject({
      attributes: { VCHTYPE: "Receipt", ACTION: "Create" },
      date: "20260715",
      voucherType: "Receipt",
      voucherNumber: "RCP-001",
      partyLedgerName: "Customer A",
      narration: "Receipt sample",
      warnings: [],
    });
  });

  it("returns 404 for an unknown import", async () => {
    for (const url of ["/api/tally/imports/missing", "/api/tally/imports/missing/vouchers"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: "IMPORT_NOT_FOUND", message: expect.any(String) } });
    }
  });
});

describe("persistence", () => {
  it("stores the voucher tree as linked rows in source order", async () => {
    await upload(app, SALES_INVOICE);
    const rows = app.db
      .prepare(
        `SELECT le.position, le.source_tag, le.amount, ba.amount AS bill_amount
         FROM ledger_entries le
         JOIN vouchers v ON v.id = le.voucher_id
         LEFT JOIN bill_allocations ba ON ba.ledger_entry_id = le.id
         ORDER BY le.position`,
      )
      .all();
    expect(rows).toEqual([
      { position: 0, source_tag: "LEDGERENTRIES.LIST", amount: "-118.00", bill_amount: "-117.99" },
      { position: 1, source_tag: "LEDGERENTRIES.LIST", amount: "9.00", bill_amount: null },
      { position: 2, source_tag: "LEDGERENTRIES.LIST", amount: "9.00", bill_amount: null },
    ]);
    expect(countRows(app, "rate_details")).toBe(3);
    expect(app.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("stores money as TEXT, never as a floating-point number", async () => {
    await upload(app, SALES_INVOICE);
    for (const table of ["ledger_entries", "bill_allocations", "inventory_entries", "batch_allocations", "accounting_allocations"]) {
      const types = app.db.prepare(`SELECT DISTINCT typeof(amount) FROM ${table}`).pluck().all();
      expect(types, table).toEqual(["text"]);
    }
  });

  it("persists warnings and the Tally business result", async () => {
    const { importId } = (await upload(app, TALLY_ERROR_RESPONSE)).json();
    const row = app.db.prepare("SELECT tally_business_status FROM imports WHERE id = ?").pluck().get(importId);
    expect(row).toBe("failed");

    await upload(app, SALES_INVOICE);
    expect(countRows(app, "import_issues")).toBe(1);
  });
});

describe("rejected uploads", () => {
  const expectError = async (res: Awaited<ReturnType<typeof upload>>, status: number, code: string) => {
    expect(res.statusCode).toBe(status);
    const body = res.json();
    expect(body).toEqual({ error: { code, message: expect.any(String) } });
    // No stack traces or local paths in error bodies.
    expect(res.body).not.toMatch(/\bat \S+ \(|node_modules|[A-Z]:\\|\/src\//);
  };

  it("rejects DOCTYPE / external entities without persisting anything", async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY e SYSTEM "file:///etc/passwd">]><RESPONSE><LINEERROR>&e;</LINEERROR></RESPONSE>`;
    await expectError(await upload(app, xxe), 400, "DTD_NOT_ALLOWED");
    expect(countRows(app, "imports")).toBe(0);
  });

  it("rejects malformed XML, non-XML and empty files", async () => {
    await expectError(await upload(app, "<ENVELOPE><BODY>"), 400, "MALFORMED_XML");
    await expectError(await upload(app, "just text"), 400, "MALFORMED_XML");
    await expectError(await upload(app, Buffer.alloc(0)), 400, "EMPTY_DOCUMENT");
  });

  it("rejects unsupported documents with 422", async () => {
    await expectError(await upload(app, "<FOO/>"), 422, "UNSUPPORTED_DOCUMENT");
    await expectError(await upload(app, "<ENVELOPE><BODY><DATA><IMPORTRESULT/></DATA></BODY></ENVELOPE>"), 422, "UNSUPPORTED_DOCUMENT");
  });

  it("enforces the upload size limit", async () => {
    const big = `<RESPONSE><LINEERROR>${"x".repeat(TEST_MAX_UPLOAD_BYTES)}</LINEERROR></RESPONSE>`;
    await expectError(await upload(app, big), 413, "PAYLOAD_TOO_LARGE");
    expect(countRows(app, "imports")).toBe(0);
  });

  it("requires exactly one file in the field named 'file'", async () => {
    const send = (parts: Parameters<typeof multipart>[0]) =>
      app.inject({ method: "POST", url: "/api/tally/imports", ...multipart(parts) });

    await expectError(await send([{ name: "upload", filename: "a.xml", content: RECEIPT }]), 400, "MISSING_FILE");
    await expectError(await send([{ name: "note", content: "hello" }]), 400, "MISSING_FILE");
    await expectError(
      await send([
        { name: "file", filename: "a.xml", content: RECEIPT },
        { name: "file", filename: "b.xml", content: RECEIPT },
      ]),
      413,
      "TOO_MANY_PARTS",
    );
  });

  it("rejects non-multipart bodies with 415", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tally/imports",
      headers: { "content-type": "application/xml" },
      payload: RECEIPT,
    });
    await expectError(res, 415, "UNSUPPORTED_MEDIA_TYPE");
  });

  it("stores only the base name of a client-supplied filename", async () => {
    const { importId } = (await upload(app, RECEIPT, "C:\\secret\\dir\\..\\receipt.xml")).json();
    expect((await getDetails(app, importId)).originalFilename).toBe("receipt.xml");
  });

  it("never exposes raw XML through import details", async () => {
    const { importId } = (await upload(app, RECEIPT)).json();
    const res = await app.inject({ method: "GET", url: `/api/tally/imports/${importId}` });
    expect(res.body).not.toContain("<VOUCHER");
  });
});
