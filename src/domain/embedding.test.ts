import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_ENCODING,
  decodeEmbedding,
  embeddingSimilarity,
  encodeEmbedding,
  mixedEmbeddingSet,
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

describe('embeddingSimilarity', () => {
  const of = (values: readonly number[], model = 'm'): StoryEmbedding => ({ model, values });

  it('scores a vector against itself as exactly 1', () => {
    expect(embeddingSimilarity(A_VECTOR, A_VECTOR)).toBe(1);
  });

  it('scores two vectors pointing the same way above two pointing the other', () => {
    // Two pairs of the same shape, differing only in which way the second leans.
    // The reading is what a model says two Articles mean alike, so a pair meaning
    // opposite things has to score low however long either vector is — this is
    // about the cosine reaching both ends rather than about any floor.
    const together = embeddingSimilarity(of([1, 0, 0, 0]), of([0.9, 0.1, 0, 0]));
    const apart = embeddingSimilarity(of([0, 1, 0, 0]), of([0.1, -0.9, 0, 0]));

    expect(together).toBeGreaterThan(0.9);
    expect(apart).toBeLessThan(-0.9);
  });

  it('scores two vectors at right angles as zero, which is a measurement and not a refusal', () => {
    // Zero here is a reading — these Articles mean nothing alike — and it is a
    // different answer from the null below. The floor is what tells the two apart,
    // which is the same division the Entity cosine makes and the reason this is a
    // floor of its own rather than a third reading blended into the first.
    expect(embeddingSimilarity(of([1, 0, 0, 0]), of([0, 0, 0, 1]))).toBe(0);
  });

  it('says it cannot compare rather than saying the pair means nothing alike', () => {
    // Every one of these is the absence of a measurement, and a floor reading any of
    // them as a low score would be recording a verdict it has no evidence for. Two
    // Stories embedded by two different models are not more different than two that
    // carry none: there is simply nothing to compare.
    expect(embeddingSimilarity(A_VECTOR, null)).toBeNull();
    expect(embeddingSimilarity(null, A_VECTOR)).toBeNull();
    expect(embeddingSimilarity(null, null)).toBeNull();
    expect(embeddingSimilarity(of([1, 0, 0, 0], 'one'), of([1, 0, 0, 0], 'two'))).toBeNull();
    expect(embeddingSimilarity(of([1, 0, 0, 0]), of([1, 0, 0, 0, 0]))).toBeNull();
    expect(embeddingSimilarity(of([0, 0, 0, 0]), of([1, 0, 0, 0]))).toBeNull();
    expect(embeddingSimilarity(of([1, Number.NaN, 0, 0]), of([1, 0, 0, 0]))).toBeNull();
  });

  it('scores a stored vector the same as the one it was stored from', () => {
    // Read back through the decoder rather than through the column, so the score a
    // Story is grouped on is the score of the vector a reader would find there.
    // Every value is one a float32 holds exactly, because the storage is float32
    // and the assertion is about the comparison rather than about the rounding.
    const exact: StoryEmbedding = { model: 'm', values: [0.5, 0.25, -1, 0] };

    expect(embeddingSimilarity(exact, decodeEmbedding(stored(exact), exact.model))).toBe(1);
  });
});

describe('mixedEmbeddingSet', () => {
  const of = (model: string): StoryEmbedding => ({ model, values: [1, 0, 0, 0] });

  it('reports nothing about a set every one of whose Stories was embedded by one model', () => {
    // The state every corpus is in until somebody changes the configured model, and
    // the one nothing here may disturb: a set that agrees is not a set to refuse.
    expect(mixedEmbeddingSet([of('one'), of('one'), null])).toBeNull();
  });

  it('reports nothing about a set carrying no embedding at all', () => {
    // Zero models rather than one, and a set holding zero is not a set holding two.
    // This is every Story in a database predating the embedding (ADR-0037), so a
    // check that counted the absence as a disagreement would take such a corpus from
    // grouping to not grouping in one change.
    expect(mixedEmbeddingSet([null, null, null])).toBeNull();
    expect(mixedEmbeddingSet([])).toBeNull();
  });

  it('names every model it found in a set two of them embedded', () => {
    // The mixed set: the configured model changed and only some Stories were
    // recomputed. Both names, because an operator cannot act on "there was more
    // than one" and the whole point of the refusal is that the corpus needs
    // backfilling with one model — which one is the question.
    expect(mixedEmbeddingSet([of('vendor/b-2'), of('vendor/a-1')])?.models).toEqual([
      'vendor/a-1',
      'vendor/b-2',
    ]);
  });

  it('names a model once however many Stories carry it, and reads what each Story carries', () => {
    // The name is read off the vector's own column rather than off configuration:
    // what the provider said produced the vector is the record, and a set where the
    // configuration names a model no Story carries is still the set these Stories
    // describe.
    expect(
      mixedEmbeddingSet([of('vendor/a-1'), of('vendor/b-2'), of('vendor/a-1'), null])?.models,
    ).toEqual(['vendor/a-1', 'vendor/b-2']);
  });

  const wide = (model: string, width: number): StoryEmbedding => ({
    model,
    values: Array.from({ length: width }, () => 0),
  });

  it('refuses one model held at two widths, and names both the model and the widths', () => {
    // The door ADR-0040 closes at model level re-opens at width level: a model that
    // changed its output size between two calls — or a name routed to a different
    // vendor — returns vectors of a different width under the same name. Every
    // cosine is still a number, so nothing pairwise notices; the set-level check
    // reads the widths and refuses before any pair is scored.
    const refusal = mixedEmbeddingSet([wide('one', 4), wide('one', 5)]);
    expect(refusal).not.toBeNull();
    expect(refusal!.models).toEqual(['one']);
    expect(refusal!.widths).toEqual([4, 5]);
  });

  it('refuses two models at two widths with the same refusal, not a second one beside it', () => {
    // The width check is the same refusal taken one door wider: two models is still
    // one refusal carrying every model and every width the set was found to hold,
    // and nothing about the two-model case changes apart from the widths it names.
    const refusal = mixedEmbeddingSet([wide('vendor/a-1', 4), wide('vendor/b-2', 5)]);
    expect(refusal).not.toBeNull();
    expect(refusal!.models).toEqual(['vendor/a-1', 'vendor/b-2']);
    expect(refusal!.widths).toEqual([4, 5]);
  });

  it('still refuses two models at one width exactly as before', () => {
    // Nothing old stops refusing: two models sharing one width is still a refusal,
    // now naming the one width it holds beside the two models.
    const refusal = mixedEmbeddingSet([
      wide('vendor/a-1', 4),
      wide('vendor/b-2', 4),
      wide('vendor/a-1', 4),
    ]);
    expect(refusal).not.toBeNull();
    expect(refusal!.models).toEqual(['vendor/a-1', 'vendor/b-2']);
    expect(refusal!.widths).toEqual([4]);
  });

  it('reads one model at one width exactly as before, however many Stories carry it', () => {
    // Zero-width refusal surface where there is none: one model at one width is
    // the consistent set, and nothing about it is newly refused.
    expect(mixedEmbeddingSet([wide('one', 4), wide('one', 4), null])).toBeNull();
    expect(mixedEmbeddingSet([wide('one', 4)])).toBeNull();
  });

  it('reads a set carrying no embedding exactly as before', () => {
    // Zero models rather than one, and widths only exist beside vectors: a set of
    // absences holds nothing to refuse.
    expect(mixedEmbeddingSet([null, null, null])).toBeNull();
    expect(mixedEmbeddingSet([])).toBeNull();
  });
});
