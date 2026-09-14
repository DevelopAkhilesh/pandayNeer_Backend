-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "publishedAt" TIMESTAMP(3),
ALTER COLUMN "isActive" SET DEFAULT false;
