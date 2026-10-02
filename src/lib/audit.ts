import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

export const audit = (actorId: string | null, action: string, ip?: string, meta?: Prisma.InputJsonValue) =>
  prisma.auditLog.create({ data: { actorId, action, ip, meta } }).catch(() => {});