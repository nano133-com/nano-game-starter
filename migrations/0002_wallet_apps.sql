-- Sign in with Nautilus and NanChat, beside Berry Wallet. The three share the sign-in requests table.
-- `id` stays the row's key. For Berry Wallet and Nautilus it is the browser's id too; NanChat's row is
-- keyed on the SHA-256 of its nonce (its answer names only the nonce), so the browser's id is in `rid`.

ALTER TABLE signin_requests ADD COLUMN way TEXT NOT NULL DEFAULT 'berry'; -- berry | nautilus | nanchat
ALTER TABLE signin_requests ADD COLUMN rid TEXT;                           -- the browser's id for its checks
ALTER TABLE signin_requests ADD COLUMN label TEXT;                         -- Nautilus: the label it shows and signs
UPDATE signin_requests SET rid = id WHERE rid IS NULL;
CREATE INDEX signin_requests_by_rid ON signin_requests (rid);
