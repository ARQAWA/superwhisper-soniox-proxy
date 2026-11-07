import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderDeepgramLikeResponse } from "../src/template.js";

const template = JSON.parse(
  readFileSync(join(process.cwd(), "fixtures", "superwhisper-response.template.json"), "utf8"),
);

describe("renderDeepgramLikeResponse", () => {
  it("fills the captured Deepgram-shaped template with merged words", () => {
    const rendered = renderDeepgramLikeResponse({
      template,
      text: "Это проверка.",
      tokens: [
        { text: "Это", start_ms: 0, end_ms: 100, confidence: 0.9 },
        { text: " про", start_ms: 120, end_ms: 180, confidence: 0.8 },
        { text: "вер", start_ms: 180, end_ms: 220, confidence: 0.8 },
        { text: "ка", start_ms: 220, end_ms: 260, confidence: 0.8 },
        { text: ".", start_ms: 260, end_ms: 280, confidence: 0.9 },
      ],
      durationSeconds: 1.25,
      requestId: "req-test",
      language: "ru",
    }) as Record<string, any>;

    const alt = rendered.results.channels[0].alternatives[0];
    expect(alt.transcript).toBe("Это проверка.");
    expect(alt.words.map((word: any) => word.punctuated_word)).toEqual(["Это", "проверка."]);
    expect(alt.paragraphs.transcript).toBe("Это проверка.");
    expect(alt.paragraphs.paragraphs[0].num_words).toBe(2);
    expect(rendered.metadata.duration).toBe(1.25);
    expect(rendered.metadata.request_id).toBe("req-test");
  });
});
