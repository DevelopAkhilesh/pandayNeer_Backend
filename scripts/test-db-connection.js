import { prisma } from '../src/config/db.js';

async function main() {
  try {
    await prisma.$connect();
    console.log('✅ Database connected successfully');

    const result = await prisma.$queryRaw`SELECT NOW()`;
    console.log('✅ Query test passed. Server time:', result[0].now);
  } catch (err) {
    console.error('❌ Database connection failed:');
    console.error(err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
