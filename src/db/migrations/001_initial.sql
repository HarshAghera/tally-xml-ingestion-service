-- Relational rows for everything in the voucher contract, so each parent-child
-- link is a real foreign key you can query. Every repeated list keeps its
-- source order in `position`. Money/qty/rate columns are TEXT: SQLite never
-- converts them to floating point, so "-1250.00" and "2 PCS" stay exact.

CREATE TABLE imports (
  id                    TEXT PRIMARY KEY,
  -- UNIQUE is the idempotency guarantee: two uploads of the same bytes cannot
  -- both insert, even when they arrive at the same moment.
  content_hash          TEXT NOT NULL UNIQUE CHECK (length(content_hash) = 64),
  document_type         TEXT NOT NULL CHECK (document_type IN ('voucherExport', 'tallyResponse')),
  status                TEXT NOT NULL CHECK (status IN ('completed', 'partial', 'failed')),
  detected_encoding     TEXT NOT NULL,
  had_bom               INTEGER NOT NULL CHECK (had_bom IN (0, 1)),
  original_filename     TEXT,
  byte_size             INTEGER NOT NULL,
  voucher_count         INTEGER NOT NULL,
  ledger_entry_count    INTEGER NOT NULL,
  inventory_entry_count INTEGER NOT NULL,
  warning_count         INTEGER NOT NULL,
  error_count           INTEGER NOT NULL,
  -- Tally's own verdict, kept apart from our processing status.
  tally_business_status TEXT CHECK (tally_business_status IN ('succeeded', 'failed')),
  -- Small and shaped by whichever counters were present, so JSON fits better than columns.
  tally_response_json   TEXT,
  created_at            TEXT NOT NULL
);

-- Exact uploaded bytes, for investigating sanitizer or unknown-node warnings later.
-- A separate table keeps large blobs out of normal import queries.
CREATE TABLE raw_sources (
  import_id TEXT PRIMARY KEY REFERENCES imports(id) ON DELETE CASCADE,
  content   BLOB NOT NULL
);

CREATE TABLE vouchers (
  id                INTEGER PRIMARY KEY,
  import_id         TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  voucher_index     INTEGER NOT NULL,
  vch_type          TEXT,  -- VOUCHER/@VCHTYPE
  action            TEXT,  -- VOUCHER/@ACTION
  date              TEXT,
  voucher_type      TEXT,
  voucher_number    TEXT,
  party_ledger_name TEXT,
  narration         TEXT,
  UNIQUE (import_id, voucher_index)
);

CREATE TABLE ledger_entries (
  id                 INTEGER PRIMARY KEY,
  voucher_id         INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL,
  source_tag         TEXT NOT NULL CHECK (source_tag IN ('ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST')),
  ledger_name        TEXT,
  is_deemed_positive TEXT,
  amount             TEXT,
  UNIQUE (voucher_id, position)
);

CREATE TABLE bill_allocations (
  id              INTEGER PRIMARY KEY,
  ledger_entry_id INTEGER NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  name            TEXT,
  bill_type       TEXT,
  amount          TEXT,
  UNIQUE (ledger_entry_id, position)
);

CREATE TABLE bank_allocations (
  id               INTEGER PRIMARY KEY,
  ledger_entry_id  INTEGER NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  date             TEXT,
  name             TEXT,
  transaction_type TEXT,
  amount           TEXT,
  UNIQUE (ledger_entry_id, position)
);

CREATE TABLE inventory_entries (
  id                 INTEGER PRIMARY KEY,
  voucher_id         INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL,
  source_tag         TEXT NOT NULL CHECK (source_tag IN ('ALLINVENTORYENTRIES.LIST')),
  stock_item_name    TEXT,
  is_deemed_positive TEXT,
  actual_qty         TEXT,
  billed_qty         TEXT,
  rate               TEXT,
  amount             TEXT,
  UNIQUE (voucher_id, position)
);

CREATE TABLE batch_allocations (
  id                 INTEGER PRIMARY KEY,
  inventory_entry_id INTEGER NOT NULL REFERENCES inventory_entries(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL,
  godown_name        TEXT,
  batch_name         TEXT,
  actual_qty         TEXT,
  billed_qty         TEXT,
  amount             TEXT,
  UNIQUE (inventory_entry_id, position)
);

CREATE TABLE accounting_allocations (
  id                 INTEGER PRIMARY KEY,
  inventory_entry_id INTEGER NOT NULL REFERENCES inventory_entries(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL,
  ledger_name        TEXT,
  is_deemed_positive TEXT,
  amount             TEXT,
  UNIQUE (inventory_entry_id, position)
);

-- Rate details can hang off three kinds of parent. One nullable FK per parent
-- (exactly one set, enforced by CHECK) keeps real referential integrity,
-- unlike a generic "owner_type + owner_id" pair.
CREATE TABLE rate_details (
  id                       INTEGER PRIMARY KEY,
  ledger_entry_id          INTEGER REFERENCES ledger_entries(id) ON DELETE CASCADE,
  inventory_entry_id       INTEGER REFERENCES inventory_entries(id) ON DELETE CASCADE,
  accounting_allocation_id INTEGER REFERENCES accounting_allocations(id) ON DELETE CASCADE,
  position                 INTEGER NOT NULL,
  duty_head                TEXT,
  rate                     TEXT,
  CHECK ((ledger_entry_id IS NOT NULL) + (inventory_entry_id IS NOT NULL) + (accounting_allocation_id IS NOT NULL) = 1)
);
CREATE UNIQUE INDEX rate_details_ledger ON rate_details (ledger_entry_id, position) WHERE ledger_entry_id IS NOT NULL;
CREATE UNIQUE INDEX rate_details_inventory ON rate_details (inventory_entry_id, position) WHERE inventory_entry_id IS NOT NULL;
CREATE UNIQUE INDEX rate_details_accounting ON rate_details (accounting_allocation_id, position) WHERE accounting_allocation_id IS NOT NULL;

-- Warnings/errors for an import. voucher_id is set when the issue belongs to a voucher.
CREATE TABLE import_issues (
  id            INTEGER PRIMARY KEY,
  import_id     TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  voucher_id    INTEGER REFERENCES vouchers(id) ON DELETE CASCADE,
  voucher_index INTEGER,
  severity      TEXT NOT NULL CHECK (severity IN ('warning', 'error')),
  code          TEXT NOT NULL,
  message       TEXT NOT NULL,
  path          TEXT,
  UNIQUE (import_id, position)
);
CREATE INDEX import_issues_voucher ON import_issues (voucher_id) WHERE voucher_id IS NOT NULL;
