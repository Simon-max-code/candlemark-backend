import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
	transactionOptions: { maxWait: 20_000, timeout: 30_000 },
});