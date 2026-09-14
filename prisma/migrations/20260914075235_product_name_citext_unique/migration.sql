/*
  Warnings:

  - A unique constraint covering the columns `[name]` on the table `Product` will be added. If there are existing duplicate values, this will fail.

*/
-- Prisma does not emit this: @db.Citext names the type but nothing installs it.
-- Without this line the ALTER below fails with `type "citext" does not exist`.
CREATE EXTENSION IF NOT EXISTS citext;

-- AlterTable
ALTER TABLE "Product" ALTER COLUMN "name" SET DATA TYPE CITEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Product_name_key" ON "Product"("name");
