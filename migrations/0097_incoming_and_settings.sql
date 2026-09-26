-- Text intake (brief §3–§7): the Incoming inbox, its filing history, and the settings the
-- webhook reads.
--
-- Nothing files automatically. Every item lands here and waits to be confirmed by hand, which
-- is why this is an inbox and not a router.

-- ── Incoming items ───────────────────────────────────────────────────────
CREATE TABLE incoming_items (
  id            serial PRIMARY KEY,

  -- Where it came from. 'text' today; the column exists so an emailed item could land here
  -- later without a migration.
  source        text NOT NULL DEFAULT 'text' CHECK (source IN ('text', 'email', 'manual')),
  -- The provider's own id for the delivery. UNIQUE is the idempotency guarantee (§3): a
  -- retried webhook finds the row already there and changes nothing.
  external_id   text UNIQUE,
  from_number   text,

  -- The message as sent, with the category hint word left in. The hint is stripped for
  -- display, not from the record — what arrived is what is stored.
  body_text     text,
  -- The first word, when it named a category. Pre-selects, never files (§5).
  hint          text CHECK (hint IS NULL OR hint IN ('visitor', 'receipt', 'fix', 'note')),

  -- Already converted to America/New_York (§4). A 9 PM text must not land on the next day.
  received_at   timestamptz NOT NULL,
  received_date date NOT NULL,
  received_time time NOT NULL,

  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'filed', 'dismissed')),

  -- What it became, once filed. Nullable because most items are new.
  filed_as      text CHECK (filed_as IS NULL OR filed_as IN ('visitor', 'receipt', 'fix', 'note')),
  filed_entity  text,
  filed_entity_id integer,
  filed_by      text,
  filed_at      timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_incoming_items_updated_at BEFORE UPDATE ON incoming_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_incoming_items_status ON incoming_items (status, received_at DESC);
CREATE INDEX idx_incoming_items_received ON incoming_items (received_at DESC);

-- ── Filing history ───────────────────────────────────────────────────────
-- "Move to…" (§6) re-files an item as another category. Every move is recorded, including
-- what it was removed from, so the trail survives the thing it used to point at.
CREATE TABLE incoming_moves (
  id           serial PRIMARY KEY,
  item_id      integer NOT NULL REFERENCES incoming_items(id) ON DELETE CASCADE,
  from_kind    text,
  from_entity  text,
  from_entity_id integer,
  to_kind      text NOT NULL,
  to_entity    text,
  to_entity_id integer,
  -- Set when the old destination could not be safely removed (an expense already split
  -- across work orders, say). The move still happens; the UI says what was left behind.
  left_behind  text,
  moved_by     text,
  moved_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_incoming_moves_item ON incoming_moves (item_id, moved_at DESC);

-- ── Settings ─────────────────────────────────────────────────────────────
-- Single row, like display_settings and budget_settings. The API key and signing secret are
-- NOT here: they are environment variables, never database rows and never in source (§3).
CREATE TABLE text_intake_settings (
  id                     integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Only messages from these numbers are processed. Everything else is ignored by this
  -- system and keeps working normally in Quo (§3).
  allowed_senders        text[] NOT NULL DEFAULT '{}',
  -- "Got it — in Incoming." Default on (§7).
  send_confirmation      boolean NOT NULL DEFAULT true,
  confirmation_text      text NOT NULL DEFAULT 'Got it — in Incoming.',
  -- The number the camp replies from. Blank until Ben supplies it.
  reply_from_number      text,
  -- Counters for debugging, not content: a message from an unknown sender is counted and
  -- discarded, never stored (§3).
  ignored_sender_count   integer NOT NULL DEFAULT 0,
  last_ignored_at        timestamptz,
  last_delivery_at       timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_text_intake_settings_updated_at BEFORE UPDATE ON text_intake_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
INSERT INTO text_intake_settings (id) VALUES (1);

-- ── Text-sourced receipts and photos ─────────────────────────────────────
-- So "Move to…" can find what a text became, and so a receipt that arrived by text is
-- distinguishable from one that arrived by email without inspecting its attachments.
ALTER TABLE expenses ADD COLUMN incoming_item_id integer REFERENCES incoming_items(id) ON DELETE SET NULL;
CREATE INDEX idx_expenses_incoming ON expenses (incoming_item_id) WHERE incoming_item_id IS NOT NULL;

ALTER TABLE visits ADD COLUMN incoming_item_id integer REFERENCES incoming_items(id) ON DELETE SET NULL;
CREATE INDEX idx_visits_incoming ON visits (incoming_item_id) WHERE incoming_item_id IS NOT NULL;

ALTER TABLE attachment_batches ADD COLUMN incoming_item_id integer REFERENCES incoming_items(id) ON DELETE SET NULL;
CREATE INDEX idx_attachment_batches_incoming ON attachment_batches (incoming_item_id) WHERE incoming_item_id IS NOT NULL;
