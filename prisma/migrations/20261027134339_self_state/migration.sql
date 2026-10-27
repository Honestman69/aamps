-- CreateTable
CREATE TABLE "SelfState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "traitsJson" TEXT NOT NULL DEFAULT '{}',
    "narrative" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SelfState_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "BotInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SelfStateVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "traitsJson" TEXT NOT NULL,
    "narrative" TEXT NOT NULL,
    "deltasJson" TEXT NOT NULL DEFAULT '{}',
    "reason" TEXT NOT NULL,
    "sourceMemoryIds" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SelfStateVersion_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "BotInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SelfState_instanceId_key" ON "SelfState"("instanceId");

-- CreateIndex
CREATE INDEX "SelfStateVersion_instanceId_createdAt_idx" ON "SelfStateVersion"("instanceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SelfStateVersion_instanceId_version_key" ON "SelfStateVersion"("instanceId", "version");
