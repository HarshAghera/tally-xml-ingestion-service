import path from "node:path";

export interface AppConfig {
  port: number;
  host: string;
  /** SQLite file path; ":memory:" is for tests only. */
  dbPath: string;
  /** Uploads larger than this are rejected. */
  maxUploadBytes: number;
  logLevel: string;
}

// Fail fast on a bad value rather than silently falling back to the default.
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    port: intFromEnv("PORT", 3000),
    host: process.env.HOST ?? "127.0.0.1",
    dbPath: process.env.DB_PATH ?? path.join("data", "tally.db"),
    maxUploadBytes: intFromEnv("MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
    logLevel: process.env.LOG_LEVEL ?? "info",
  };
}
