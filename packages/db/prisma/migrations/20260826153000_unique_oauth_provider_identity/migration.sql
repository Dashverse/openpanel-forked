-- Cross-user duplicates require an explicit data-ownership decision. Stop with
-- a diagnostic instead of silently attaching an identity to the wrong user.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "accounts"
    WHERE "providerId" IS NOT NULL
    GROUP BY "provider", "providerId"
    HAVING COUNT(DISTINCT "userId") > 1
  ) THEN
    RAISE EXCEPTION
      'Duplicate OAuth provider identities belong to different users; resolve them before applying this migration';
  END IF;
END $$;

-- Safely collapse duplicates created by concurrent callbacks for the same user,
-- retaining the oldest account record.
DELETE FROM "accounts" AS duplicate
USING "accounts" AS keeper
WHERE duplicate."provider" = keeper."provider"
  AND duplicate."providerId" = keeper."providerId"
  AND duplicate."providerId" IS NOT NULL
  AND duplicate."userId" = keeper."userId"
  AND (
    duplicate."createdAt" > keeper."createdAt"
    OR (
      duplicate."createdAt" = keeper."createdAt"
      AND duplicate."id" > keeper."id"
    )
  );

-- PostgreSQL permits multiple NULL provider IDs, so legacy email/password
-- accounts remain unaffected.
CREATE UNIQUE INDEX "accounts_provider_providerId_key"
ON "accounts"("provider", "providerId");
