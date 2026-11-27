// Shapes follow the normalized voucher contract. Every value is the exact source
// string (or null when the tag is absent), so money and quantities stay lossless.

export interface Issue {
  severity: "warning" | "error";
  code: string;
  message: string;
  /** Where in the XML, e.g. "ENVELOPE/BODY/DATA/COLLECTION/VOUCHER[0]/NARRATION". */
  path: string | null;
  /** Set when the issue belongs to one voucher. */
  voucherIndex: number | null;
}

export type Text = string | null;

export interface RateDetail {
  dutyHead: Text;
  rate: Text;
}

export interface BillAllocation {
  name: Text;
  billType: Text;
  amount: Text;
}

export interface BankAllocation {
  date: Text;
  name: Text;
  transactionType: Text;
  amount: Text;
}

export type LedgerSourceTag = "ALLLEDGERENTRIES.LIST" | "LEDGERENTRIES.LIST";

export interface LedgerEntry {
  sourceTag: LedgerSourceTag;
  ledgerName: Text;
  isDeemedPositive: Text;
  amount: Text;
  billAllocations: BillAllocation[];
  bankAllocations: BankAllocation[];
  rateDetails: RateDetail[];
}

export interface BatchAllocation {
  godownName: Text;
  batchName: Text;
  actualQty: Text;
  billedQty: Text;
  amount: Text;
}

export interface AccountingAllocation {
  ledgerName: Text;
  isDeemedPositive: Text;
  amount: Text;
  rateDetails: RateDetail[];
}

export interface InventoryEntry {
  sourceTag: "ALLINVENTORYENTRIES.LIST";
  stockItemName: Text;
  isDeemedPositive: Text;
  actualQty: Text;
  billedQty: Text;
  rate: Text;
  amount: Text;
  batchAllocations: BatchAllocation[];
  accountingAllocations: AccountingAllocation[];
  rateDetails: RateDetail[];
}

export interface NormalizedVoucher {
  /** Zero-based order among VOUCHER elements in the source. */
  voucherIndex: number;
  attributes: { VCHTYPE?: string; ACTION?: string };
  date: Text;
  voucherType: Text;
  voucherNumber: Text;
  partyLedgerName: Text;
  narration: Text;
  ledgerEntries: LedgerEntry[];
  inventoryEntries: InventoryEntry[];
  warnings: Issue[];
}

export const COUNTER_NAMES = ["CREATED", "ALTERED", "DELETED", "IGNORED", "ERRORS"] as const;
export type CounterName = (typeof COUNTER_NAMES)[number];

export interface TallyResponseResult {
  businessStatus: "succeeded" | "failed";
  /** Source strings, only for counters present in the XML. */
  counters: Partial<Record<CounterName, string>>;
  /** First LINEERROR (the contract field). */
  lineError: Text;
  /** Every LINEERROR in source order (extra field: Tally can report several). */
  lineErrors: string[];
}

export interface ImportSummary {
  vouchers: number;
  ledgerEntries: number;
  inventoryEntries: number;
  warnings: number;
  errors: number;
}
