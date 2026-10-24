-- AlterTable
ALTER TABLE "Credential" ADD COLUMN "balanceCents" INTEGER;
ALTER TABLE "Credential" ADD COLUMN "balanceCheckedAt" DATETIME;
ALTER TABLE "Credential" ADD COLUMN "balanceCurrency" TEXT;
ALTER TABLE "Credential" ADD COLUMN "balanceSource" TEXT;
ALTER TABLE "Credential" ADD COLUMN "cooldownUntil" DATETIME;
ALTER TABLE "Credential" ADD COLUMN "unavailableReason" TEXT;
