-- The owner's passkeys for /admin (README, "Signing in to /admin"): the two tables that "@nano133/nanoterra/admin-signin/d1.sql" ends with since kit
-- 0.12.0, copied as the package ships them. A passkey is only a key to /admin: the money stays in the owner's wallet. Only a WALLET admin login of the
-- game's own address (RECEIVE_ADDRESS) writes a link, and the passkey proves its key in the same call. Without these tables the wallet sign-in works as before.
-- Times are milliseconds since 1970 (Date.now()).

-- One row for each passkey linked to an owner address (at most 10 for an owner). A new RECEIVE_ADDRESS has no links: the old owner's passkeys open nothing.
CREATE TABLE IF NOT EXISTS admin_passkeys (
  owner TEXT NOT NULL,
  address TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner, address)
);

-- Each passkey signature (a link or a sign-in) counts once: its key, kept until `until` (the clean-up deletes the rest).
CREATE TABLE IF NOT EXISTS admin_once (
  key TEXT PRIMARY KEY,
  until INTEGER NOT NULL
);
