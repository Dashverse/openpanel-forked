ALTER TABLE "report_layouts" ADD COLUMN "fineLayout" JSONB;

CREATE TABLE "dashboard_blocks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dashboardId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "heading" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL DEFAULT '',
    "x" INTEGER NOT NULL DEFAULT 0,
    "y" INTEGER NOT NULL DEFAULT 0,
    "w" INTEGER NOT NULL DEFAULT 12,
    "h" INTEGER NOT NULL DEFAULT 2,
    "minW" INTEGER NOT NULL DEFAULT 2,
    "minH" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dashboard_blocks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dashboard_blocks_kind_check" CHECK ("kind" IN ('text', 'divider'))
);

CREATE INDEX "dashboard_blocks_dashboardId_idx" ON "dashboard_blocks"("dashboardId");
ALTER TABLE "dashboard_blocks" ADD CONSTRAINT "dashboard_blocks_dashboardId_fkey"
    FOREIGN KEY ("dashboardId") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
