import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_ENCODING,
  decodeEmbedding,
  encodeEmbedding,
  type StoryEmbedding,
} from './embedding.js';

/** A worked vector rather than a generated one, so a wrong round-trip is visible. */
const A_VECTOR: StoryEmbedding = {
  model: 'openai/text-embedding-3-small',
  values: [1, -2.5, 0, 3.14159],
};

const stored = (embedding: StoryEmbedding): string => encodeEmbedding(embedding);

describe('encodeEmbedding', () => {
  it('says which encoding the value is in rather than leaving a reader to guess', () => {
    expect(stored(A_VECTOR).startsWith(`${EMBEDDING_ENCODING}:`)).toBe(true);
  });

  it('writes four values as the sixteen bytes they are, not as the text of them', () => {
    // A worked example rather than a generated one: 1, -2.5, 0 and pi little-endian
    // as float32, so a reader can check the encoding by hand.
    expect(stored(A_VECTOR)).toBe('f32le:1:AACAPwAAIMAAAAAA0A9JQA==');
  });

  it('costs the same per value however many digits the value was written with', () => {
    // The property four bytes per value buys: a vector stored as text grows with
    // the precision of every number in it, and this one does not grow at all.
    const rounded = { model: 'm', values: [0.5, 0.25, 0, -1] };
    const precise = { model: 'm', values: [0.1234567890123, 0.8765432109876, 0.5, -1] };
    expect(stored(precise).length).toBe(stored(rounded).length);
  });

  it('is shorter than the JSON of the same vector at the dimension a model returns', () => {
    // 1,536 is the width the shipped model returns, and at that size the saving is
    // the difference between a Story carrying a readable vector and one carrying
    // a paragraph of digits.
    const wide: StoryEmbedding = {
      model: 'm',
      values: Array.from({ length: 1536 }, (_unused, index) => index / 1536),
    };
    expect(stored(wide).length).toBeLessThan(JSON.stringify(wide.values).length);
  });
});

describe('decodeEmbedding', () => {
  it('reads back the vector it was given, at the precision it was stored at', () => {
    // The stored form is float32, so a value that a float32 cannot hold comes back
    // at float32's precision rather than the one it was written with. Everything a
    // float32 holds exactly — every entry but one above — comes back identically,
    // which is the whole claim about the encoding being lossless.
    const read = decodeEmbedding(stored(A_VECTOR), A_VECTOR.model);
    expect(read?.values).toEqual([1, -2.5, 0, Math.fround(3.14159)]);
    expect(read?.model).toBe(A_VECTOR.model);
  });

  it('keeps a value the model produced whole rather than rounding it', () => {
    // 0.5 and 0.25 are representable in a float32 exactly, so this is the vector
    // itself rather than an approximation of it: the stored form is not a lossy
    // second opinion about what the model said.
    const exact: StoryEmbedding = { model: 'm', values: [0.5, 0.25, -1, 0] };
    expect(decodeEmbedding(stored(exact), exact.model)).toEqual(exact);
  });

  it('reads an absent value as no embedding rather than as a vector of zeroes', () => {
    // The distinction the whole decision rests on: a zero vector is what a model
    // says about nothing, and reads as a Story that means nothing at all rather
    // than as a Story nothing has looked at.
    expect(decodeEmbedding(null, A_VECTOR.model)).toBeNull();
    expect(decodeEmbedding(undefined, A_VECTOR.model)).toBeNull();
    expect(decodeEmbedding('', A_VECTOR.model)).toBeNull();
  });

  it('refuses a value it cannot read rather than returning a partial vector', () => {
    // A version this build does not speak, an encoding from another one, a
    // payload that is not a whole number of float32s, and an empty payload: four
    // ways of holding bytes that are not a vector, and a truncated read of any of
    // them would be compared against as though it were the whole reading.
    expect(decodeEmbedding('f32le:9:AACAPwAAIMAAAAAA0A9JQA==', 'm')).toBeNull();
    expect(decodeEmbedding('json:[1,2,3]', 'm')).toBeNull();
    expect(
      decodeEmbedding(`f32le:1:${Buffer.from('not a whole number of float32s').toString('base64')}`, 'm'),
    ).toBeNull();
    expect(decodeEmbedding('f32le:1:', 'm')).toBeNull();
  });

  it('refuses a value whose model is missing, because two models are not comparable', () => {
    // The model is stored beside the vector rather than inside it, so a row whose
    // vector arrived without one is read as carrying no embedding at all: a
    // vector with nothing to say which model produced it is not evidence.
    const encoded = stored(A_VECTOR);
    expect(decodeEmbedding(encoded, null)).toBeNull();
    expect(decodeEmbedding(encoded, undefined)).toBeNull();
    expect(decodeEmbedding(encoded, '')).toBeNull();
    expect(decodeEmbedding(encoded, '   ')).toBeNull();
  });

  it('reads the model it is given beside the vector', () => {
    expect(decodeEmbedding(stored(A_VECTOR), 'another/model')?.model).toBe('another/model');
  });
});