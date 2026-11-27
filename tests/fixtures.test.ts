// The seven supplied fixtures, uploaded through the real HTTP API.
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countRows, createTestApp, getDetails, getVouchers, sha256, upload } from "./support/testApp.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

let app: FastifyInstance;
beforeEach(async () => {
  app = await createTestApp();
});
afterEach(async () => {
  await app.close();
});

describe("supplied fixtures", () => {
  it("01 receipt: normalizes to the exact contract shape", async () => {
    const bytes = fixture("01_receipt_with_allocations.xml");
    const res = await upload(app, bytes, "01_receipt_with_allocations.xml");
    expect(res.statusCode).toBe(201);
    const { importId } = res.json();

    expect(await getVouchers(app, importId)).toEqual({
      count: 1,
      items: [
        {
          source: { importId, contentHash: sha256(bytes), voucherIndex: 0 },
          attributes: { VCHTYPE: "Receipt", ACTION: "Create" },
          date: "20260715",
          voucherType: "Receipt",
          voucherNumber: "RCP-DEMO-001",
          partyLedgerName: "Demo Customer",
          narration: "Sanitized receipt fixture",
          ledgerEntries: [
            {
              sourceTag: "ALLLEDGERENTRIES.LIST",
              ledgerName: "Demo Bank",
              isDeemedPositive: "No",
              amount: "1250.00",
              billAllocations: [],
              bankAllocations: [
                { date: "20260715", name: "UTR-DEMO-001", transactionType: "Inter Bank Transfer", amount: "1250.00" },
              ],
              rateDetails: [],
            },
            {
              sourceTag: "ALLLEDGERENTRIES.LIST",
              ledgerName: "Demo Customer",
              isDeemedPositive: "Yes",
              amount: "-1250.00",
              billAllocations: [{ name: "INV-DEMO-001", billType: "Agst Ref", amount: "-1250.00" }],
              bankAllocations: [],
              rateDetails: [],
            },
          ],
          inventoryEntries: [],
          warnings: [],
        },
      ],
    });
  });

  it("02 sales invoice: keeps nested ownership and warns about PERSISTEDVIEW", async () => {
    const res = await upload(app, fixture("02_sales_invoice_nested.xml"));
    expect(res.json().summary).toEqual({ vouchers: 1, ledgerEntries: 3, inventoryEntries: 1, warnings: 1, errors: 0 });
    const [voucher] = (await getVouchers(app, res.json().importId)).items;

    expect(voucher.ledgerEntries.map((l: any) => [l.sourceTag, l.ledgerName, l.amount, l.rateDetails])).toEqual([
      ["LEDGERENTRIES.LIST", "Demo Customer", "-118.00", []],
      ["LEDGERENTRIES.LIST", "Output CGST", "9.00", [{ dutyHead: "CGST", rate: "9" }]],
      ["LEDGERENTRIES.LIST", "Output SGST", "9.00", [{ dutyHead: "SGST/UTGST", rate: "9" }]],
    ]);
    expect(voucher.ledgerEntries[0].billAllocations).toEqual([{ name: "SAL-DEMO-001", billType: "New Ref", amount: "-118.00" }]);
    expect(voucher.inventoryEntries).toEqual([
      {
        sourceTag: "ALLINVENTORYENTRIES.LIST",
        stockItemName: "Demo Item",
        isDeemedPositive: "No",
        actualQty: "2 PCS",
        billedQty: "2 PCS",
        rate: "50.00/PCS",
        amount: "100.00",
        batchAllocations: [
          { godownName: "Main Location", batchName: "Primary Batch", actualQty: "2 PCS", billedQty: "2 PCS", amount: "100.00" },
        ],
        accountingAllocations: [
          {
            ledgerName: "Demo Sales",
            isDeemedPositive: "No",
            amount: "100.00",
            rateDetails: [
              { dutyHead: "CGST", rate: "9" },
              { dutyHead: "SGST/UTGST", rate: "9" },
            ],
          },
        ],
        rateDetails: [],
      },
    ]);
    expect(voucher.warnings).toEqual([
      expect.objectContaining({ code: "UNKNOWN_NODE_NOT_NORMALIZED", path: "ENVELOPE/BODY/DATA/COLLECTION/VOUCHER[0]/PERSISTEDVIEW" }),
    ]);
  });

  it("03 Tally error response: accepted (201) but businessStatus failed", async () => {
    const res = await upload(app, fixture("03_tally_error_response.xml"));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ documentType: "tallyResponse", status: "completed" });

    expect((await getDetails(app, res.json().importId)).tallyResponse).toEqual({
      businessStatus: "failed",
      counters: { CREATED: "0", ALTERED: "0", DELETED: "0", IGNORED: "1", ERRORS: "1" },
      lineError: "Demo ledger does not exist",
      lineErrors: ["Demo ledger does not exist"],
    });
  });

  it("04 UTF-16 with &#4;: decoded, sanitized and warned", async () => {
    const bytes = fixture("04_utf16_invalid_control_ref.xml");
    const { importId } = (await upload(app, bytes)).json();
    const details = await getDetails(app, importId);
    const [voucher] = (await getVouchers(app, importId)).items;

    expect(details).toMatchObject({ detectedEncoding: "UTF-16LE", contentHash: sha256(bytes) });
    expect(details.warnings).toEqual([
      expect.objectContaining({ code: "ILLEGAL_XML_CHARACTER_REMOVED", path: "ENVELOPE/BODY/DATA/COLLECTION/VOUCHER[0]/NARRATION" }),
    ]);
    expect(voucher.narration).toBe("Recoverable control reference  in UTF-16 input");
    expect(voucher.ledgerEntries.map((l: any) => l.amount)).toEqual(["-75.50", "75.50"]);
  });

  it("05 empty collection: completed with zero counts", async () => {
    const res = await upload(app, fixture("05_empty_collection.xml"));
    expect(res.statusCode).toBe(201);
    expect(res.json().summary).toEqual({ vouchers: 0, ledgerEntries: 0, inventoryEntries: 0, warnings: 0, errors: 0 });
  });

  it("06 duplicate receipt: same bytes as 01, so the original import is returned", async () => {
    expect(sha256(fixture("06_duplicate_receipt.xml"))).toBe(sha256(fixture("01_receipt_with_allocations.xml")));
    const first = await upload(app, fixture("01_receipt_with_allocations.xml"), "01_receipt_with_allocations.xml");
    const second = await upload(app, fixture("06_duplicate_receipt.xml"), "06_duplicate_receipt.xml");

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ importId: first.json().importId, duplicate: true });
    expect(countRows(app, "vouchers")).toBe(1);
  });

  it("07 UTF-8 with BOM: decoded without warnings", async () => {
    const { importId, summary } = (await upload(app, fixture("07_utf8_bom_payment.xml"))).json();
    const [voucher] = (await getVouchers(app, importId)).items;

    expect(summary.warnings).toBe(0);
    expect(voucher.voucherNumber).toBe("PAY-DEMO-UTF8-BOM");
    expect(voucher.ledgerEntries.map((l: any) => l.amount)).toEqual(["-42.10", "42.10"]);
  });
});
