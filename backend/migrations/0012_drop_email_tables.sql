-- Drop the tables the emailed signup-confirmation and password-reset flows
-- used. Signup is synchronous now (see routes/auth.ts) and self-service
-- password reset was removed outright, so nothing reads or writes either
-- table any more.

DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS pending_signups;
