-- Remove duplicate memberships before enforcing uniqueness.
-- Keep one row per (organizationId, userId): an org:admin row if there is one,
-- then the earliest createdAt, then the lowest id. Rows with a NULL userId are
-- left untouched because NULLs are distinct in the unique index below.
DELETE FROM "public"."members"
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        PARTITION BY "organizationId", "userId"
        ORDER BY ("role" = 'org:admin') DESC, "createdAt" ASC, "id" ASC
      ) AS rn
    FROM "public"."members"
    WHERE "userId" IS NOT NULL
  ) ranked
  WHERE ranked.rn > 1
);

-- CreateIndex
CREATE UNIQUE INDEX "members_organizationId_userId_key" ON "public"."members"("organizationId", "userId");
