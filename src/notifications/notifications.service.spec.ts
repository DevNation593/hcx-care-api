import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationPreferencesService,
} from './notification-preferences.service';
import { NotificationsService, NotifyInput } from './notifications.service';
import { WebPushService } from './web-push/web-push.service';

describe('NotificationsService', () => {
  let rows: Record<string, any>[];
  let stored: Record<string, any> | null;
  const prisma = {
    notificationLog: {
      create: jest.fn(async ({ data }) => {
        if (data.dedupeKey && rows.some((row) => row.dedupeKey === data.dedupeKey)) {
          throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        }
        const row = { id: `n-${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) =>
        Object.assign(
          rows.find((row) => row.id === where.id)!,
          data,
        ),
      ),
    },
    user: { findFirst: jest.fn(async () => ({ fcmToken: null })) },
    notificationPreference: {
      findUnique: jest.fn(async () => stored),
      findMany: jest.fn(async () => (stored ? [stored] : [])),
      upsert: jest.fn(
        async ({ create, update }) => (stored = { ...(stored ?? create), ...update }),
      ),
    },
  };
  const webPush = { sendToUser: jest.fn().mockResolvedValue({ attempted: 1, delivered: 1 }) };
  const preferences = new NotificationPreferencesService(prisma as unknown as PrismaService);
  // No Firebase credentials: the mobile channel stays off, as in a default install.
  const service = new NotificationsService(
    { get: () => undefined } as unknown as ConfigService,
    prisma as unknown as PrismaService,
    preferences,
    webPush as unknown as WebPushService,
  );
  const input: NotifyInput = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    type: 'TASK_DUE_SOON',
    title: 'Actividad próxima a vencer',
    body: 'Registro de pensamientos',
    data: { taskId: 'task-1', url: '/patients/p1' },
    relatedEntityType: 'task',
    relatedEntityId: 'task-1',
    dedupeKey: 'task-due:task-1:user-1:2026-10-17T15:00:00.000Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    rows = [];
    stored = null;
  });

  describe('notify', () => {
    it('creates one in-app notification and pushes it to the browsers', async () => {
      const created = await service.notify(input);

      expect(rows).toHaveLength(1);
      expect(created).toMatchObject({
        type: 'TASK_DUE_SOON',
        status: 'SENT',
        relatedEntityId: 'task-1',
        dedupeKey: input.dedupeKey,
      });
      expect(webPush.sendToUser).toHaveBeenCalledWith('tenant-1', 'user-1', {
        title: input.title,
        body: input.body,
        data: input.data,
      });
    });

    it('does nothing the second time for the same dedupe key', async () => {
      await service.notify(input);

      await expect(service.notify(input)).resolves.toBeNull();
      expect(rows).toHaveLength(1);
      expect(webPush.sendToUser).toHaveBeenCalledTimes(1);
    });

    it('notifies again when the key changes, as when a task is rescheduled', async () => {
      await service.notify(input);
      await service.notify({ ...input, dedupeKey: `${input.dedupeKey}-moved` });

      expect(rows).toHaveLength(2);
    });

    it('keeps the notification in the app only when the user turned push off', async () => {
      stored = { userId: 'user-1', ...DEFAULT_NOTIFICATION_PREFERENCES, pushEnabled: false };

      const created = await service.notify(input);

      expect(created).not.toBeNull();
      expect(rows).toHaveLength(1);
      expect(webPush.sendToUser).not.toHaveBeenCalled();
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('still creates the notification when the push channel fails', async () => {
      webPush.sendToUser.mockRejectedValueOnce(new Error('push service down'));

      await expect(service.notify(input)).resolves.toMatchObject({ id: 'n-1' });
    });

    it('rethrows a database error that is not a duplicate', async () => {
      prisma.notificationLog.create.mockRejectedValueOnce(new Error('connection lost'));

      await expect(service.notify(input)).rejects.toThrow('connection lost');
    });
  });

  describe('appointment reminders', () => {
    const appointment = {
      id: 'a-1',
      patientId: 'p-1',
      startTime: new Date('2026-10-17T15:00:00Z'),
      patient: { firstName: 'Ana', lastName: 'Paz' },
    };

    it('creates a single notification per reminder', async () => {
      await service.sendAppointmentReminder('tenant-1', 'user-1', appointment, 0.5, '30m');

      expect(rows).toEqual([
        expect.objectContaining({
          type: 'APPOINTMENT_REMINDER',
          body: 'Cita con Ana Paz en 30 minutos',
          relatedEntityType: 'appointment',
          relatedEntityId: 'a-1',
          data: expect.objectContaining({ reminderRule: '30m', appointmentId: 'a-1' }),
        }),
      ]);
    });

    it('creates nothing for a user who turned appointment reminders off', async () => {
      stored = {
        userId: 'user-1',
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        appointmentReminders: false,
      };

      await service.sendAppointmentReminder('tenant-1', 'user-1', appointment, 24);

      expect(rows).toEqual([]);
      expect(webPush.sendToUser).not.toHaveBeenCalled();
    });
  });

  describe('preferences', () => {
    it('returns the defaults until the user saves something', async () => {
      await expect(preferences.get('user-1')).resolves.toEqual({
        pushEnabled: true,
        appointmentReminders: true,
        taskDueReminders: true,
        morningDigest: false,
      });
    });

    it('stores only what changed and keeps the rest', async () => {
      await preferences.update('user-1', { taskDueReminders: false });
      const updated = await preferences.update('user-1', { morningDigest: true });

      expect(updated).toEqual({
        pushEnabled: true,
        appointmentReminders: true,
        taskDueReminders: false,
        morningDigest: true,
      });
    });

    it('gives the defaults to users without a stored row when reading many', async () => {
      stored = { userId: 'user-1', ...DEFAULT_NOTIFICATION_PREFERENCES, taskDueReminders: false };

      const many = await preferences.getMany(['user-1', 'user-2']);

      expect(many.get('user-1')?.taskDueReminders).toBe(false);
      expect(many.get('user-2')).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    });
  });
});
