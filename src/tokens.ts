export interface TokenLike {
  text: string;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
  speaker?: string | null;
}

export interface MergedWord {
  word: string;
  punctuated_word: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: string;
}

/**
 * Soniox returns subword pieces; a leading space marks the start of a word.
 * Deepgram's contract (and SuperWhisper) expects whole words, so glue pieces
 * together and attach punctuation to the preceding word.
 */
export function mergeTokensToWords(tokens: TokenLike[]): MergedWord[] {
  const words: MergedWord[] = [];
  let current: MergedWord | null = null;
  let confidenceSum = 0;
  let confidenceCount = 0;

  for (const token of tokens) {
    const raw = token.text;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const startsNewWord = /^\s/.test(raw) || current === null;
    const isPunctuation = /^[.,!?;:…]+$/.test(trimmed);

    if (isPunctuation) {
      if (current) {
        current.punctuated_word += trimmed;
        current.end = (token.end_ms ?? current.end * 1000) / 1000;
      } else {
        words.push({
          word: "",
          punctuated_word: trimmed,
          start: (token.start_ms ?? 0) / 1000,
          end: (token.end_ms ?? 0) / 1000,
          confidence: token.confidence ?? 1,
          ...(token.speaker ? { speaker: token.speaker } : {}),
        });
      }
      continue;
    }

    if (startsNewWord) {
      current = {
        word: trimmed,
        punctuated_word: trimmed,
        start: (token.start_ms ?? 0) / 1000,
        end: (token.end_ms ?? 0) / 1000,
        confidence: token.confidence ?? 1,
        ...(token.speaker ? { speaker: token.speaker } : {}),
      };
      words.push(current);
      confidenceSum = token.confidence ?? 1;
      confidenceCount = 1;
    } else if (current) {
      current.word += trimmed;
      current.punctuated_word += trimmed;
      current.end = (token.end_ms ?? current.end * 1000) / 1000;
      confidenceSum += token.confidence ?? 1;
      confidenceCount += 1;
      current.confidence = confidenceSum / confidenceCount;
      if (token.speaker) current.speaker = token.speaker;
    }
  }
  return words;
}

export function tokensToText(tokens: TokenLike[]): string {
  return mergeTokensToWords(tokens)
    .map((word) => word.punctuated_word)
    .join(" ")
    .trim();
}
