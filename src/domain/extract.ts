const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'should',
  'could',
  'may',
  'might',
  'must',
  'shall',
  'can',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'with',
  'by',
  'from',
  'as',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'he',
  'she',
  'they',
  'them',
  'his',
  'her',
  'their',
  'we',
  'us',
  'our',
  'i',
  'me',
  'my',
  'you',
  'your',
  'yours',
]);

const SENTENCE_SPLIT = /(?<=[.!?])\s+|(?<=.{40,})\n/;
const WORD = /[A-Za-z][A-Za-z'-]*/g;
const CAPITAL_TOKEN = /^[A-Z][a-z]+(?:[ '-][A-Z][a-z]+)*$/;

export function extractEntities(text: string): string[] {
  if (text.length === 0) return [];
  const sentences = text
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sentence of sentences) {
    const words = sentence.match(WORD) ?? [];
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!;
      if (!CAPITAL_TOKEN.test(word)) continue;
      let phrase = word;
      let j = i + 1;
      while (j < words.length && CAPITAL_TOKEN.test(words[j]!)) {
        phrase += ' ' + words[j];
        j++;
      }
      const norm = phrase.trim();
      if (norm.length === 0) continue;
      if (i === 0 && j - i === 1) {
        if (STOPWORDS.has(norm.toLowerCase())) continue;
      }
      if (seen.has(norm)) {
        i = j - 1;
        continue;
      }
      seen.add(norm);
      out.push(norm);
      i = j - 1;
    }
  }
  return out;
}

function isStopword(w: string): boolean {
  return STOPWORDS.has(w.toLowerCase());
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter(
    (w) => !isStopword(w),
  );
}

export function extractKeyPhrases(text: string): string[] {
  if (text.length === 0) return [];
  const tokens = tokenize(text);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let start = 0; start < tokens.length; start++) {
    for (let len = 2; len <= 3; len++) {
      const end = start + len;
      if (end > tokens.length) break;
      const phrase = tokens.slice(start, end).join(' ');
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      out.push(phrase);
    }
  }
  return out;
}