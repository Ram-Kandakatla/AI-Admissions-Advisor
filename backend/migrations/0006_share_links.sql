-- Read-only share links for a parent or counselor (Phase 6.7).
--
-- THE URL IS THE CREDENTIAL. There is no password on the other end of this and
-- no account for the person opening it — that is the point, since a counselor
-- with sixty students will not make an account for each one, and a parent
-- should not have to. Everything below follows from that one fact.
--
-- `token` is a v4 UUID from crypto.randomUUID(): 122 bits of entropy from the
-- platform CSPRNG, the same source session ids come from. Guessing one is not
-- a threat model. Being *forwarded* one is, which is why the whole design
-- rests on revocation rather than on secrecy holding forever.
--
-- WHY REVOKING IS A DELETE
--
-- A `revoked_at` column would let the server distinguish "revoked" from "never
-- existed" — and it must never act on that distinction, because telling a
-- visitor which of the two they hit says whether a link was ever real. Two
-- states the code is forbidden to tell apart are better as one state. So
-- revoke deletes the row, and both cases answer an identical 404.
--
-- UNIQUE on student_id is what makes "your share link" a well-defined thing to
-- put on a page and a single thing to revoke. Rotating is a delete and an
-- insert, which is also what makes revocation meaningful: the old URL stops
-- working the instant a new one is minted, rather than accumulating a fleet of
-- live links the student has lost track of.
--
-- No expiry, deliberately. An expiry a student sets in September and forgets
-- is a dead link to their counselor in December, precisely when decisions land
-- and someone is trying to help. Revocation is the control that stays true.
--
-- ON DELETE CASCADE so deleting a profile takes its share link with it. A
-- token that outlived the data it pointed at would be a 500 waiting to happen
-- rather than a leak, but it should not exist either way.

CREATE TABLE IF NOT EXISTS share_links (
  token      TEXT PRIMARY KEY,
  student_id TEXT NOT NULL UNIQUE REFERENCES students(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
