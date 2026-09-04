import { prisma } from '../src/config/db.js';

async function main() {
  const cold = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  console.log(`cold (handshake included): ${Date.now() - cold}ms`);

  const times = [];
  for (let i = 0; i < 10; i++) {
    const t = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    times.push(Date.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log(`warm round trips: ${times.join(', ')}ms`);
  console.log(`median: ${times[5]}ms`);

  await prisma.$disconnect();
}

main();