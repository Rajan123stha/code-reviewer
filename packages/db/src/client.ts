import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export type Db = PrismaClient;

export function createDb(connectionString: string, options: { maxConnections?: number } = {}): Db {
  const adapter = new PrismaPg({ connectionString, max: options.maxConnections ?? 10 });
  return new PrismaClient({ adapter });
}
