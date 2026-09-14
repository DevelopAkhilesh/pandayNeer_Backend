-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "depositProductId" TEXT,
ADD COLUMN     "imageUrl" TEXT;

-- CreateIndex
CREATE INDEX "Product_depositProductId_idx" ON "Product"("depositProductId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_depositProductId_fkey" FOREIGN KEY ("depositProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
