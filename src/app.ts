import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { healthRoutes } from "./routes/health.js";

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel },
    bodyLimit: config.maxUploadBytes,
  });

  await app.register(healthRoutes);

  return app;
}
