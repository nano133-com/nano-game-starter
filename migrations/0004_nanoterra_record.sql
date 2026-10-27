-- The whole character of a player who signed in from Nanoterra (README, "Sign in from Nanoterra"): the base, the face, the hair, the clothes, the
-- sizes and the colours as two whole numbers on closed lists (`@nano133/nanoterra/character/record`), kept next to the five colours that stay in `look`.
-- NULL for a player whose last sign-in came from before Nanoterra sent it: the game then plays them in the five colours.
ALTER TABLE nanoterra_players ADD COLUMN record TEXT; -- JSON: [a, b], the two numbers of packRecord; or NULL
