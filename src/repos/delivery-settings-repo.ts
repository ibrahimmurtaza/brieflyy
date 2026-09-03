import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { deliverySettings, type DeliverySettingsRow } from '../db/schema.js';
import type { DeliverySettings, UserId } from '../domain/types.js';

function rowToSettings(row: DeliverySettingsRow): DeliverySettings {
  return {
    userId: row.userId as UserId,
    hour: row.hour,
    minute: row.minute,
    timezone: row.timezone,
    welcomeSentAt: row.welcomeSentAt,
    updatedAt: row.updatedAt,
  };
}

export interface DeliverySettingsRepo {
  getByUserId(userId: UserId): Promise<DeliverySettings | null>;
  upsert(settings: DeliverySettings): Promise<void>;
}

export class DrizzleDeliverySettingsRepo implements DeliverySettingsRepo {
  constructor(private readonly db: Db) {}

  async getByUserId(userId: UserId): Promise<DeliverySettings | null> {
    const rows = await this.db
      .select()
      .from(deliverySettings)
      .where(eq(deliverySettings.userId, userId));
    const row = rows[0];
    return row ? rowToSettings(row) : null;
  }

  async upsert(settings: DeliverySettings): Promise<void> {
    const existing = await this.getByUserId(settings.userId);
    if (existing) {
      await this.db
        .update(deliverySettings)
        .set({
          hour: settings.hour,
          minute: settings.minute,
          timezone: settings.timezone,
          welcomeSentAt: settings.welcomeSentAt,
          updatedAt: settings.updatedAt,
        })
        .where(eq(deliverySettings.userId, settings.userId));
    } else {
      await this.db.insert(deliverySettings).values({
        userId: settings.userId,
        hour: settings.hour,
        minute: settings.minute,
        timezone: settings.timezone,
        welcomeSentAt: settings.welcomeSentAt,
        updatedAt: settings.updatedAt,
      });
    }
  }
}
