import { describe, expect, it } from 'vitest';

import { resolveIdentity } from './entity-identity.js';

describe('resolveIdentity', () => {
  it('resolves an exact key to itself', () => {
    expect(resolveIdentity('acme', ['acme', 'tinyco'])).toEqual({
      kind: 'exact',
      key: 'acme',
    });
  });

  it('lets a fuller name take over a stored partial row', () => {
    expect(resolveIdentity('christa pike', ['pike'])).toEqual({
      kind: 'takeover',
      key: 'christa pike',
      partialKey: 'pike',
    });
  });

  it('resolves a partial name to the fuller name already stored', () => {
    expect(resolveIdentity('pike', ['christa pike'])).toEqual({
      kind: 'fuller',
      key: 'christa pike',
    });
  });

  it('treats a head noun as new, not resolvable', () => {
    expect(resolveIdentity('bridge', ['northern bridge', 'severn bridge'])).toEqual(
      {
        kind: 'new',
        key: 'bridge',
      },
    );
  });

  it('returns new for a key with no stored match', () => {
    expect(resolveIdentity('riverton labs', ['acme', 'tinyco'])).toEqual({
      kind: 'new',
      key: 'riverton labs',
    });
  });

  it('does not let one word reach a longer name ending in it', () => {
    expect(resolveIdentity('pike', ['pike hinson'])).toEqual({
      kind: 'new',
      key: 'pike',
    });
  });

  it('does not resolve a partial onto a non-given-name fuller', () => {
    expect(resolveIdentity('openai', ['chatgpt openai'])).toEqual({
      kind: 'new',
      key: 'openai',
    });
  });

  it('resolves to the tightest fuller when several exist', () => {
    expect(resolveIdentity('martin', ['jay martin', 'michel martin'])).toEqual({
      kind: 'new',
      key: 'martin',
    });
  });

  it('resolves to the only fuller when exactly one exists', () => {
    expect(resolveIdentity('martin', ['jay martin'])).toEqual({
      kind: 'fuller',
      key: 'jay martin',
    });
  });
});
