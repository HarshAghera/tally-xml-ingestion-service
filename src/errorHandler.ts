import type { FastifyError, FastifyInstance } from "fastify";
import { AppError } from "./errors.js";

// Every error leaves as { error: { code, message } }. Stack traces, raw XML and
// file paths never reach the client; unexpected errors are logged server-side only.
export function registerErrorHandling(app: FastifyInstance, maxUploadBytes: number): void {
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const known = toClientError(err, maxUploadBytes);
    if (known) {
      request.log.info({ code: known.code, status: known.status }, "request rejected");
      return reply.code(known.status).send({ error: { code: known.code, message: known.message } });
    }

    // Log the error object (message + stack) but never the request body.
    request.log.error({ err }, "unhandled error");
    return reply
      .code(500)
      .send({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: `No route for ${request.method} ${request.url}.` } }),
  );
}

interface ClientError {
  status: number;
  code: string;
  message: string;
}

function toClientError(err: FastifyError, maxUploadBytes: number): ClientError | undefined {
  if (err instanceof AppError) return { status: err.statusCode, code: err.code, message: err.message };

  switch (err.code) {
    case "FST_REQ_FILE_TOO_LARGE":
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return {
        status: 413,
        code: "PAYLOAD_TOO_LARGE",
        message: `The uploaded file exceeds the ${maxUploadBytes}-byte limit.`,
      };
    case "FST_FILES_LIMIT":
    case "FST_PARTS_LIMIT":
    case "FST_FIELDS_LIMIT":
      return { status: 413, code: "TOO_MANY_PARTS", message: "Upload exactly one file in the field \"file\"." };
    case "FST_INVALID_MULTIPART_CONTENT_TYPE":
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      return {
        status: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Send the XML as multipart/form-data in a field named \"file\".",
      };
  }

  // Other Fastify 4xx errors (bad headers, malformed multipart, ...) are the
  // client's fault; a generic message avoids echoing internals.
  if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
    return { status: err.statusCode, code: "BAD_REQUEST", message: "The request could not be processed." };
  }
  return undefined;
}
