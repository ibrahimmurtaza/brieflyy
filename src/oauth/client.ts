export interface GoogleOAuthProfile {
  readonly provider: 'google';
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface ExchangeGoogleCodeInput {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

export type ExchangeGoogleCodeOutcome =
  | { status: 'ok'; profile: GoogleOAuthProfile }
  | { status: 'invalid'; reason: 'exchange_failed' | 'invalid_id_token' };

export interface OAuthClient {
  readonly providerName: 'google';
  buildAuthorizationUrl(input: {
    readonly state: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): string;
  exchangeCode(input: ExchangeGoogleCodeInput): Promise<ExchangeGoogleCodeOutcome>;
}