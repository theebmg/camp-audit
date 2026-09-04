-- Freeform scratchpad notes — quick capture of ideas/reminders ("a program I
-- want to implement soon") with a user-typed category, not a fixed enum, so
-- Ben can invent new categories from the UI same as map layers do.
CREATE TABLE IF NOT EXISTS notes (
    id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title      text NOT NULL,
    body       text,
    category   text NOT NULL DEFAULT 'General',
    done       boolean NOT NULL DEFAULT false,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notes_category ON notes (category);
