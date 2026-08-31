export type OnboardingState =
  | 'not_started'
  | 'topics_picked'
  | 'delivery_set'
  | 'completed';

export type UserId = string;
export type AccountId = string;
export type SessionId = string;
export type MagicLinkId = string;

export interface User {
  readonly id: UserId;
  readonly createdAt: Date;
  readonly onboardingState: OnboardingState;
}

export interface Account {
  readonly id: AccountId;
  readonly userId: UserId;
  readonly email: string;
  readonly emailVerifiedAt: Date | null;
  readonly createdAt: Date;
}

export interface Session {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface MagicLink {
  readonly id: MagicLinkId;
  readonly accountId: AccountId;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}