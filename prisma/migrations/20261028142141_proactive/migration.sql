-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BotInstance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
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
    "dailyBudgetCents" INTEGER NOT NULL DEFAULT 0,
    "monthlyBudgetCents" INTEGER NOT NULL DEFAULT 0,
    "budgetPolicy" TEXT NOT NULL DEFAULT 'downgrade',
    "credentialId" TEXT,
    "modelMain" TEXT DEFAULT 'deepseek-chat',
    "modelCheap" TEXT DEFAULT 'deepseek-chat',
    "modelFallback" TEXT,
    "modelTemperature" REAL NOT NULL DEFAULT 0.85,
    "modelVision" TEXT,
    "ttsCredentialId" TEXT,
    "ttsModel" TEXT,
    "ttsVoice" TEXT NOT NULL DEFAULT 'alloy',
    "imageHosts" TEXT NOT NULL DEFAULT '',
    "proactiveEnabled" BOOLEAN NOT NULL DEFAULT false,
    "activePersonaId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BotInstance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BotInstance_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BotInstance_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BotInstance_ttsCredentialId_fkey" FOREIGN KEY ("ttsCredentialId") REFERENCES "Credential" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BotInstance_activePersonaId_fkey" FOREIGN KEY ("activePersonaId") REFERENCES "Persona" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_BotInstance" ("accessTokenDigest", "accessTokenEnc", "accountId", "activePersonaId", "adapterMode", "adapterType", "appId", "appSecretEnc", "budgetPolicy", "createdAt", "credentialId", "dailyBudgetCents", "dailyMsgCap", "enabled", "endpoint", "healthScore", "id", "imageHosts", "modelCheap", "modelFallback", "modelMain", "modelTemperature", "modelVision", "monthlyBudgetCents", "name", "nightQuiet", "ownerUserId", "platform", "rateLimitPerMin", "silentUntil", "status", "tenantId", "ttsCredentialId", "ttsModel", "ttsVoice", "updatedAt") SELECT "accessTokenDigest", "accessTokenEnc", "accountId", "activePersonaId", "adapterMode", "adapterType", "appId", "appSecretEnc", "budgetPolicy", "createdAt", "credentialId", "dailyBudgetCents", "dailyMsgCap", "enabled", "endpoint", "healthScore", "id", "imageHosts", "modelCheap", "modelFallback", "modelMain", "modelTemperature", "modelVision", "monthlyBudgetCents", "name", "nightQuiet", "ownerUserId", "platform", "rateLimitPerMin", "silentUntil", "status", "tenantId", "ttsCredentialId", "ttsModel", "ttsVoice", "updatedAt" FROM "BotInstance";
DROP TABLE "BotInstance";
ALTER TABLE "new_BotInstance" RENAME TO "BotInstance";
CREATE UNIQUE INDEX "BotInstance_activePersonaId_key" ON "BotInstance"("activePersonaId");
CREATE INDEX "BotInstance_ownerUserId_idx" ON "BotInstance"("ownerUserId");
CREATE UNIQUE INDEX "BotInstance_platform_accountId_key" ON "BotInstance"("platform", "accountId");
CREATE TABLE "new_Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "senderId" TEXT,
    "senderName" TEXT,
    "content" TEXT NOT NULL,
    "segmentsJson" TEXT NOT NULL DEFAULT '[]',
    "thinkJson" TEXT,
    "tokenIn" INTEGER NOT NULL DEFAULT 0,
    "tokenOut" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "blockReason" TEXT,
    "proactive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Message" ("blockReason", "blocked", "content", "createdAt", "id", "latencyMs", "model", "role", "segmentsJson", "senderId", "senderName", "sessionId", "thinkJson", "tokenIn", "tokenOut") SELECT "blockReason", "blocked", "content", "createdAt", "id", "latencyMs", "model", "role", "segmentsJson", "senderId", "senderName", "sessionId", "thinkJson", "tokenIn", "tokenOut" FROM "Message";
DROP TABLE "Message";
ALTER TABLE "new_Message" RENAME TO "Message";
CREATE INDEX "Message_sessionId_createdAt_idx" ON "Message"("sessionId", "createdAt");
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");
CREATE INDEX "Message_proactive_createdAt_idx" ON "Message"("proactive", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
