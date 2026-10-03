import { defineConfig } from 'prisma/config';

// Prisma 7 does not read .env itself. Use the repo-root .env when present; real
// environment variables still take precedence.
for (const path of ['../../.env', '.env']) {
  try {
    process.loadEnvFile(path);
    break;
  } catch {
    // Not found; try the next location.
  }
}

// Only migrate/introspect commands need a database; `prisma generate` works without one.
const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(url ? { datasource: { url } } : {}),
});
