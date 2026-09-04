import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',

  migrations: {
    path: 'prisma/migrations',
    // Prisma 7 reads the seed command from here. The `prisma.seed` key in
    // package.json is the Prisma 6 form and is ignored.
    seed: 'node prisma/seed.js',
  },

  datasource: {
    url: env('DATABASE_URL'),
  },
});
