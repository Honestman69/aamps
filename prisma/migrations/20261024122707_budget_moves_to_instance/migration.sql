/*
  Warnings:

  - You are about to drop the column `dailyBudgetCents` on the `Credential` table. All the data in the column will be lost.
  - You are about to drop the column `monthlyBudgetCents` on the `Credential` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Credential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ownerLabel" TEXT,
    "baseUrl" TEXT,
    "authStyle" TEXT NOT NULL DEFAULT 'bearer',
    "apiVersion" TEXT,
    "apiKeyEnc" TEXT NOT NULL,
    "keyMasked" TEXT NOT NULL DEFAULT '',
    "defaultModel" TEXT,
    "catalogJson" TEXT NOT NULL DEFAULT '[]',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabledBy" TEXT,
    "lastCheckedAt" DATETIME,
    "lastCheckOk" BOOLEAN,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Credential_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Credential_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Credential" ("apiKeyEnc", "apiVersion", "authStyle", "baseUrl", "catalogJson", "createdAt", "defaultModel", "disabledBy", "enabled", "id", "keyMasked", "label", "lastCheckOk", "lastCheckedAt", "lastError", "ownerLabel", "ownerUserId", "priority", "provider", "tenantId", "updatedAt") SELECT "apiKeyEnc", "apiVersion", "authStyle", "baseUrl", "catalogJson", "createdAt", "defaultModel", "disabledBy", "enabled", "id", "keyMasked", "label", "lastCheckOk", "lastCheckedAt", "lastError", "ownerLabel", "ownerUserId", "priority", "provider", "tenantId", "updatedAt" FROM "Credential";
DROP TABLE "Credential";
ALTER TABLE "new_Credential" RENAME TO "Credential";
CREATE INDEX "Credential_ownerUserId_provider_enabled_idx" ON "Credential"("ownerUserId", "provider", "enabled");
CREATE INDEX "Credential_tenantId_idx" ON "Credential"("tenantId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
