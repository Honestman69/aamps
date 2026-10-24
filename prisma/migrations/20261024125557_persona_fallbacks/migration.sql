-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Persona" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatar" TEXT,
    "tagline" TEXT,
    "identityJson" TEXT NOT NULL DEFAULT '{}',
    "promptBlocksJson" TEXT NOT NULL DEFAULT '[]',
    "examplesJson" TEXT NOT NULL DEFAULT '[]',
    "openingJson" TEXT NOT NULL DEFAULT '{}',
    "boundariesJson" TEXT NOT NULL DEFAULT '[]',
    "variablesJson" TEXT NOT NULL DEFAULT '{}',
    "behaviorJson" TEXT NOT NULL DEFAULT '{}',
    "fallbacksJson" TEXT NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publishedSnapshot" TEXT,
    "publishedAt" DATETIME,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Persona_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "BotInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Persona" ("archivedAt", "avatar", "behaviorJson", "boundariesJson", "createdAt", "examplesJson", "id", "identityJson", "instanceId", "name", "openingJson", "promptBlocksJson", "publishedAt", "publishedSnapshot", "status", "tagline", "updatedAt", "variablesJson", "version") SELECT "archivedAt", "avatar", "behaviorJson", "boundariesJson", "createdAt", "examplesJson", "id", "identityJson", "instanceId", "name", "openingJson", "promptBlocksJson", "publishedAt", "publishedSnapshot", "status", "tagline", "updatedAt", "variablesJson", "version" FROM "Persona";
DROP TABLE "Persona";
ALTER TABLE "new_Persona" RENAME TO "Persona";
CREATE INDEX "Persona_instanceId_status_idx" ON "Persona"("instanceId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
