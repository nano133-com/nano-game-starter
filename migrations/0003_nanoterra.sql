-- Sign in from Nanoterra (README, "Sign in from Nanoterra"). A session made from a Nanoterra sign-in says so (`via`): it never
-- opens /admin. The name and the character that Nanoterra sent at the last sign-in stay here, in YOUR database, for the game's
-- own screens.
ALTER TABLE sessions ADD COLUMN via TEXT NOT NULL DEFAULT 'wallet'; -- wallet | nanoterra

CREATE TABLE nanoterra_players (
  address TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  look TEXT NOT NULL,                 -- JSON: the five colours of the player's Nanoterra character
  items TEXT NOT NULL,                -- JSON: the ids of the cosmetics the player owns on Nanoterra
  updated_at INTEGER NOT NULL
);
