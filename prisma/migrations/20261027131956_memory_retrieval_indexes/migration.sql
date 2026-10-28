-- CreateIndex
CREATE INDEX "MemoryItem_instanceId_subjectId_scope_idx" ON "MemoryItem"("instanceId", "subjectId", "scope");

-- CreateIndex
CREATE INDEX "MemoryItem_sessionId_scope_createdAt_idx" ON "MemoryItem"("sessionId", "scope", "createdAt");
