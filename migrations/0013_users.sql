-- DB-backed login accounts, replacing the single APP_USERS env-var pair with
-- a real table the Admin tab can manage (add users, reset passwords, set an
-- email) without SQL. password_hash stores "salt:derivedKeyHex" from Node's
-- scrypt (see hashPassword/verifyPassword in db.js) — never plaintext.

CREATE TABLE users (
  id            serial PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  email         text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
