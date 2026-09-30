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
  /**
   * Every User who has recorded a DeliveryTime. This is the daily job's whole
   * population: a User with no row has no DeliveryTime, so there is no instant
   * to decide whether they are due.
   */
  list(): Promise<readonly DeliverySettings[]>;
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

  async list(): Promise<readonly DeliverySettings[]> {
    const rows = (await this.db
      .select()
      .from(deliverySettings)) as readonly DeliverySettingsRow[];
    return rows.map(rowToSettings);
  }

  async upsert(settings: DeliverySettings): Promise<void> {
    const existing = await this.getByUserId(settings.userId);
    if (existing) {
      // `updatedAt` is when this reading was recorded, and only a different reading
      // records a new one. Moving it on a save that changes nothing would drop every
      // DeliverySlot between the two saves, so a User who opened the delivery-time
      // screen and saved the same time would silently lose the periods the job had
      // not yet got to.
      const sameReading =
        existing.hour === settings.hour &&
        existing.minute === settings.minute &&
        existing.timezone === settings.timezone;
      await this.db
        .update(deliverySettings)
        .set({
          hour: settings.hour,
          minute: settings.minute,
          timezone: settings.timezone,
          welcomeSentAt: settings.welcomeSentAt,
          updatedAt: sameReading ? existing.updatedAt : settings.updatedAt,
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
