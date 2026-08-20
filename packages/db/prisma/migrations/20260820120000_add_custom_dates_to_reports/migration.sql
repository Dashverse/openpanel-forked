-- Persist custom date ranges on saved reports (range='custom') so they survive
-- reopen instead of falling back to a preset.
ALTER TABLE "reports" ADD COLUMN "startDate" TEXT;
ALTER TABLE "reports" ADD COLUMN "endDate" TEXT;
