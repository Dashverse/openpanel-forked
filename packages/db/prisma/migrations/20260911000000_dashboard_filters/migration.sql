-- Saved dashboard-level filters applied to every report on a dashboard.
ALTER TABLE "dashboards" ADD COLUMN "filters" JSONB NOT NULL DEFAULT '[]';
