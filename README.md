# Tally XML Ingestion Service

Ingests Tally XML, stores it in SQLite without losing parent-child relationships, and serves normalized vouchers as JSON.

Tally XML repeats tags like `AMOUNT` at several levels. Here the XML is parsed into an ordered tree, and every value is read only from its **direct** parent, so no value can overwrite another.

**Stack:** Node.js 22 + TypeScript, Fastify, SQLite (`better-sqlite3`), `saxes`, Vitest.

## Run it

```bash
npm install
npm start      # applies migrations, serves http://127.0.0.1:3000
npm test       # 74 tests, ~5 s
```

No database server or Docker is needed. `npm run migrate` applies migrations without starting the server. The schema is in [`src/db/migrations/001_initial.sql`](src/db/migrations/001_initial.sql).

| Env var            | Default              |                          |
| ------------------ | -------------------- | ------------------------ |
| `PORT` / `HOST`    | `3000` / `127.0.0.1` |                          |
| `DB_PATH`          | `data/tally.db`      | SQLite file              |
| `MAX_UPLOAD_BYTES` | `10485760`           | Larger uploads get `413` |
| `LOG_LEVEL`        | `info`               | `silent` turns logs off  |

## API

```bash
curl http://127.0.0.1:3000/health                                   # {"status":"ok"}

curl -F "file=@tests/fixtures/01_receipt_with_allocations.xml" http://127.0.0.1:3000/api/tally/imports
# 201 {"importId":"c5cf…","documentType":"voucherExport","status":"completed","duplicate":false,
#      "summary":{"vouchers":1,"ledgerEntries":2,"inventoryEntries":0,"warnings":0,"errors":0}}

curl -F "file=@tests/fixtures/06_duplicate_receipt.xml" http://127.0.0.1:3000/api/tally/imports
# 200, same importId, "duplicate":true   (06 is byte-identical to 01)

curl http://127.0.0.1:3000/api/tally/imports/<importId>            # import details
curl http://127.0.0.1:3000/api/tally/imports/<importId>/vouchers   # {"items":[…],"count":1}
```

Import details for fixture 03 (a Tally error response). The upload returned `201` and was `completed`, but Tally's own operation failed:

```json
{
  "importId": "39a8…",
  "documentType": "tallyResponse",
  "status": "completed",
  "contentHash": "2a869c2f…f5d1",
  "detectedEncoding": "UTF-8",
  "summary": {
    "vouchers": 0,
    "ledgerEntries": 0,
    "inventoryEntries": 0,
    "warnings": 0,
    "errors": 0
  },
  "warnings": [],
  "errors": [],
  "tallyResponse": {
    "businessStatus": "failed",
    "counters": {
      "CREATED": "0",
      "ALTERED": "0",
      "DELETED": "0",
      "IGNORED": "1",
      "ERRORS": "1"
    },
    "lineError": "Demo ledger does not exist",
    "lineErrors": ["Demo ledger does not exist"]
  },
  "bom": false,
  "originalFilename": "03_tally_error_response.xml",
  "byteSize": 228,
  "createdAt": "…"
}
```

Each warning names the exact place in the XML, e.g. `{"code":"ILLEGAL_XML_CHARACTER_REMOVED","path":"ENVELOPE/BODY/DATA/COLLECTION/VOUCHER[0]/NARRATION","voucherIndex":0,…}`.

**Errors** are always `{"error":{"code","message"}}`, never with stack traces, XML or file paths. Rejected uploads are not stored.

| HTTP | Code                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------- |
| 400  | `MISSING_FILE`, `EMPTY_DOCUMENT`, `INVALID_ENCODING`, `DTD_NOT_ALLOWED`, `MALFORMED_XML`, `XML_TOO_DEEP` |
| 413  | `PAYLOAD_TOO_LARGE`, `TOO_MANY_PARTS` (more than one file)                                               |
| 415  | `UNSUPPORTED_MEDIA_TYPE` (not multipart)                                                                 |
| 422  | `UNSUPPORTED_DOCUMENT` (root not `ENVELOPE`/`RESPONSE`, or no `BODY/DATA/COLLECTION`)                    |
| 404  | `IMPORT_NOT_FOUND`, `NOT_FOUND`                                                                          |

## Design decisions

- **Ownership:** `saxes` builds an ordered element tree. [`readChildren`](src/tally/walk.ts) reads only direct children against a per-level allow-list. Unknown nodes and attributes become warnings with their path; they are never guessed at or dropped silently. Every `.LIST` is always an array, kept in source order, and rows with equal values are never merged.
- **Lossless values:** values are the exact source text: untrimmed, not parsed, and the sign is never changed by `ISDEEMEDPOSITIVE`. An absent tag gives `null`; an empty tag gives `""`. Money, quantity and rate columns are `TEXT`, so there is no floating point anywhere.
- **Encodings:** a BOM decides first, otherwise UTF-16 is recognised from `<?`, otherwise the file is UTF-8. Decoding is strict: bad bytes get `400`, never `�`. Characters XML 1.0 forbids (e.g. `&#4;`) are removed, except inside CDATA and comments. Each removal produces a warning naming the element. The exact bytes are kept in `raw_sources`.
- **Idempotency:** the content hash is SHA-256 of the exact bytes. `content_hash` is `UNIQUE`, and the whole import is saved in one `BEGIN IMMEDIATE` transaction using `INSERT … ON CONFLICT DO NOTHING`, so the database decides atomically, with no check-then-insert gap. A pre-check by hash only skips parsing for re-uploads.
- **Tally result:** only direct `RESPONSE` children are read. `businessStatus` is `failed` if `ERRORS > 0` (compared as a `BigInt`) or any `LINEERROR` has text. An unreadable `ERRORS` also counts as `failed`, so success is never reported unconfirmed.
- **Schema: relational, with one JSON column.** Each level of the tree is a table with a real FK and a `position` column (`UNIQUE(parent, position)`), so ownership is enforced by the database and can be queried with SQL. `rate_details` has three nullable FKs (ledger entry, inventory entry, accounting allocation), with a `CHECK` that exactly one is set. Only the Tally counters are JSON: they are small, always read whole, and their shape varies. `tally_business_status` is still a real column.

**Assumptions**

- Rejected (4xx) files are not persisted, so every stored import is `completed`; `failed` and `partial` are unused.
- Missing `DATE`/`VOUCHERTYPENAME`/`VOUCHERNUMBER` gives a warning and the voucher is kept (rejecting it is extension 1).
- A repeated single-value tag keeps its first value, with a warning.
- `INVENTORYENTRIES.LIST` and `IMPORTRESULT` are out of scope.
- Import details `warnings` lists all warnings for the import; voucher-specific ones also carry `voucherIndex`.
- Extra fields: `bom`, `originalFilename` (base name only), `byteSize`, `createdAt`, `lineErrors`.

## Security

In place:

- `DOCTYPE` is rejected, which blocks XXE and entity expansion; nothing from the XML is executed.
- Limits: a configurable size limit enforced while streaming, one file per request, and a nesting depth of 64.
- Strict decoding.
- Safe error bodies.
- Logs record only the import ID, hash, size and counts.
- Client filenames are reduced to a base name.

**I would add in production:** authentication and per-tenant isolation, rate limits, TLS, encrypted raw storage with retention and deletion rules, malware scanning, audit logs, CPU and element-count limits on parsing, and dependency scanning.

## Large-file design (500 MB)

The core buffers the upload and processes it within the request, which is fine up to the 10 MB default. For 500 MB:

1. **Upload:** stream the body to object storage while computing SHA-256 and enforcing the size limit, then return `202` with `status: "processing"`. Clients poll the details endpoint. No parsing happens inside the HTTP request.
2. **Idempotency:** claim the hash with `INSERT … ON CONFLICT DO NOTHING` and `status='processing'`, plus a worker lease, so a crashed worker's job can be taken over by another.
3. **Parsing:** feed chunks through a streaming `TextDecoder` (multi-byte characters split across chunks stay intact), then a sanitizer with a small tail buffer (so `&#` | `4;` split across chunks is caught), then `saxes`. **`VOUCHER` is the object boundary:** build, normalize and release one voucher at a time, and cap the size of a single voucher. Memory is then bounded by the largest voucher, not by the file.
4. **Database:** commit about 500 vouchers per transaction, saving `last_committed_voucher_index` in the same transaction. On restart, re-parse from the start and skip committed vouchers; that is simpler and safer than saving parser state mid-file. `UNIQUE(import_id, voucher_index)` blocks duplicate rows. Bigger batches are faster but hold the lock longer. At this scale I'd move to PostgreSQL (concurrent writers, `COPY`).
5. **Storage and cleanup:** raw files go in encrypted object storage keyed by hash, with retention rules. The database keeps a reference, not a 500 MB BLOB. Temp files are removed in `finally`, and a sweeper removes orphans.
6. **Backpressure and timeouts:** use `pipeline()` streams, so the upload and the parser pause while the database catches up. Bound the queues and concurrency per tenant, and reply `429`/`503` with `Retry-After` when they're full. Uploads time out on _minimum throughput_, not total time. Workers have their own job timeout and heartbeat.

## Tests

`npm test` runs 74 tests:

- [`required.test.ts`](tests/required.test.ts): the brief's six required behaviours, numbered 1–6.
- [`fixtures.test.ts`](tests/fixtures.test.ts): all seven fixtures, with an exact contract match for 01 and 02.
- [`normalize.test.ts`](tests/normalize.test.ts), [`xml.test.ts`](tests/xml.test.ts): parsing rules, encodings and DOCTYPE/XXE rejection.
- [`api.test.ts`](tests/api.test.ts): response shapes, linked SQL rows and limits.
- [`concurrency.test.ts`](tests/concurrency.test.ts): parallel requests and 6 racing OS processes, each producing exactly one import.

To check the tests catch real bugs, the code was deliberately broken 8 times (for example: no `UNIQUE`, `ERRORS=1` treated as success, a descendant-wide search, a sign flipped, `DOCTYPE` allowed). Every break failed the suite.

## Extensions and status

| Extension                      | Status                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| 1. Per-voucher partial failure | Not attempted                                                                           |
| 2. Streaming                   | Not attempted (designed above)                                                          |
| 3. Concurrency proof           | **Done** ([`concurrency.test.ts`](tests/concurrency.test.ts))                           |
| 4. Unknown-node preservation   | Partly: unknown-node paths are stored in `import_issues`, alongside the full raw upload |
| 5. `IMPORTRESULT` envelope     | Not attempted (gets `422`)                                                              |

The required core is complete. Next steps, with the risk while each is missing:

| Next step                                    | Risk until then                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| Async streaming ingestion                    | Large uploads are processed on the request thread and slow everyone down               |
| Partial failure (ext. 1)                     | Vouchers missing key fields are stored, with warnings only                             |
| Auth and tenant isolation                    | Anyone with network access can upload and read imports                                 |
| Encrypted raw storage, retention, PostgreSQL | Raw XML is unencrypted and kept forever; SQLite means a single writer on a single node |

## Time spent

| Phase                                       | Planned |    Actual |
| ------------------------------------------- | ------: | --------: |
| 1. Skeleton · 2. XML layer · 3. Normalizers |  2.75 h |     2.5 h |
| 4. Database · 5. API                        |   1.5 h |     1.5 h |
| 6. Tests · 7. README                        |  1.75 h |     1.5 h |
| **Total**                                   | **6 h** | **5.5 h** |

## AI usage

**Tool:** Claude Code (Anthropic) in VS Code. It helped turn the brief into a plan, write the code, tests and this README under my direction, and run checks.

**What I personally verified:**

- I read the brief, the normalized contract and the submission checklist, and understood the task before any code was written. I approved the plan (stack, phases) before implementation started.
- I worked phase by phase. Each phase was built and left uncommitted; I reviewed the result and its check output, then approved the commit. That gives one commit per phase.
