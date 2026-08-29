-- Admin/Standard role for accounts, so the Dashboard can scope "recent
-- activity" (admin sees everyone's, standard sees only their own). Doesn't
-- gate any other part of the app yet — that's a separate decision if wanted
-- later.
ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'standard' CHECK (role IN ('admin','standard'));
