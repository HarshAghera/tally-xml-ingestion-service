// Normalizer rules, tested on processDocument directly (no HTTP, no database).
import { describe, expect, it } from "vitest";
import { processDocument } from "../src/tally/process.js";
import { RECEIPT, SALES_INVOICE, envelope, response } from "./support/samples.js";

const run = (xml: string) => processDocument(Buffer.from(xml, "utf8"));
const voucherOf = (inner: string) => run(envelope(`<VOUCHER>${inner}</VOUCHER>`)).vouchers[0]!;

describe("ownership and direct-child parsing", () => {
  it("never takes a voucher field from a descendant", () => {
    // DATE/NAME exist only inside the bank allocation, not on the voucher.
    const v = voucherOf(
      `<ALLLEDGERENTRIES.LIST><BANKALLOCATIONS.LIST><DATE>20260101</DATE><NAME>UTR</NAME></BANKALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>`,
    );
    expect(v.date).toBeNull();
    expect(v.ledgerEntries[0]!.bankAllocations[0]!.date).toBe("20260101");
  });

  it("keeps ledger and accounting LEDGERNAME apart", () => {
    const v = run(SALES_INVOICE).vouchers[0]!;
    expect(v.ledgerEntries.map((l) => l.ledgerName)).toEqual(["Customer A", "Output CGST", "Output SGST"]);
    expect(v.inventoryEntries[0]!.accountingAllocations[0]!.ledgerName).toBe("Sales A");
  });

  it("records the exact ledger source tag", () => {
    const v = voucherOf(
      `<ALLLEDGERENTRIES.LIST><AMOUNT>1</AMOUNT></ALLLEDGERENTRIES.LIST><LEDGERENTRIES.LIST><AMOUNT>2</AMOUNT></LEDGERENTRIES.LIST>`,
    );
    expect(v.ledgerEntries.map((l) => [l.sourceTag, l.amount])).toEqual([
      ["ALLLEDGERENTRIES.LIST", "1"],
      ["LEDGERENTRIES.LIST", "2"],
    ]);
  });

  it("keeps the first of a repeated scalar and warns", () => {
    const doc = run(envelope(`<VOUCHER><ALLLEDGERENTRIES.LIST><AMOUNT>1.00</AMOUNT><AMOUNT>2.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>`));
    expect(doc.vouchers[0]!.ledgerEntries[0]!.amount).toBe("1.00");
    expect(doc.issues).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_SCALAR", path: "ENVELOPE/BODY/DATA/COLLECTION/VOUCHER[0]/ALLLEDGERENTRIES.LIST[0]/AMOUNT[1]" }),
    );
  });

  it("assigns voucherIndex in source order", () => {
    const doc = run(envelope(`<VOUCHER><VOUCHERNUMBER>A</VOUCHERNUMBER></VOUCHER><VOUCHER><VOUCHERNUMBER>B</VOUCHERNUMBER></VOUCHER>`));
    expect(doc.vouchers.map((v) => [v.voucherIndex, v.voucherNumber])).toEqual([
      [0, "A"],
      [1, "B"],
    ]);
  });
});

describe("lossless values", () => {
  it("does not flip the sign based on ISDEEMEDPOSITIVE", () => {
    const [bank, customer] = run(RECEIPT).vouchers[0]!.ledgerEntries;
    expect([bank!.isDeemedPositive, bank!.amount]).toEqual(["No", "1250.00"]);
    expect([customer!.isDeemedPositive, customer!.amount]).toEqual(["Yes", "-1250.00"]);
  });

  it("keeps amounts, quantities and rates as exact source text", () => {
    const v = voucherOf(
      `<ALLINVENTORYENTRIES.LIST><ACTUALQTY> 2 PCS</ACTUALQTY><RATE>50.00/PCS</RATE>` +
        `<AMOUNT>12345678901234567890.123456789</AMOUNT></ALLINVENTORYENTRIES.LIST>`,
    );
    const inv = v.inventoryEntries[0]!;
    expect(inv.actualQty).toBe(" 2 PCS");
    expect(inv.rate).toBe("50.00/PCS");
    expect(inv.amount).toBe("12345678901234567890.123456789");
  });

  it("distinguishes an absent tag (null) from an empty one (\"\")", () => {
    const v = voucherOf(`<NARRATION/>`);
    expect(v.narration).toBe("");
    expect(v.partyLedgerName).toBeNull();
  });

  it("keeps VCHTYPE and ACTION attributes only when present", () => {
    expect(run(RECEIPT).vouchers[0]!.attributes).toEqual({ VCHTYPE: "Receipt", ACTION: "Create" });
    expect(voucherOf("").attributes).toEqual({});
  });
});

describe("unknown content", () => {
  it("warns about unknown attributes and nested unknown nodes with exact paths", () => {
    const doc = run(envelope(`<VOUCHER REMOTEID="r1"><ALLLEDGERENTRIES.LIST><UDF:NOTE>x</UDF:NOTE></ALLLEDGERENTRIES.LIST></VOUCHER>`));
    expect(doc.issues.map((i) => [i.code, i.path])).toEqual([
      ["UNKNOWN_ATTRIBUTE_NOT_NORMALIZED", "ENVELOPE/BODY/DATA/COLLECTION/VOUCHER[0]/@REMOTEID"],
      ["UNKNOWN_NODE_NOT_NORMALIZED", "ENVELOPE/BODY/DATA/COLLECTION/VOUCHER[0]/ALLLEDGERENTRIES.LIST[0]/UDF:NOTE"],
      ["MISSING_REQUIRED_FIELD", "ENVELOPE/BODY/DATA/COLLECTION/VOUCHER[0]/DATE"],
      ["MISSING_REQUIRED_FIELD", "ENVELOPE/BODY/DATA/COLLECTION/VOUCHER[0]/VOUCHERTYPENAME"],
      ["MISSING_REQUIRED_FIELD", "ENVELOPE/BODY/DATA/COLLECTION/VOUCHER[0]/VOUCHERNUMBER"],
    ]);
  });

  it("is not fooled by tag names that look like object properties", () => {
    const v = voucherOf(`<constructor>x</constructor><__proto__>y</__proto__><toString>z</toString>`);
    expect(v.date).toBeNull();
  });

  it("only treats ALLINVENTORYENTRIES.LIST as inventory (others are warned)", () => {
    const doc = run(envelope(`<VOUCHER><INVENTORYENTRIES.LIST><AMOUNT>1</AMOUNT></INVENTORYENTRIES.LIST></VOUCHER>`));
    expect(doc.vouchers[0]!.inventoryEntries).toEqual([]);
    expect(doc.issues[0]).toMatchObject({ code: "UNKNOWN_NODE_NOT_NORMALIZED" });
  });
});

describe("Tally response business status", () => {
  const status = (inner: string) => run(response(inner)).tallyResponse!;

  it("succeeds when ERRORS is 0 and there is no LINEERROR", () => {
    expect(status(`<CREATED>1</CREATED><ERRORS>0</ERRORS>`)).toMatchObject({ businessStatus: "succeeded", lineError: null });
  });

  it("fails on LINEERROR even when ERRORS is 0", () => {
    expect(status(`<ERRORS>0</ERRORS><LINEERROR>Bad ledger</LINEERROR>`).businessStatus).toBe("failed");
  });

  it("ignores a whitespace-only LINEERROR", () => {
    expect(status(`<ERRORS>0</ERRORS><LINEERROR>  </LINEERROR>`).businessStatus).toBe("succeeded");
  });

  it("fails on ERRORS > 0 even when the number is huge", () => {
    expect(status(`<ERRORS>99999999999999999999</ERRORS>`).businessStatus).toBe("failed");
  });

  it("fails and warns when ERRORS is not a number", () => {
    const doc = run(response(`<ERRORS>n/a</ERRORS>`));
    expect(doc.tallyResponse!.businessStatus).toBe("failed");
    expect(doc.issues[0]).toMatchObject({ code: "COUNTER_NOT_NUMERIC" });
  });

  it("keeps every LINEERROR in order, first one as lineError", () => {
    expect(status(`<ERRORS>2</ERRORS><LINEERROR>a</LINEERROR><LINEERROR>b</LINEERROR>`)).toMatchObject({
      lineError: "a",
      lineErrors: ["a", "b"],
    });
  });

  it("reads only direct children of RESPONSE", () => {
    const res = status(`<DATA><ERRORS>5</ERRORS></DATA><ERRORS>0</ERRORS>`);
    expect(res).toMatchObject({ businessStatus: "succeeded", counters: { ERRORS: "0" } });
  });
});
