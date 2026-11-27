import { AppError } from "../errors.js";
import type { XmlElement } from "../xml/tree.js";
import type {
  AccountingAllocation,
  BankAllocation,
  BatchAllocation,
  BillAllocation,
  InventoryEntry,
  LedgerEntry,
  LedgerSourceTag,
  NormalizedVoucher,
  RateDetail,
} from "./types.js";
import { firstChild, IssueLog, readChildren, segment } from "./walk.js";

export interface VoucherExportResult {
  vouchers: NormalizedVoucher[];
  /** The VOUCHER elements, indexed by voucherIndex (used to attribute sanitizer warnings). */
  voucherElements: XmlElement[];
}

// Walks ENVELOPE/BODY/DATA/COLLECTION and normalizes each VOUCHER.
// Siblings we don't read are warned about, so nothing is dropped silently.
export function normalizeVoucherExport(envelope: XmlElement, log: IssueLog): VoucherExportResult {
  const body = descend(envelope, "BODY", "ENVELOPE", ["HEADER"], log);
  const data = descend(body, "DATA", "ENVELOPE/BODY", [], log);
  const collection = descend(data, "COLLECTION", "ENVELOPE/BODY/DATA", [], log);
  const collectionPath = "ENVELOPE/BODY/DATA/COLLECTION";

  const vouchers: NormalizedVoucher[] = [];
  const voucherElements: XmlElement[] = [];
  const seen = new Map<string, number>();

  for (const child of collection.children) {
    const index = seen.get(child.name) ?? 0;
    seen.set(child.name, index + 1);

    if (child.name !== "VOUCHER") {
      log.warn(
        "UNKNOWN_NODE_NOT_NORMALIZED",
        `${child.name} is not a VOUCHER; it is kept in the raw upload only.`,
        `${collectionPath}/${segment(child.name, index)}`,
      );
      continue;
    }
    vouchers.push(normalizeVoucher(child, index, `${collectionPath}/${segment("VOUCHER", index)}`, log));
    voucherElements.push(child);
  }

  return { vouchers, voucherElements };
}

// Moves one level down the envelope. A missing level means this is not a voucher
// export we support (e.g. an IMPORTRESULT envelope), so the upload is rejected.
function descend(
  parent: XmlElement,
  name: string,
  parentPath: string,
  ignored: readonly string[],
  log: IssueLog,
): XmlElement {
  const child = firstChild(parent, name);
  if (!child) {
    throw new AppError(
      "UNSUPPORTED_DOCUMENT",
      422,
      `ENVELOPE is not a voucher export: ${parentPath}/${name} is missing.`,
    );
  }
  let count = 0;
  for (const sibling of parent.children) {
    if (sibling === child || ignored.includes(sibling.name)) continue;
    if (sibling.name === name) count++;
    log.warn(
      "UNKNOWN_NODE_NOT_NORMALIZED",
      sibling.name === name
        ? `Only the first ${name} is read; this one is kept in the raw upload only.`
        : `${sibling.name} is not part of the voucher export path; it is kept in the raw upload only.`,
      `${parentPath}/${sibling.name === name ? `${name}[${count}]` : sibling.name}`,
    );
  }
  return child;
}

const REQUIRED_VOUCHER_FIELDS = [
  ["DATE", "date"],
  ["VOUCHERTYPENAME", "voucherType"],
  ["VOUCHERNUMBER", "voucherNumber"],
] as const;

function normalizeVoucher(el: XmlElement, voucherIndex: number, path: string, log: IssueLog): NormalizedVoucher {
  const ledgerEntries: LedgerEntry[] = [];
  const inventoryEntries: InventoryEntry[] = [];
  const ledger = (sourceTag: LedgerSourceTag) => (child: XmlElement, childPath: string) =>
    ledgerEntries.push(readLedgerEntry(child, childPath, sourceTag, log, voucherIndex));

  const v = readChildren(
    el,
    path,
    {
      attributes: ["VCHTYPE", "ACTION"],
      scalars: {
        DATE: "date",
        VOUCHERTYPENAME: "voucherType",
        VOUCHERNUMBER: "voucherNumber",
        PARTYLEDGERNAME: "partyLedgerName",
        NARRATION: "narration",
      },
      lists: {
        "ALLLEDGERENTRIES.LIST": ledger("ALLLEDGERENTRIES.LIST"),
        "LEDGERENTRIES.LIST": ledger("LEDGERENTRIES.LIST"),
        "ALLINVENTORYENTRIES.LIST": (child, childPath) =>
          inventoryEntries.push(readInventoryEntry(child, childPath, log, voucherIndex)),
      },
    },
    log,
    voucherIndex,
  );

  // Core scope keeps such vouchers; flagging them lets a reviewer spot bad data.
  for (const [tag, field] of REQUIRED_VOUCHER_FIELDS) {
    if (v[field] === null || v[field].trim() === "") {
      log.warn("MISSING_REQUIRED_FIELD", `Voucher has no ${tag}.`, `${path}/${tag}`, voucherIndex);
    }
  }

  const attributes: NormalizedVoucher["attributes"] = {};
  if (el.attributes.VCHTYPE !== undefined) attributes.VCHTYPE = el.attributes.VCHTYPE;
  if (el.attributes.ACTION !== undefined) attributes.ACTION = el.attributes.ACTION;

  return {
    voucherIndex,
    attributes,
    date: v.date,
    voucherType: v.voucherType,
    voucherNumber: v.voucherNumber,
    partyLedgerName: v.partyLedgerName,
    narration: v.narration,
    ledgerEntries,
    inventoryEntries,
    warnings: [], // filled by processDocument once all warnings (incl. sanitizer) are known
  };
}

function readLedgerEntry(
  el: XmlElement,
  path: string,
  sourceTag: LedgerSourceTag,
  log: IssueLog,
  vi: number,
): LedgerEntry {
  const billAllocations: BillAllocation[] = [];
  const bankAllocations: BankAllocation[] = [];
  const rateDetails: RateDetail[] = [];

  const f = readChildren(
    el,
    path,
    {
      scalars: { LEDGERNAME: "ledgerName", ISDEEMEDPOSITIVE: "isDeemedPositive", AMOUNT: "amount" },
      lists: {
        "BILLALLOCATIONS.LIST": (c, p) =>
          billAllocations.push(
            readChildren(c, p, { scalars: { NAME: "name", BILLTYPE: "billType", AMOUNT: "amount" } }, log, vi),
          ),
        "BANKALLOCATIONS.LIST": (c, p) =>
          bankAllocations.push(
            readChildren(
              c,
              p,
              { scalars: { DATE: "date", NAME: "name", TRANSACTIONTYPE: "transactionType", AMOUNT: "amount" } },
              log,
              vi,
            ),
          ),
        "RATEDETAILS.LIST": (c, p) => rateDetails.push(readRateDetail(c, p, log, vi)),
      },
    },
    log,
    vi,
  );

  // isDeemedPositive is reported as-is and never used to flip the amount's sign.
  return { sourceTag, ...f, billAllocations, bankAllocations, rateDetails };
}

function readInventoryEntry(el: XmlElement, path: string, log: IssueLog, vi: number): InventoryEntry {
  const batchAllocations: BatchAllocation[] = [];
  const accountingAllocations: AccountingAllocation[] = [];
  const rateDetails: RateDetail[] = [];

  const f = readChildren(
    el,
    path,
    {
      scalars: {
        STOCKITEMNAME: "stockItemName",
        ISDEEMEDPOSITIVE: "isDeemedPositive",
        ACTUALQTY: "actualQty",
        BILLEDQTY: "billedQty",
        RATE: "rate",
        AMOUNT: "amount",
      },
      lists: {
        "BATCHALLOCATIONS.LIST": (c, p) =>
          batchAllocations.push(
            readChildren(
              c,
              p,
              {
                scalars: {
                  GODOWNNAME: "godownName",
                  BATCHNAME: "batchName",
                  ACTUALQTY: "actualQty",
                  BILLEDQTY: "billedQty",
                  AMOUNT: "amount",
                },
              },
              log,
              vi,
            ),
          ),
        "ACCOUNTINGALLOCATIONS.LIST": (c, p) => accountingAllocations.push(readAccountingAllocation(c, p, log, vi)),
        "RATEDETAILS.LIST": (c, p) => rateDetails.push(readRateDetail(c, p, log, vi)),
      },
    },
    log,
    vi,
  );

  return { sourceTag: "ALLINVENTORYENTRIES.LIST", ...f, batchAllocations, accountingAllocations, rateDetails };
}

function readAccountingAllocation(el: XmlElement, path: string, log: IssueLog, vi: number): AccountingAllocation {
  const rateDetails: RateDetail[] = [];
  const f = readChildren(
    el,
    path,
    {
      scalars: { LEDGERNAME: "ledgerName", ISDEEMEDPOSITIVE: "isDeemedPositive", AMOUNT: "amount" },
      lists: { "RATEDETAILS.LIST": (c, p) => rateDetails.push(readRateDetail(c, p, log, vi)) },
    },
    log,
    vi,
  );
  return { ...f, rateDetails };
}

function readRateDetail(el: XmlElement, path: string, log: IssueLog, vi: number): RateDetail {
  return readChildren(el, path, { scalars: { GSTRATEDUTYHEAD: "dutyHead", GSTRATE: "rate" } }, log, vi);
}
