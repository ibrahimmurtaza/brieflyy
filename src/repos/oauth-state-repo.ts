import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { oauthStates, type OAuthStateRow } from '../db/schema.js';
import type { OAuthState } from '../domain/types.js';

function rowToOAuthState(row: OAuthStateRow): OAuthState {
  return {
    id: row.id,
    stateHash: row.stateHash,
    codeVerifierHash: row.codeVerifierHash,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
}

export interface OAuthStateRepo {
  insert(state: OAuthState): Promise<void>;
  getByStateHash(stateHash: string): Promise<OAuthState | null>;
  markConsumed(id: string, at: Date): Promise<void>;
}

export class DrizzleOAuthStateRepo implements OAuthStateRepo {
  constructor(private readonly db: Db) {}

  async insert(state: OAuthState): Promise<void> {
    await this.db.insert(oauthStates).values({
      id: state.id,
      stateHash: state.stateHash,
      codeVerifierHash: state.codeVerifierHash,
      createdAt: state.createdAt,
      expiresAt: state.expiresAt,
      consumedAt: state.consumedAt,
    });
  }

  async getByStateHash(stateHash: string): Promise<OAuthState | null> {
    const rows = await this.db
      .select()
      .from(oauthStates)
      .where(eq(oauthStates.stateHash, stateHash));
    const row = rows[0];
    return row ? rowToOAuthState(row) : null;
  }

  async markConsumed(id: string, at: Date): Promise<void> {
    await this.db
      .update(oauthStates)
      .set({ consumedAt: at })
      .where(eq(oauthStates.id, id));
  }
}