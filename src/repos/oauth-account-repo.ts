import { and, eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { oauthAccounts, type OAuthAccountRow } from '../db/schema.js';
import type { OAuthAccount, OAuthProvider } from '../domain/types.js';

function rowToOAuthAccount(row: OAuthAccountRow): OAuthAccount {
  return {
    id: row.id,
    accountId: row.accountId,
    provider: row.provider as OAuthProvider,
    providerSubject: row.providerSubject,
    createdAt: row.createdAt,
  };
}

export interface OAuthAccountRepo {
  insert(link: OAuthAccount): Promise<void>;
  getByProviderSubject(
    provider: OAuthProvider,
    subject: string,
  ): Promise<OAuthAccount | null>;
}

export class DrizzleOAuthAccountRepo implements OAuthAccountRepo {
  constructor(private readonly db: Db) {}

  async insert(link: OAuthAccount): Promise<void> {
    await this.db.insert(oauthAccounts).values({
      id: link.id,
      accountId: link.accountId,
      provider: link.provider,
      providerSubject: link.providerSubject,
      createdAt: link.createdAt,
    });
  }

  async getByProviderSubject(
    provider: OAuthProvider,
    subject: string,
  ): Promise<OAuthAccount | null> {
    const rows = await this.db
      .select()
      .from(oauthAccounts)
      .where(
        and(
          eq(oauthAccounts.provider, provider),
          eq(oauthAccounts.providerSubject, subject),
        ),
      );
    const row = rows[0];
    return row ? rowToOAuthAccount(row) : null;
  }
}