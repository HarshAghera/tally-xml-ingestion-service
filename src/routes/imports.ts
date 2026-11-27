import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ImportRepository, StoredImport } from "../db/importRepository.js";
import { AppError } from "../errors.js";
import { processDocument } from "../tally/process.js";

export interface ImportRoutesOptions {
  repo: ImportRepository;
}

export async function importRoutes(app: FastifyInstance, { repo }: ImportRoutesOptions): Promise<void> {
  app.post("/api/tally/imports", async (request, reply) => {
    const { bytes, filename } = await readUploadedFile(request);
    // Identity is the exact bytes, never the filename or the decoded text.
    const contentHash = createHash("sha256").update(bytes).digest("hex");

    // Fast path for re-uploads; correctness still comes from saveImport's UNIQUE insert.
    const existing = repo.findImportByHash(contentHash);
    if (existing) {
      logImport(request, existing, true);
      return reply.code(200).send(uploadResponse(existing, true));
    }

    const processed = processDocument(bytes);
    const { stored, duplicate } = repo.saveImport({ contentHash, bytes, originalFilename: filename, processed });
    logImport(request, stored, duplicate);
    return reply.code(duplicate ? 200 : 201).send(uploadResponse(stored, duplicate));
  });

  app.get<{ Params: { importId: string } }>("/api/tally/imports/:importId", async (request) => {
    const stored = findOr404(repo, request.params.importId);
    const issues = repo.listIssues(stored.id);
    return {
      importId: stored.id,
      documentType: stored.documentType,
      status: stored.status,
      contentHash: stored.contentHash,
      detectedEncoding: stored.detectedEncoding,
      summary: stored.summary,
      warnings: issues.filter((i) => i.severity === "warning"),
      errors: issues.filter((i) => i.severity === "error"),
      ...(stored.tallyResponse ? { tallyResponse: stored.tallyResponse } : {}),
      // Extra, documented fields useful for diagnostics.
      bom: stored.bom,
      originalFilename: stored.originalFilename,
      byteSize: stored.byteSize,
      createdAt: stored.createdAt,
    };
  });

  app.get<{ Params: { importId: string } }>("/api/tally/imports/:importId/vouchers", async (request) => {
    const stored = findOr404(repo, request.params.importId);
    const items = repo.listVouchers(stored.id).map(({ voucherIndex, ...voucher }) => ({
      source: { importId: stored.id, contentHash: stored.contentHash, voucherIndex },
      ...voucher,
    }));
    return { items, count: items.length };
  });
}

// Reads every multipart part so the "one file only" limit is enforced (a second
// file is rejected, not silently ignored). The size limit applies while streaming,
// so an oversized upload is cut off instead of being buffered whole.
async function readUploadedFile(request: FastifyRequest): Promise<{ bytes: Buffer; filename: string | null }> {
  let upload: { bytes: Buffer; filename: string | null } | undefined;
  for await (const part of request.parts()) {
    if (part.type !== "file") continue; // plain text fields are ignored
    if (part.fieldname !== "file") {
      part.file.resume(); // drain it so the request can finish
      continue;
    }
    upload = { bytes: await part.toBuffer(), filename: safeFilename(part.filename) };
  }
  if (!upload) {
    throw new AppError("MISSING_FILE", 400, "Upload the XML in a multipart field named \"file\".");
  }
  return upload;
}

// Keep only the base name, so a client-sent path is never stored or echoed back.
function safeFilename(name: string | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255);
  return base === "" ? null : base;
}

function findOr404(repo: ImportRepository, importId: string): StoredImport {
  const stored = repo.findImport(importId);
  if (!stored) throw new AppError("IMPORT_NOT_FOUND", 404, "No import exists with that id.");
  return stored;
}

function uploadResponse(stored: StoredImport, duplicate: boolean) {
  return {
    importId: stored.id,
    documentType: stored.documentType,
    status: stored.status,
    duplicate,
    summary: stored.summary,
  };
}

// Metadata only: the XML content is never logged.
function logImport(request: FastifyRequest, stored: StoredImport, duplicate: boolean): void {
  request.log.info(
    {
      importId: stored.id,
      contentHash: stored.contentHash,
      byteSize: stored.byteSize,
      documentType: stored.documentType,
      duplicate,
      summary: stored.summary,
    },
    "import accepted",
  );
}
