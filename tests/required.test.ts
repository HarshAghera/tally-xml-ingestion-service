// The six behaviours the assignment requires, tested through the real HTTP API.
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_COLLECTION,
  RECEIPT,
  SALES_INVOICE,
  TALLY_ERROR_RESPONSE,
  envelope,
  journalUtf16Be,
  journalUtf16Le,
  paymentUtf8Bom,
} from "./support/samples.js";
import { countRows, createTestApp, getDetails, getVouchers, sha256, upload } from "./support/testApp.js";

let app: FastifyInstance;
beforeEach(async () => {
  app = await createTestApp();
});
afterEach(async () => {
  await app.close();
});

describe("1. repeated ledger entries remain separate and ordered", () => {
  it("keeps both receipt entries in source order with their own values", async () => {
    const { importId } = (await upload(app, RECEIPT)).json();
    const [voucher] = (await getVouchers(app, importId)).items;

    expect(voucher.ledgerEntries.map((l: any) => [l.ledgerName, l.amount])).toEqual([
      ["Bank A", "1250.00"],
      ["Customer A", "-1250.00"],
    ]);
  });

  it("keeps each allocation under the ledger entry it appeared in", async () => {
    const { importId } = (await upload(app, RECEIPT)).json();
    const [bank, customer] = (await getVouchers(app, importId)).items[0].ledgerEntries;

    expect(bank.bankAllocations).toEqual([
      { date: "20260715", name: "UTR-001", transactionType: "Inter Bank Transfer", amount: "1250.00" },
    ]);
    expect(bank.billAllocations).toEqual([]);
    expect(customer.billAllocations).toEqual([{ name: "INV-001", billType: "Agst Ref", amount: "-1250.00" }]);
    expect(customer.bankAllocations).toEqual([]);
  });

  it("does not merge entries whose values are identical", async () => {
    const same = `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>10.00</AMOUNT></ALLLEDGERENTRIES.LIST>`;
    const xml = envelope(`<VOUCHER><DATE>1</DATE><VOUCHERTYPENAME>J</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER>${same}${same}${same}</VOUCHER>`);
    const { importId } = (await upload(app, xml)).json();
    const [voucher] = (await getVouchers(app, importId)).items;

    expect(voucher.ledgerEntries).toHaveLength(3);
    expect(countRows(app, "ledger_entries")).toBe(3);
  });

  it("keeps a single .LIST occurrence as a one-item array", async () => {
    const xml = envelope(
      `<VOUCHER><ALLLEDGERENTRIES.LIST><AMOUNT>5</AMOUNT><BILLALLOCATIONS.LIST><AMOUNT>5</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST></VOUCHER>`,
    );
    const { importId } = (await upload(app, xml)).json();
    const [voucher] = (await getVouchers(app, importId)).items;

    expect(Array.isArray(voucher.ledgerEntries)).toBe(true);
    expect(voucher.ledgerEntries[0].billAllocations).toEqual([{ name: null, billType: null, amount: "5" }]);
    expect(voucher.ledgerEntries[0].bankAllocations).toEqual([]);
    expect(voucher.inventoryEntries).toEqual([]);
  });
});

describe("2. ledger, bill, inventory, batch and accounting AMOUNTs are not overwritten", () => {
  it("returns each AMOUNT under its own parent", async () => {
    const { importId } = (await upload(app, SALES_INVOICE)).json();
    const [voucher] = (await getVouchers(app, importId)).items;
    const [customer, cgst, sgst] = voucher.ledgerEntries;
    const [inventory] = voucher.inventoryEntries;

    expect(customer.amount).toBe("-118.00");
    expect(customer.billAllocations[0].amount).toBe("-117.99");
    expect(cgst.amount).toBe("9.00");
    expect(sgst.amount).toBe("9.00");
    expect(inventory.amount).toBe("100.00");
    expect(inventory.batchAllocations[0].amount).toBe("100.01");
    expect(inventory.accountingAllocations[0].amount).toBe("100.02");
  });

  it("keeps rate details under their direct owner, including equal duplicates", async () => {
    const { importId } = (await upload(app, SALES_INVOICE)).json();
    const [voucher] = (await getVouchers(app, importId)).items;
    const [, cgst, sgst] = voucher.ledgerEntries;
    const [inventory] = voucher.inventoryEntries;

    expect(cgst.rateDetails).toEqual([{ dutyHead: "CGST", rate: "9" }]);
    expect(sgst.rateDetails).toEqual([]);
    expect(inventory.rateDetails).toEqual([]);
    expect(inventory.accountingAllocations[0].rateDetails).toEqual([
      { dutyHead: "CGST", rate: "9" },
      { dutyHead: "CGST", rate: "9" },
    ]);
  });

  it("matches the normalized contract for the inventory entry", async () => {
    const { importId } = (await upload(app, SALES_INVOICE)).json();
    const [voucher] = (await getVouchers(app, importId)).items;

    expect(voucher.inventoryEntries[0]).toEqual({
      sourceTag: "ALLINVENTORYENTRIES.LIST",
      stockItemName: "Item A",
      isDeemedPositive: "No",
      actualQty: "2 PCS",
      billedQty: "2 PCS",
      rate: "50.00/PCS",
      amount: "100.00",
      batchAllocations: [
        { godownName: "Main Location", batchName: "Primary Batch", actualQty: "2 PCS", billedQty: "2 PCS", amount: "100.01" },
      ],
      accountingAllocations: [
        {
          ledgerName: "Sales A",
          isDeemedPositive: "No",
          amount: "100.02",
          rateDetails: [
            { dutyHead: "CGST", rate: "9" },
            { dutyHead: "CGST", rate: "9" },
          ],
        },
      ],
      rateDetails: [],
    });
  });
});

describe("3. duplicate bytes under a different filename return the original import", () => {
  it("returns 200 with the same importId and stores no extra vouchers", async () => {
    const first = await upload(app, RECEIPT, "receipt.xml");
    const second = await upload(app, RECEIPT, "renamed-copy.xml");

    expect(first.statusCode).toBe(201);
    expect(first.json().duplicate).toBe(false);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ...first.json(), duplicate: true });
    expect(countRows(app, "imports")).toBe(1);
    expect(countRows(app, "vouchers")).toBe(1);
    expect(countRows(app, "ledger_entries")).toBe(2);
  });

  it("treats a one-byte difference as new content", async () => {
    const first = await upload(app, RECEIPT);
    const second = await upload(app, RECEIPT + " ");

    expect(second.statusCode).toBe(201);
    expect(second.json().importId).not.toBe(first.json().importId);
  });
});

describe("4. UTF-16 and illegal control-reference recovery records a warning", () => {
  it("decodes UTF-16LE, removes &#4; and records a warning on the voucher", async () => {
    const bytes = journalUtf16Le();
    const res = await upload(app, bytes);
    expect(res.statusCode).toBe(201);
    const { importId, summary } = res.json();

    const details = await getDetails(app, importId);
    expect(details.detectedEncoding).toBe("UTF-16LE");
    expect(details.contentHash).toBe(sha256(bytes));
    expect(summary.warnings).toBe(1);
    expect(details.warnings).toEqual([
      expect.objectContaining({
        code: "ILLEGAL_XML_CHARACTER_REMOVED",
        path: "ENVELOPE/BODY/DATA/COLLECTION/VOUCHER[0]/NARRATION",
        voucherIndex: 0,
      }),
    ]);

    const [voucher] = (await getVouchers(app, importId)).items;
    expect(voucher.narration).toBe("Control reference  in UTF-16 input");
    expect(voucher.ledgerEntries.map((l: any) => l.amount)).toEqual(["-75.50", "75.50"]);
    expect(voucher.warnings).toHaveLength(1);
  });

  it("retains the exact original bytes for investigation", async () => {
    const bytes = journalUtf16Le();
    const { importId } = (await upload(app, bytes)).json();
    const raw = app.db.prepare("SELECT content FROM raw_sources WHERE import_id = ?").pluck().get(importId) as Buffer;

    expect(Buffer.compare(raw, bytes)).toBe(0);
  });

  it("decodes UTF-16BE with BOM the same way", async () => {
    const { importId } = (await upload(app, journalUtf16Be())).json();
    const details = await getDetails(app, importId);
    const [voucher] = (await getVouchers(app, importId)).items;

    expect(details.detectedEncoding).toBe("UTF-16BE");
    expect(voucher.voucherNumber).toBe("JRN-UTF16");
  });

  it("decodes UTF-8 with BOM without a warning", async () => {
    const { importId, summary } = (await upload(app, paymentUtf8Bom())).json();
    const [voucher] = (await getVouchers(app, importId)).items;

    expect(summary.warnings).toBe(0);
    expect((await getDetails(app, importId)).detectedEncoding).toBe("UTF-8");
    expect(voucher.narration).toBe("Café ₹ payment");
  });
});

describe("5. a Tally response with ERRORS=1 is a business failure despite upload success", () => {
  it("returns 201 completed, but businessStatus failed with counters and lineError", async () => {
    const res = await upload(app, TALLY_ERROR_RESPONSE);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ documentType: "tallyResponse", status: "completed", duplicate: false });

    const details = await getDetails(app, res.json().importId);
    expect(details.tallyResponse).toMatchObject({
      businessStatus: "failed",
      counters: { CREATED: "0", ALTERED: "0", DELETED: "0", IGNORED: "1", ERRORS: "1" },
      lineError: "Ledger does not exist",
    });
    expect((await getVouchers(app, res.json().importId)).count).toBe(0);
  });

  it("fails on ERRORS=1 alone, without any LINEERROR", async () => {
    const res = await upload(app, `<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS></RESPONSE>`);
    expect(res.statusCode).toBe(201);
    expect((await getDetails(app, res.json().importId)).tallyResponse).toMatchObject({
      businessStatus: "failed",
      lineError: null,
    });
  });
});

describe("6. an empty collection and an unknown child do not crash or invent vouchers", () => {
  it("completes an empty collection with zero counts", async () => {
    const res = await upload(app, EMPTY_COLLECTION);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: "completed",
      summary: { vouchers: 0, ledgerEntries: 0, inventoryEntries: 0, warnings: 0, errors: 0 },
    });
    expect(await getVouchers(app, res.json().importId)).toEqual({ items: [], count: 0 });
  });

  it("warns about an unknown voucher child without normalizing it", async () => {
    const { importId, summary } = (await upload(app, SALES_INVOICE)).json();
    const [voucher] = (await getVouchers(app, importId)).items;

    expect(summary.vouchers).toBe(1);
    expect(voucher.warnings).toEqual([
      expect.objectContaining({
        code: "UNKNOWN_NODE_NOT_NORMALIZED",
        path: "ENVELOPE/BODY/DATA/COLLECTION/VOUCHER[0]/PERSISTEDVIEW",
      }),
    ]);
    expect(JSON.stringify(voucher)).not.toContain("Invoice Voucher View");
  });

  it("does not turn a non-VOUCHER collection child or a nested UDF into a voucher", async () => {
    const xml = envelope(
      `<TALLYMESSAGE><VOUCHER><DATE>99</DATE></VOUCHER></TALLYMESSAGE>` +
        `<VOUCHER><DATE>1</DATE><VOUCHERTYPENAME>J</VOUCHERTYPENAME><VOUCHERNUMBER>V1</VOUCHERNUMBER>` +
        `<UDF:CUSTOM.LIST><UDF:VALUE>secret-udf-value</UDF:VALUE></UDF:CUSTOM.LIST></VOUCHER>`,
    );
    const res = await upload(app, xml);
    const { items } = await getVouchers(app, res.json().importId);

    expect(res.statusCode).toBe(201);
    expect(items).toHaveLength(1);
    expect(items[0].voucherNumber).toBe("V1");
    expect(JSON.stringify(items)).not.toContain("secret-udf-value");
    expect(res.json().summary.warnings).toBe(2);
  });
});
