-- Whose sign-in a wallet request is: 'play' (the game's) or 'admin' (/admin's). It is written when the request starts and read when the browser's check delivers it, so a
-- request started for one scope can never make a login in the other, whatever the browser presents. A request with no scope (made before this column) is 'play': it can only
-- make a player's login, never an admin one.
ALTER TABLE signin_requests ADD COLUMN scope TEXT NOT NULL DEFAULT 'play';
