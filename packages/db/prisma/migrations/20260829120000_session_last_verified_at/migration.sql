-- Tracks when Google last confirmed the session's account is active.
-- Nullable, so existing sessions are simply treated as never verified.
ALTER TABLE "sessions" ADD COLUMN "lastVerifiedAt" TIMESTAMP(3);
