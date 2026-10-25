-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'image',
    "sha256" TEXT NOT NULL,
    "ext" TEXT NOT NULL DEFAULT 'jpg',
    "mime" TEXT NOT NULL DEFAULT 'image/jpeg',
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'inbound',
    "tags" TEXT NOT NULL DEFAULT '',
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MediaAsset_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "BotInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "MediaAsset_instanceId_deletedAt_lastUsedAt_idx" ON "MediaAsset"("instanceId", "deletedAt", "lastUsedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_instanceId_alias_key" ON "MediaAsset"("instanceId", "alias");
