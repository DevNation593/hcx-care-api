-- Refresh tokens are stored as the SHA-256 (hex) of the JWT instead of the JWT itself, so a leak
-- of this table does not reveal tokens that can be presented to POST /auth/refresh. The API looks
-- them up by that hash (src/auth/refresh-token.ts).
--
-- Rows that still hold a JWT are rewritten in place, so the sessions already open keep working:
-- the client sends the same JWT and the API now hashes it before the lookup. A JWT always
-- contains dots, so a value of exactly 64 lowercase hex characters is already a hash and is left
-- alone: running this again changes nothing.
UPDATE "RefreshToken"
SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex')
WHERE "token" !~ '^[0-9a-f]{64}$';
