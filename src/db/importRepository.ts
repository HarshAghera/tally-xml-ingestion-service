import { randomUUID } from "node:crypto";
import type { DocumentType, ProcessedDocument } from "../tally/process.js";
import type {
  AccountingAllocation,
  ImportSummary,
  InventoryEntry,
  Issue,
  LedgerEntry,
  LedgerSourceTag,
  NormalizedVoucher,
  RateDetail,
  TallyResponseResult,
} from "../tally/types.js";
import type { Db } from "./connection.js";

export interface StoredImport {
  id: string;
  contentHash: string;
  documentType: DocumentType;
  status: "completed" | "partial" | "failed";
  detectedEncoding: string;
  bom: boolean;
  originalFilename: string | null;
  byteSize: number;
  summary: ImportSummary;
  tallyResponse: TallyResponseResult | null;
  createdAt: string;
}

export interface SaveImportInput {
  contentHash: string;
  bytes: Uint8Array;
  originalFilename: string | null;
  processed: ProcessedDocument;
}

type Row = Record<string, unknown>;

export class ImportRepository {
  constructor(private readonly db: Db) {}

  // Saves an import and its whole voucher tree in ONE transaction. If the same
  // bytes were saved before, the UNIQUE(content_hash) insert does nothing and
  // the original import is returned instead. No check-then-insert race.
  saveImport(input: SaveImportInput): { stored: StoredImport; duplicate: boolean } {
    // IMMEDIATE takes the write lock up front, so two concurrent uploads queue
    // instead of both reading "not there yet".
    return this.db.transaction(() => {
      const id = randomUUID();
      const { processed: p } = input;
      const inserted = this.db
        .prepare(
          `INSERT INTO imports (id, content_hash, document_type, status, detected_encoding, had_bom,
             original_filename, byte_size, voucher_count, ledger_entry_count, inventory_entry_count,
             warning_count, error_count, tally_business_status, tally_response_json, created_at)
           VALUES (@id, @contentHash, @documentType, @status, @encoding, @bom, @filename, @byteSize,
             @vouchers, @ledgerEntries, @inventoryEntries, @warnings, @errors, @businessStatus, @tallyJson, @createdAt)
           ON CONFLICT (content_hash) DO NOTHING`,
        )
        .run({
          id,
          contentHash: input.contentHash,
          documentType: p.documentType,
          status: "completed", // "partial" is reserved for the optional per-voucher extension
          encoding: p.detectedEncoding,
          bom: p.bom ? 1 : 0,
          filename: input.originalFilename,
          byteSize: input.bytes.byteLength,
          ...p.summary,
          businessStatus: p.tallyResponse?.businessStatus ?? null,
          tallyJson: p.tallyResponse
            ? JSON.stringify({
                counters: p.tallyResponse.counters,
                lineError: p.tallyResponse.lineError,
                lineErrors: p.tallyResponse.lineErrors,
              })
            : null,
          createdAt: new Date().toISOString(),
        });

      if (inserted.changes === 0) {
        return { stored: this.findImportByHash(input.contentHash)!, duplicate: true };
      }

      this.db.prepare("INSERT INTO raw_sources (import_id, content) VALUES (?, ?)").run(id, Buffer.from(input.bytes));
      const voucherIds = this.insertVouchers(id, p.vouchers);
      this.insertIssues(id, p.issues, voucherIds);

      return { stored: this.findImport(id)!, duplicate: false };
    }).immediate();
  }

  findImport(id: string): StoredImport | undefined {
    const row = this.db.prepare("SELECT * FROM imports WHERE id = ?").get(id) as Row | undefined;
    return row && toStoredImport(row);
  }

  findImportByHash(contentHash: string): StoredImport | undefined {
    const row = this.db.prepare("SELECT * FROM imports WHERE content_hash = ?").get(contentHash) as Row | undefined;
    return row && toStoredImport(row);
  }

  listIssues(importId: string): Issue[] {
    const rows = this.db
      .prepare("SELECT * FROM import_issues WHERE import_id = ? ORDER BY position")
      .all(importId) as Row[];
    return rows.map(toIssue);
  }

  // Rebuilds the voucher tree with one query per table (not one per voucher),
  // ordered by position so arrays come back in source order.
  listVouchers(importId: string): NormalizedVoucher[] {
    const all = <T extends Row>(sql: string) => this.db.prepare(sql).all(importId) as T[];
    const ofImport = "SELECT v.id FROM vouchers v WHERE v.import_id = ?";

    const vouchers = all("SELECT * FROM vouchers WHERE import_id = ? ORDER BY voucher_index");
    const ledgers = all(`SELECT * FROM ledger_entries WHERE voucher_id IN (${ofImport}) ORDER BY voucher_id, position`);
    const ledgerIds = `SELECT id FROM ledger_entries WHERE voucher_id IN (${ofImport})`;
    const bills = all(`SELECT * FROM bill_allocations WHERE ledger_entry_id IN (${ledgerIds}) ORDER BY ledger_entry_id, position`);
    const banks = all(`SELECT * FROM bank_allocations WHERE ledger_entry_id IN (${ledgerIds}) ORDER BY ledger_entry_id, position`);
    const inventories = all(`SELECT * FROM inventory_entries WHERE voucher_id IN (${ofImport}) ORDER BY voucher_id, position`);
    const inventoryIds = `SELECT id FROM inventory_entries WHERE voucher_id IN (${ofImport})`;
    const batches = all(`SELECT * FROM batch_allocations WHERE inventory_entry_id IN (${inventoryIds}) ORDER BY inventory_entry_id, position`);
    const accountings = all(`SELECT * FROM accounting_allocations WHERE inventory_entry_id IN (${inventoryIds}) ORDER BY inventory_entry_id, position`);
    const accountingIds = `SELECT id FROM accounting_allocations WHERE inventory_entry_id IN (${inventoryIds})`;
    const rates = this.db
      .prepare(
        `SELECT * FROM rate_details
         WHERE ledger_entry_id IN (${ledgerIds}) OR inventory_entry_id IN (${inventoryIds})
            OR accounting_allocation_id IN (${accountingIds})
         ORDER BY position`,
      )
      .all(importId, importId, importId) as Row[];
    const issues = this.listIssues(importId);

    const rateDetails = (column: string, ownerId: unknown): RateDetail[] =>
      rates.filter((r) => r[column] === ownerId).map((r) => ({ dutyHead: text(r.duty_head), rate: text(r.rate) }));

    return vouchers.map((v) => ({
      voucherIndex: Number(v.voucher_index),
      attributes: {
        ...(v.vch_type !== null ? { VCHTYPE: String(v.vch_type) } : {}),
        ...(v.action !== null ? { ACTION: String(v.action) } : {}),
      },
      date: text(v.date),
      voucherType: text(v.voucher_type),
      voucherNumber: text(v.voucher_number),
      partyLedgerName: text(v.party_ledger_name),
      narration: text(v.narration),
      ledgerEntries: ledgers
        .filter((l) => l.voucher_id === v.id)
        .map(
          (l): LedgerEntry => ({
            sourceTag: l.source_tag as LedgerSourceTag,
            ledgerName: text(l.ledger_name),
            isDeemedPositive: text(l.is_deemed_positive),
            amount: text(l.amount),
            billAllocations: bills
              .filter((b) => b.ledger_entry_id === l.id)
              .map((b) => ({ name: text(b.name), billType: text(b.bill_type), amount: text(b.amount) })),
            bankAllocations: banks
              .filter((b) => b.ledger_entry_id === l.id)
              .map((b) => ({
                date: text(b.date),
                name: text(b.name),
                transactionType: text(b.transaction_type),
                amount: text(b.amount),
              })),
            rateDetails: rateDetails("ledger_entry_id", l.id),
          }),
        ),
      inventoryEntries: inventories
        .filter((i) => i.voucher_id === v.id)
        .map(
          (i): InventoryEntry => ({
            sourceTag: "ALLINVENTORYENTRIES.LIST",
            stockItemName: text(i.stock_item_name),
            isDeemedPositive: text(i.is_deemed_positive),
            actualQty: text(i.actual_qty),
            billedQty: text(i.billed_qty),
            rate: text(i.rate),
            amount: text(i.amount),
            batchAllocations: batches
              .filter((b) => b.inventory_entry_id === i.id)
              .map((b) => ({
                godownName: text(b.godown_name),
                batchName: text(b.batch_name),
                actualQty: text(b.actual_qty),
                billedQty: text(b.billed_qty),
                amount: text(b.amount),
              })),
            accountingAllocations: accountings
              .filter((a) => a.inventory_entry_id === i.id)
              .map(
                (a): AccountingAllocation => ({
                  ledgerName: text(a.ledger_name),
                  isDeemedPositive: text(a.is_deemed_positive),
                  amount: text(a.amount),
                  rateDetails: rateDetails("accounting_allocation_id", a.id),
                }),
              ),
            rateDetails: rateDetails("inventory_entry_id", i.id),
          }),
        ),
      warnings: issues.filter((x) => x.voucherIndex === Number(v.voucher_index)),
    }));
  }

  // Returns voucherIndex → row id, so issues can point at their voucher row.
  private insertVouchers(importId: string, vouchers: NormalizedVoucher[]): Map<number, number> {
    const db = this.db;
    const insVoucher = db.prepare(
      `INSERT INTO vouchers (import_id, voucher_index, vch_type, action, date, voucher_type, voucher_number,
         party_ledger_name, narration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insLedger = db.prepare(
      `INSERT INTO ledger_entries (voucher_id, position, source_tag, ledger_name, is_deemed_positive, amount)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insBill = db.prepare(
      "INSERT INTO bill_allocations (ledger_entry_id, position, name, bill_type, amount) VALUES (?, ?, ?, ?, ?)",
    );
    const insBank = db.prepare(
      `INSERT INTO bank_allocations (ledger_entry_id, position, date, name, transaction_type, amount)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insInventory = db.prepare(
      `INSERT INTO inventory_entries (voucher_id, position, source_tag, stock_item_name, is_deemed_positive,
         actual_qty, billed_qty, rate, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insBatch = db.prepare(
      `INSERT INTO batch_allocations (inventory_entry_id, position, godown_name, batch_name, actual_qty, billed_qty, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insAccounting = db.prepare(
      `INSERT INTO accounting_allocations (inventory_entry_id, position, ledger_name, is_deemed_positive, amount)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insRate = db.prepare(
      `INSERT INTO rate_details (ledger_entry_id, inventory_entry_id, accounting_allocation_id, position, duty_head, rate)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertRates = (owner: [number | null, number | null, number | null], rates: RateDetail[]) =>
      rates.forEach((r, pos) => insRate.run(...owner, pos, r.dutyHead, r.rate));

    const ids = new Map<number, number>();
    for (const v of vouchers) {
      const voucherId = Number(
        insVoucher.run(
          importId,
          v.voucherIndex,
          v.attributes.VCHTYPE ?? null,
          v.attributes.ACTION ?? null,
          v.date,
          v.voucherType,
          v.voucherNumber,
          v.partyLedgerName,
          v.narration,
        ).lastInsertRowid,
      );
      ids.set(v.voucherIndex, voucherId);

      v.ledgerEntries.forEach((l, pos) => {
        const ledgerId = Number(
          insLedger.run(voucherId, pos, l.sourceTag, l.ledgerName, l.isDeemedPositive, l.amount).lastInsertRowid,
        );
        l.billAllocations.forEach((b, i) => insBill.run(ledgerId, i, b.name, b.billType, b.amount));
        l.bankAllocations.forEach((b, i) => insBank.run(ledgerId, i, b.date, b.name, b.transactionType, b.amount));
        insertRates([ledgerId, null, null], l.rateDetails);
      });

      v.inventoryEntries.forEach((inv, pos) => {
        const invId = Number(
          insInventory.run(
            voucherId,
            pos,
            inv.sourceTag,
            inv.stockItemName,
            inv.isDeemedPositive,
            inv.actualQty,
            inv.billedQty,
            inv.rate,
            inv.amount,
          ).lastInsertRowid,
        );
        inv.batchAllocations.forEach((b, i) =>
          insBatch.run(invId, i, b.godownName, b.batchName, b.actualQty, b.billedQty, b.amount),
        );
        inv.accountingAllocations.forEach((a, i) => {
          const accId = Number(insAccounting.run(invId, i, a.ledgerName, a.isDeemedPositive, a.amount).lastInsertRowid);
          insertRates([null, null, accId], a.rateDetails);
        });
        insertRates([null, invId, null], inv.rateDetails);
      });
    }
    return ids;
  }

  private insertIssues(importId: string, issues: Issue[], voucherIds: Map<number, number>): void {
    const ins = this.db.prepare(
      `INSERT INTO import_issues (import_id, position, voucher_id, voucher_index, severity, code, message, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    issues.forEach((issue, pos) => {
      const voucherId = issue.voucherIndex === null ? null : (voucherIds.get(issue.voucherIndex) ?? null);
      ins.run(importId, pos, voucherId, issue.voucherIndex, issue.severity, issue.code, issue.message, issue.path);
    });
  }
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toStoredImport(row: Row): StoredImport {
  const tally = row.tally_response_json
    ? (JSON.parse(String(row.tally_response_json)) as Omit<TallyResponseResult, "businessStatus">)
    : null;
  return {
    id: String(row.id),
    contentHash: String(row.content_hash),
    documentType: row.document_type as DocumentType,
    status: row.status as StoredImport["status"],
    detectedEncoding: String(row.detected_encoding),
    bom: row.had_bom === 1,
    originalFilename: text(row.original_filename),
    byteSize: Number(row.byte_size),
    summary: {
      vouchers: Number(row.voucher_count),
      ledgerEntries: Number(row.ledger_entry_count),
      inventoryEntries: Number(row.inventory_entry_count),
      warnings: Number(row.warning_count),
      errors: Number(row.error_count),
    },
    tallyResponse: tally
      ? { businessStatus: row.tally_business_status as TallyResponseResult["businessStatus"], ...tally }
      : null,
    createdAt: String(row.created_at),
  };
}

function toIssue(row: Row): Issue {
  return {
    severity: row.severity as Issue["severity"],
    code: String(row.code),
    message: String(row.message),
    path: text(row.path),
    voucherIndex: row.voucher_index === null ? null : Number(row.voucher_index),
  };
}
