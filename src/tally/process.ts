import { AppError } from "../errors.js";
import { decodeXmlBytes, isDeclaredEncodingConsistent, type DetectedEncoding } from "../xml/decode.js";
import { sanitizeXmlText, type Removal } from "../xml/sanitize.js";
import { locateOffset, parseXmlTree, type XmlElement } from "../xml/tree.js";
import { parseTallyResponse } from "./tallyResponse.js";
import type { ImportSummary, Issue, NormalizedVoucher, TallyResponseResult } from "./types.js";
import { normalizeVoucherExport } from "./voucherExport.js";
import { IssueLog, pathOfAncestry } from "./walk.js";

export type DocumentType = "voucherExport" | "tallyResponse";

export interface ProcessedDocument {
  documentType: DocumentType;
  detectedEncoding: DetectedEncoding;
  bom: boolean;
  vouchers: NormalizedVoucher[];
  tallyResponse: TallyResponseResult | null;
  /** Every warning/error for the import; voucher ones also appear on their voucher. */
  issues: Issue[];
  summary: ImportSummary;
}

// Bytes in, normalized document out. Pure: no database, no I/O, so it is easy to
// test and the same code can later run inside a streaming worker.
export function processDocument(bytes: Uint8Array): ProcessedDocument {
  const decoded = decodeXmlBytes(bytes);
  const sanitized = sanitizeXmlText(decoded.text);
  const { root, declaredEncoding } = parseXmlTree(sanitized.text);
  const log = new IssueLog();

  if (!isDeclaredEncodingConsistent(declaredEncoding, decoded.encoding)) {
    log.warn(
      "ENCODING_DECLARATION_MISMATCH",
      `The XML declaration says "${declaredEncoding}" but the bytes are ${decoded.encoding}; the bytes were trusted.`,
      null,
    );
  }

  let documentType: DocumentType;
  let vouchers: NormalizedVoucher[] = [];
  let voucherElements: XmlElement[] = [];
  let tallyResponse: TallyResponseResult | null = null;

  if (root.name === "ENVELOPE") {
    documentType = "voucherExport";
    ({ vouchers, voucherElements } = normalizeVoucherExport(root, log));
  } else if (root.name === "RESPONSE") {
    documentType = "tallyResponse";
    tallyResponse = parseTallyResponse(root, log);
  } else {
    throw new AppError(
      "UNSUPPORTED_DOCUMENT",
      422,
      `Root element <${root.name.slice(0, 64)}> is not supported; expected ENVELOPE or RESPONSE.`,
    );
  }

  recordRemovals(root, sanitized.removals, voucherElements, log);

  for (const voucher of vouchers) {
    voucher.warnings = log.issues.filter((i) => i.voucherIndex === voucher.voucherIndex);
  }

  return {
    documentType,
    detectedEncoding: decoded.encoding,
    bom: decoded.bom,
    vouchers,
    tallyResponse,
    issues: log.issues,
    summary: {
      vouchers: vouchers.length,
      ledgerEntries: vouchers.reduce((n, v) => n + v.ledgerEntries.length, 0),
      inventoryEntries: vouchers.reduce((n, v) => n + v.inventoryEntries.length, 0),
      warnings: log.issues.filter((i) => i.severity === "warning").length,
      errors: log.issues.filter((i) => i.severity === "error").length,
    },
  };
}

// One warning per element that had characters removed, naming the path and the
// voucher, so a reviewer can find exactly which value was changed.
function recordRemovals(root: XmlElement, removals: Removal[], voucherElements: XmlElement[], log: IssueLog): void {
  const byPath = new Map<string, { sources: string[]; voucherIndex: number | null; path: string | null }>();

  for (const removal of removals) {
    const located = locateOffset(root, removal.offset);
    const path = located ? pathOfAncestry(located.ancestry) : null;
    const voucherEl = located?.ancestry.find((el) => voucherElements.includes(el));
    const voucherIndex = voucherEl ? voucherElements.indexOf(voucherEl) : null;
    const key = path ?? "(outside root)";

    const entry = byPath.get(key) ?? { sources: [], voucherIndex, path };
    entry.sources.push(removal.source);
    byPath.set(key, entry);
  }

  for (const { sources, voucherIndex, path } of byPath.values()) {
    const shown = [...new Set(sources)].slice(0, 5).join(", ");
    log.warn(
      "ILLEGAL_XML_CHARACTER_REMOVED",
      `Removed ${sources.length} character(s) not allowed in XML 1.0 (${shown}); the original bytes are retained.`,
      path,
      voucherIndex,
    );
  }
}
