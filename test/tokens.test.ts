import { describe, expect, it } from "vitest";
import { mergeTokensToWords, tokensToText } from "../src/tokens.js";

describe("mergeTokensToWords", () => {
  it("glues Soniox subword pieces into whole words", () => {
    const words = mergeTokensToWords([
      { text: "Это", start_ms: 0, end_ms: 100, confidence: 0.9 },
      { text: " про", start_ms: 120, end_ms: 200, confidence: 0.8 },
      { text: "вер", start_ms: 200, end_ms: 260, confidence: 0.8 },
      { text: "ка", start_ms: 260, end_ms: 320, confidence: 0.8 },
      { text: ".", start_ms: 320, end_ms: 340, confidence: 0.9 },
      { text: " тест", start_ms: 360, end_ms: 460, confidence: 0.7 },
    ]);

    expect(words.map((word) => word.word)).toEqual(["Это", "проверка", "тест"]);
    expect(words.map((word) => word.punctuated_word)).toEqual(["Это", "проверка.", "тест"]);
    expect(words[1].start).toBeCloseTo(0.12, 3);
    expect(words[1].end).toBeCloseTo(0.34, 3);
    expect(tokensToText([
      { text: "Это", confidence: 1 },
      { text: " про", confidence: 1 },
      { text: "вер", confidence: 1 },
      { text: "ка", confidence: 1 },
      { text: ".", confidence: 1 },
    ])).toBe("Это проверка.");
  });

  it("preserves speakers and skips empty tokens", () => {
    const words = mergeTokensToWords([
      { text: "", confidence: 1 },
      { text: "Hello", start_ms: 0, end_ms: 100, confidence: 1, speaker: "1" },
      { text: " world", start_ms: 100, end_ms: 200, confidence: 1, speaker: "1" },
    ]);
    expect(words).toHaveLength(2);
    expect(words[0].speaker).toBe("1");
  });
});
