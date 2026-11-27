import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { openDatabase, type Db } from "./db/connection.js";
import { ImportRepository } from "./db/importRepository.js";
import { runMigrations } from "./db/migrate.js";
import { registerErrorHandling } from "./errorHandler.js";
import { healthRoutes } from "./routes/health.js";
import { importRoutes } from "./routes/imports.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Exposed so tests can inspect stored rows directly. */
    db: Db;
  }
}

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel },
    bodyLimit: config.maxUploadBytes,
  });

  // Migrating on start keeps "one command to run" true for reviewers.
  const db = openDatabase(config.dbPath);
  runMigrations(db);
  app.decorate("db", db);
  app.addHook("onClose", async () => db.close());

  registerErrorHandling(app, config.maxUploadBytes);

  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 10,
      fieldSize: 1024,
      parts: 20,
    },
  });

  await app.register(healthRoutes);
  await app.register(importRoutes, { repo: new ImportRepository(db) });

  return app;
}
