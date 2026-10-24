/*
  Warnings:

  - You are about to drop the column `instanceId` on the `AgentState` table. All the data in the column will be lost.
  - You are about to drop the column `activePersonaId` on the `BotInstance` table. All the data in the column will be lost.
  - You are about to drop the column `instanceId` on the `Persona` table. All the data in the column will be lost.
  - You are about to drop the column `instanceId` on the `Relationship` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `Relationship` table. All the data in the column will be lost.
  - Added the required column `agentId` to the `AgentState` table without a default value. This is not possible if the table is not empty.
  - Added the required column `agentId` to the `BotInstance` table without a default value. This is not possible if the table is not empty.
  - Added the required column `agentId` to the `MemoryItem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `agentId` to the `Persona` table without a default value. This is not possible if the table is not empty.
  - Added the required column `agentId` to the `Relationship` table without a default value. This is not possible if the table is not empty.
  - Added the required column `peerId` to the `Relationship` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "credentialId" TEXT,
    "modelMain" TEXT DEFAULT 'deepseek-chat',
    "modelCheap" TEXT DEFAULT 'deepseek-chat',
    "modelFallback" TEXT,
    "activePersonaId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Agent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Agent_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Agent_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Agent_activePersonaId_fkey" FOREIGN KEY ("activePersonaId") REFERENCES "Persona" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "mood" REAL NOT NULL DEFAULT 0,
    "energy" REAL NOT NULL DEFAULT 0.8,
    "busyUntil" DATETIME,
    "lastDecayAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentState_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AgentState" ("busyUntil", "energy", "id", "lastDecayAt", "mood", "updatedAt") SELECT "busyUntil", "energy", "id", "lastDecayAt", "mood", "updatedAt" FROM "AgentState";
DROP TABLE "AgentState";
ALTER TABLE "new_AgentState" RENAME TO "AgentState";
CREATE UNIQUE INDEX "AgentState_agentId_key" ON "AgentState"("agentId");
CREATE TABLE "new_BotInstance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'qq',
    "accountId" TEXT NOT NULL,
    "adapterType" TEXT NOT NULL DEFAULT 'onebot',
    "adapterMode" TEXT NOT NULL DEFAULT 'client',
    "endpoint" TEXT,
    "accessTokenEnc" TEXT,
    "accessTokenDigest" TEXT,
    "appId" TEXT,
    "appSecretEnc" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "healthScore" INTEGER NOT NULL DEFAULT 100,
    "silentUntil" DATETIME,
    "dailyMsgCap" INTEGER NOT NULL DEFAULT 800,
    "rateLimitPerMin" INTEGER NOT NULL DEFAULT 20,
    "nightQuiet" TEXT NOT NULL DEFAULT '00:30-07:30',
    "credentialId" TEXT,
    "modelMain" TEXT,
    "modelCheap" TEXT,
    "modelFallback" TEXT,
    "modelTemperature" REAL NOT NULL DEFAULT 0.85,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BotInstance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BotInstance_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BotInstance_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BotInstance_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_BotInstance" ("accessTokenDigest", "accessTokenEnc", "accountId", "adapterMode", "adapterType", "appId", "appSecretEnc", "createdAt", "credentialId", "dailyMsgCap", "enabled", "endpoint", "healthScore", "id", "modelCheap", "modelFallback", "modelMain", "modelTemperature", "name", "nightQuiet", "ownerUserId", "platform", "rateLimitPerMin", "silentUntil", "status", "tenantId", "updatedAt") SELECT "accessTokenDigest", "accessTokenEnc", "accountId", "adapterMode", "adapterType", "appId", "appSecretEnc", "createdAt", "credentialId", "dailyMsgCap", "enabled", "endpoint", "healthScore", "id", "modelCheap", "modelFallback", "modelMain", "modelTemperature", "name", "nightQuiet", "ownerUserId", "platform", "rateLimitPerMin", "silentUntil", "status", "tenantId", "updatedAt" FROM "BotInstance";
DROP TABLE "BotInstance";
ALTER TABLE "new_BotInstance" RENAME TO "BotInstance";
CREATE INDEX "BotInstance_ownerUserId_idx" ON "BotInstance"("ownerUserId");
CREATE UNIQUE INDEX "BotInstance_platform_accountId_key" ON "BotInstance"("platform", "accountId");
CREATE TABLE "new_MemoryItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "instanceId" TEXT,
    "sessionId" TEXT,
    "scope" TEXT NOT NULL,
    "subjectId" TEXT,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "keywords" TEXT NOT NULL DEFAULT '',
    "importance" INTEGER NOT NULL DEFAULT 3,
    "sourceMsgIds" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemoryItem_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MemoryItem_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "BotInstance" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MemoryItem_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_MemoryItem" ("content", "createdAt", "expiresAt", "id", "importance", "instanceId", "keywords", "kind", "scope", "sessionId", "sourceMsgIds", "subjectId") SELECT "content", "createdAt", "expiresAt", "id", "importance", "instanceId", "keywords", "kind", "scope", "sessionId", "sourceMsgIds", "subjectId" FROM "MemoryItem";
DROP TABLE "MemoryItem";
ALTER TABLE "new_MemoryItem" RENAME TO "MemoryItem";
CREATE INDEX "MemoryItem_agentId_scope_idx" ON "MemoryItem"("agentId", "scope");
CREATE INDEX "MemoryItem_agentId_subjectId_idx" ON "MemoryItem"("agentId", "subjectId");
CREATE TABLE "new_ModelUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instanceId" TEXT NOT NULL,
    "agentId" TEXT,
    "credentialId" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tokenIn" INTEGER NOT NULL,
    "tokenOut" INTEGER NOT NULL,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "sessionId" TEXT,
    "purpose" TEXT NOT NULL DEFAULT 'chat',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelUsage_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "BotInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ModelUsage_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ModelUsage_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ModelUsage" ("costCents", "createdAt", "credentialId", "id", "instanceId", "model", "ownerUserId", "provider", "purpose", "sessionId", "tokenIn", "tokenOut") SELECT "costCents", "createdAt", "credentialId", "id", "instanceId", "model", "ownerUserId", "provider", "purpose", "sessionId", "tokenIn", "tokenOut" FROM "ModelUsage";
DROP TABLE "ModelUsage";
ALTER TABLE "new_ModelUsage" RENAME TO "ModelUsage";
CREATE INDEX "ModelUsage_instanceId_createdAt_idx" ON "ModelUsage"("instanceId", "createdAt");
CREATE INDEX "ModelUsage_ownerUserId_createdAt_idx" ON "ModelUsage"("ownerUserId", "createdAt");
CREATE TABLE "new_Persona" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
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
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publishedSnapshot" TEXT,
    "publishedAt" DATETIME,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Persona_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Persona" ("avatar", "behaviorJson", "boundariesJson", "createdAt", "examplesJson", "id", "identityJson", "name", "openingJson", "promptBlocksJson", "publishedAt", "publishedSnapshot", "status", "tagline", "updatedAt", "variablesJson", "version") SELECT "avatar", "behaviorJson", "boundariesJson", "createdAt", "examplesJson", "id", "identityJson", "name", "openingJson", "promptBlocksJson", "publishedAt", "publishedSnapshot", "status", "tagline", "updatedAt", "variablesJson", "version" FROM "Persona";
DROP TABLE "Persona";
ALTER TABLE "new_Persona" RENAME TO "Persona";
CREATE INDEX "Persona_agentId_status_idx" ON "Persona"("agentId", "status");
CREATE TABLE "new_Relationship" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'qq',
    "peerId" TEXT NOT NULL,
    "nickname" TEXT,
    "affinity" INTEGER NOT NULL DEFAULT 0,
    "trust" INTEGER NOT NULL DEFAULT 0,
    "isOwner" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "lastInteractionAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Relationship_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Relationship" ("affinity", "createdAt", "id", "isOwner", "lastInteractionAt", "nickname", "notes", "trust", "updatedAt") SELECT "affinity", "createdAt", "id", "isOwner", "lastInteractionAt", "nickname", "notes", "trust", "updatedAt" FROM "Relationship";
DROP TABLE "Relationship";
ALTER TABLE "new_Relationship" RENAME TO "Relationship";
CREATE INDEX "Relationship_agentId_affinity_idx" ON "Relationship"("agentId", "affinity");
CREATE UNIQUE INDEX "Relationship_agentId_platform_peerId_key" ON "Relationship"("agentId", "platform", "peerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Agent_activePersonaId_key" ON "Agent"("activePersonaId");

-- CreateIndex
CREATE INDEX "Agent_tenantId_status_idx" ON "Agent"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Agent_ownerUserId_idx" ON "Agent"("ownerUserId");
