import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";

export const TEST_MAX_UPLOAD_BYTES = 64 * 1024;

// A fresh app with its own in-memory database, so tests never share state.
export function createTestApp(dbPath = ":memory:"): Promise<FastifyInstance> {
  return buildApp({
    port: 0,
    host: "127.0.0.1",
    dbPath,
    maxUploadBytes: TEST_MAX_UPLOAD_BYTES,
    logLevel: "silent",
  });
}

export interface Part {
  name: string;
  content: Buffer | string;
  filename?: string;
}

// Builds a multipart/form-data body by hand so the exact bytes are under our control.
export function multipart(parts: Part[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----tally-test-${randomBytes(8).toString("hex")}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = `form-data; name="${part.name}"${part.filename !== undefined ? `; filename="${part.filename}"` : ""}`;
    const type = part.filename !== undefined ? "Content-Type: application/xml\r\n" : "";
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${type}\r\n`));
    chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content, "utf8"));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

export function upload(app: FastifyInstance, content: Buffer | string, filename = "upload.xml") {
  return app.inject({
    method: "POST",
    url: "/api/tally/imports",
    ...multipart([{ name: "file", filename, content }]),
  });
}

export function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function getVouchers(app: FastifyInstance, importId: string) {
  const res = await app.inject({ method: "GET", url: `/api/tally/imports/${importId}/vouchers` });
  return res.json() as { items: any[]; count: number };
}

export async function getDetails(app: FastifyInstance, importId: string) {
  const res = await app.inject({ method: "GET", url: `/api/tally/imports/${importId}` });
  return res.json() as any;
}

export function countRows(app: FastifyInstance, table: string): number {
  return app.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;
}
