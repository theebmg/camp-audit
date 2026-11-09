-- Favorites pinned at the top of the menu (Nov 2026).
--
-- Each user keeps their own: any screen (Work Orders, Maintenance Log), a single record
-- (one work order, one asset), the board report, or a saved report view. Stored as the
-- screen name plus its parameters — the same pair the app navigates with — and the label
-- the person chose. Per username, so Ben's shortcuts are not everyone's menu.
BEGIN;
CREATE TABLE nav_favorites (
  id          serial PRIMARY KEY,
  username    text NOT NULL,
  label       text NOT NULL,
  icon        text,
  view        text NOT NULL,
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nav_favorites_username_idx ON nav_favorites (username, sort_order, id);
COMMIT;
