import { describe, expect, it } from 'vitest';

import {
  loadServerConfig,
  readBool,
  readEnum,
  readInt,
  readNonNegativeInt,
  readString,
} from './env.js';

const MINIMAL: Record<string, string> = {
  DATABASE_URL: 'file:./brieflyy.db',
  APP_BASE_URL: 'http://localhost:3000',
};

describe('env readers', () => {
  it('treats an unset variable and an empty variable the same way', () => {
    expect(readString({}, 'HOST', '0.0.0.0')).toBe('0.0.0.0');
    expect(readString({ HOST: '' }, 'HOST', '0.0.0.0')).toBe('0.0.0.0');
    expect(readString({ HOST: '   ' }, 'HOST', '0.0.0.0')).toBe('0.0.0.0');
  });

  it('trims the value it returns', () => {
    expect(readString({ HOST: '  127.0.0.1  ' }, 'HOST', '0.0.0.0')).toBe('127.0.0.1');
  });

  it('reads a boolean in any casing, and in either spelling', () => {
    for (const raw of ['1', 'true', 'TRUE', 'True', 'yes', 'on']) {
      expect(readBool({ X: raw }, 'X', false), raw).toBe(true);
    }
    for (const raw of ['0', 'false', 'FALSE', 'False', 'no', 'off']) {
      expect(readBool({ X: raw }, 'X', true), raw).toBe(false);
    }
  });

  it('uses the fallback for a boolean that is not set', () => {
    expect(readBool({}, 'X', true)).toBe(true);
    expect(readBool({ X: '' }, 'X', false)).toBe(false);
  });

  it('rejects a boolean value it does not recognise, naming the variable', () => {
    expect(() => readBool({ COOKIE_SECURE: 'maybe' }, 'COOKIE_SECURE', false)).toThrow(
      /COOKIE_SECURE/,
    );
  });

  it('reads an enum value in any casing', () => {
    expect(readEnum({ OAUTH_PROVIDER: 'Google' }, 'OAUTH_PROVIDER', ['google'])).toBe('google');
    expect(readEnum({ EMAIL_TRANSPORT: 'ReSeNd' }, 'EMAIL_TRANSPORT', ['console', 'resend'])).toBe(
      'resend',
    );
  });

  it('falls back for an enum variable that is unset or empty', () => {
    expect(readEnum({}, 'OAUTH_PROVIDER', ['google'])).toBeUndefined();
    expect(readEnum({ OAUTH_PROVIDER: '' }, 'OAUTH_PROVIDER', ['google'])).toBeUndefined();
    expect(
      readEnum({ EMAIL_TRANSPORT: '' }, 'EMAIL_TRANSPORT', ['console', 'resend'] as const, 'console'),
    ).toBe('console');
  });

  it('rejects an enum value it does not recognise, naming the variable and the options', () => {
    expect(() => readEnum({ OAUTH_PROVIDER: 'googly' }, 'OAUTH_PROVIDER', ['google'])).toThrow(
      /OAUTH_PROVIDER.*google/s,
    );
  });

  it('reads an integer and rejects one that is not a number, naming the variable', () => {
    expect(readInt({ PORT: ' 8080 ' }, 'PORT', 3000)).toBe(8080);
    expect(() => readInt({ PORT: 'eighty' }, 'PORT', 3000)).toThrow(/PORT/);
    expect(() => readInt({ PORT: '80.5' }, 'PORT', 3000)).toThrow(/PORT/);
  });

  it('reads a count that cannot be negative, and refuses one that is', () => {
    // A negative count is a setting that looks accepted and then means the
    // opposite of what it says — a slice of a plan would drop its last entry
    // rather than its first — so it fails at boot like any other value the
    // application cannot make sense of.
    expect(readNonNegativeInt({ X: '0' }, 'X', 5)).toBe(0);
    expect(readNonNegativeInt({ X: ' 3 ' }, 'X', 5)).toBe(3);
    expect(readNonNegativeInt({}, 'X', 5)).toBe(5);
    expect(() => readNonNegativeInt({ X: '-1' }, 'X', 5)).toThrow(/X/);
    expect(() => readNonNegativeInt({ X: 'lots' }, 'X', 5)).toThrow(/X/);
  });
});

describe('loadServerConfig', () => {
  it('reads the required variables', () => {
    const config = loadServerConfig(MINIMAL);
    expect(config.databaseUrl).toBe('./brieflyy.db');
    expect(config.appBaseUrl).toBe('http://localhost:3000');
  });

  it('names a required variable that is missing', () => {
    expect(() => loadServerConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadServerConfig({ DATABASE_URL: 'file:./x.db' })).toThrow(/APP_BASE_URL/);
  });

  it('defaults the optional variables', () => {
    const config = loadServerConfig(MINIMAL);
    expect(config.emailTransport).toBe('console');
    expect(config.emailFrom).toBe('Brieflyy <hello@brieflyy.dev>');
    expect(config.resendApiKey).toBeUndefined();
    expect(config.oauthProvider).toBeUndefined();
    expect(config.ingestEnabled).toBe(true);
    expect(config.ingestIntervalMs).toBe(30 * 60 * 1000);
    expect(config.ingestBackoffBaseMs).toBe(60 * 1000);
    expect(config.ingestBackoffMaxMs).toBe(30 * 60 * 1000);
    expect(config.devToolsEnabled).toBe(true);
    expect(config.cookieSecure).toBe(false);
    expect(config.trustProxy).toBe(false);
    expect(config.port).toBe(3000);
    expect(config.host).toBe('0.0.0.0');
  });

  it('reads TRUST_PROXY, so per-caller limits can work behind a proxy', () => {
    expect(loadServerConfig({ ...MINIMAL, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadServerConfig({ ...MINIMAL, TRUST_PROXY: 'TRUE' }).trustProxy).toBe(true);
    expect(loadServerConfig({ ...MINIMAL, TRUST_PROXY: '0' }).trustProxy).toBe(false);
    expect(() => loadServerConfig({ ...MINIMAL, TRUST_PROXY: 'behind' })).toThrow(/TRUST_PROXY/);
  });

  it('defaults COOKIE_SECURE to true when NODE_ENV is production', () => {
    expect(loadServerConfig({ ...MINIMAL, NODE_ENV: 'production' }).cookieSecure).toBe(true);
    expect(loadServerConfig({ ...MINIMAL, NODE_ENV: 'Production' }).cookieSecure).toBe(true);
    expect(loadServerConfig({ ...MINIMAL, NODE_ENV: 'development' }).cookieSecure).toBe(false);
  });

  it('lets COOKIE_SECURE override the NODE_ENV default', () => {
    expect(
      loadServerConfig({ ...MINIMAL, NODE_ENV: 'production', COOKIE_SECURE: 'false' }).cookieSecure,
    ).toBe(false);
  });

  it('reads the ingest timings, so a deployment can tune the poll rate', () => {
    const config = loadServerConfig({
      ...MINIMAL,
      INGEST_INTERVAL_MS: '5000',
      INGEST_BACKOFF_BASE_MS: '1000',
      INGEST_BACKOFF_MAX_MS: '2000',
    });
    expect(config.ingestIntervalMs).toBe(5000);
    expect(config.ingestBackoffBaseMs).toBe(1000);
    expect(config.ingestBackoffMaxMs).toBe(2000);
    expect(() =>
      loadServerConfig({ ...MINIMAL, INGEST_INTERVAL_MS: 'soon' }),
    ).toThrow(/INGEST_INTERVAL_MS/);
  });

  it('carries five Clusters of a brief and writes the top five of them', () => {
    const config = loadServerConfig(MINIMAL);
    expect(config.briefMaxClusters).toBe(5);
    expect(config.briefGeneratedClusters).toBe(5);
  });

  it('reads how many Clusters a brief carries, and how many of them are written', () => {
    // Two settings rather than one: the plan's size is a reading decision, and
    // the written top-N is a cost decision. A deployment that carries more of a
    // busy Topic than it wants to pay to write says so here.
    const config = loadServerConfig({
      ...MINIMAL,
      BRIEF_MAX_CLUSTERS: '8',
      BRIEF_GENERATED_CLUSTERS: '3',
    });
    expect(config.briefMaxClusters).toBe(8);
    expect(config.briefGeneratedClusters).toBe(3);
  });

  it('lets a deployment switch the written path off without unsetting a key', () => {
    expect(
      loadServerConfig({
        ...MINIMAL,
        OPENAI_API_KEY: 'sk-test',
        BRIEF_GENERATED_CLUSTERS: '0',
      }).briefGeneratedClusters,
    ).toBe(0);
  });

  it('refuses a Cluster count it cannot make sense of, naming the variable', () => {
    expect(() => loadServerConfig({ ...MINIMAL, BRIEF_MAX_CLUSTERS: '-1' })).toThrow(
      /BRIEF_MAX_CLUSTERS/,
    );
    expect(() => loadServerConfig({ ...MINIMAL, BRIEF_GENERATED_CLUSTERS: 'many' })).toThrow(
      /BRIEF_GENERATED_CLUSTERS/,
    );
  });

  it('reads the summary provider credential, or nothing when there is none', () => {
    expect(loadServerConfig(MINIMAL).openaiApiKey).toBeUndefined();
    expect(loadServerConfig(MINIMAL).openaiApiUrl).toBe('https://api.openai.com/v1/chat/completions');
    const configured = loadServerConfig({
      ...MINIMAL,
      OPENAI_API_KEY: ' sk-test ',
      OPENAI_API_URL: 'https://llm.internal/chat',
    });
    expect(configured.openaiApiKey).toBe('sk-test');
    expect(configured.openaiApiUrl).toBe('https://llm.internal/chat');
  });

  it('registers the dev tools outside production, and not in it', () => {
    expect(
      loadServerConfig({ ...MINIMAL, NODE_ENV: 'production' }).devToolsEnabled,
    ).toBe(false);
    expect(loadServerConfig({ ...MINIMAL, NODE_ENV: 'development' }).devToolsEnabled).toBe(
      true,
    );
  });

  it('lets DEV_TOOLS_ENABLED override the NODE_ENV default', () => {
    expect(
      loadServerConfig({ ...MINIMAL, NODE_ENV: 'development', DEV_TOOLS_ENABLED: '0' })
        .devToolsEnabled,
    ).toBe(false);
    expect(
      loadServerConfig({ ...MINIMAL, NODE_ENV: 'production', DEV_TOOLS_ENABLED: 'true' })
        .devToolsEnabled,
    ).toBe(true);
  });

  it('enables Google sign-in whatever the casing of OAUTH_PROVIDER', () => {
    for (const raw of ['google', 'Google', 'GOOGLE']) {
      const config = loadServerConfig({
        ...MINIMAL,
        OAUTH_PROVIDER: raw,
        GOOGLE_OAUTH_CLIENT_ID: 'id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      });
      expect(config.oauthProvider, raw).toBe('google');
      expect(config.googleOAuthClientId, raw).toBe('id');
      expect(config.googleOAuthClientSecret, raw).toBe('secret');
    }
  });

  it('does not silently disable Google sign-in when a credential is missing', () => {
    expect(() => loadServerConfig({ ...MINIMAL, OAUTH_PROVIDER: 'google' })).toThrow(
      /GOOGLE_OAUTH_CLIENT_ID/,
    );
    expect(() =>
      loadServerConfig({
        ...MINIMAL,
        OAUTH_PROVIDER: 'google',
        GOOGLE_OAUTH_CLIENT_ID: 'id',
      }),
    ).toThrow(/GOOGLE_OAUTH_CLIENT_SECRET/);
  });

  it('requires the Resend key when the email transport is resend', () => {
    expect(() => loadServerConfig({ ...MINIMAL, EMAIL_TRANSPORT: 'resend' })).toThrow(
      /RESEND_API_KEY/,
    );
    expect(
      loadServerConfig({ ...MINIMAL, EMAIL_TRANSPORT: 'Resend', RESEND_API_KEY: 're_x' })
        .resendApiKey,
    ).toBe('re_x');
  });

  it('fails at boot, naming the variable, when a value is not recognised', () => {
    const cases: Record<string, string> = {
      EMAIL_TRANSPORT: 'mailgun',
      OAUTH_PROVIDER: 'googly',
      INGEST_ENABLED: 'perhaps',
      COOKIE_SECURE: 'sometimes',
      DEV_TOOLS_ENABLED: 'perhaps',
      TRUST_PROXY: 'maybe',
      PORT: 'eighty',
    };
    for (const [name, value] of Object.entries(cases)) {
      expect(() => loadServerConfig({ ...MINIMAL, [name]: value }), name).toThrow(
        new RegExp(name),
      );
    }
  });
});
