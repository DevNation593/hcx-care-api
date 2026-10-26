import { Prisma } from '@prisma/client';
import { zonedDateString } from '../common/utils/timezone';

/** Today's calendar date (YYYY-MM-DD) in the clinic time zone. */
export async function clinicToday(
  db: Pick<Prisma.TransactionClient, 'tenantSettings'>,
  tenantId: string,
): Promise<string> {
  const settings = await db.tenantSettings.findUnique({
    where: { tenantId },
    select: { timezone: true },
  });
  return zonedDateString(new Date(), settings?.timezone);
}
