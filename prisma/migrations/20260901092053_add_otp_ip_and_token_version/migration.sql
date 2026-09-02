-- DropIndex
DROP INDEX "OtpRequest_phone_idx";

-- AlterTable
ALTER TABLE "OtpRequest" ADD COLUMN     "ip" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "OtpRequest_phone_createdAt_idx" ON "OtpRequest"("phone", "createdAt");

-- CreateIndex
CREATE INDEX "OtpRequest_phone_verified_expiresAt_idx" ON "OtpRequest"("phone", "verified", "expiresAt");

-- CreateIndex
CREATE INDEX "OtpRequest_ip_createdAt_idx" ON "OtpRequest"("ip", "createdAt");
