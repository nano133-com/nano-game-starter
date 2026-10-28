-- The admin's own sign-in records (Sign-ins card of /admin): who signed in lately, and "Sign out everywhere".
-- Only the time, the rough country and a short browser name are kept for a sign-in: no address, no IP address and no browser text. A row is kept for 30 days (the clean-up deletes the rest).

-- Whose login a session is: 'play' (the game's) or 'admin' (/admin's own login). "Sign out everywhere" deletes the admin ones and no other.
ALTER TABLE sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'play';
-- An admin login lasts exactly one day and a game login 30: the logins made before this column are told apart by their life.
UPDATE sessions SET scope = 'admin' WHERE expires_at - created_at = 86400000;

CREATE TABLE admin_logins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,        -- ms since 1970
  country TEXT,               -- two capital letters from the request's country header, or NULL
  browser TEXT NOT NULL       -- a short name from fixed lists: "Chrome on macOS"
);
CREATE INDEX admin_logins_by_time ON admin_logins (at);
