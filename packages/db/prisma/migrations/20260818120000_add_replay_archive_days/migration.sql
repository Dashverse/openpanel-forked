-- CreateTable
CREATE TABLE "replay_archive_days" (
    "day" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "chChunks" BIGINT,
    "blobChunks" BIGINT,
    "driftChunks" INTEGER,
    "sessions" INTEGER,
    "archivedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "verifyError" TEXT,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "replay_archive_days_pkey" PRIMARY KEY ("day")
);
