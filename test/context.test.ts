import { describe, expect, it } from "vitest";
import {
  contextFromEnv,
  contextSummary,
  mergeContexts,
  parseContext,
  shouldUseStrictLanguage,
} from "../src/context.js";

describe("Soniox context", () => {
  it("keeps only the free-text prompt and drops word lists", () => {
    const context = parseContext({
      general: [{ key: "domain", value: "software" }],
      text: "  Technical dictation.  ",
      terms: ["Soniox", " soniox ", "Scribe"],
      translation_terms: [{ source: "a", target: "b" }],
    });
    expect(context).toEqual({ text: "Technical dictation." });
    expect(context).not.toHaveProperty("terms");
    expect(context).not.toHaveProperty("general");
    expect(context).not.toHaveProperty("translation_terms");
  });

  it("rejects an empty or non-object context", () => {
    expect(parseContext(null)).toBeNull();
    expect(parseContext([])).toBeNull();
    expect(parseContext({})).toBeNull();
    expect(parseContext({ terms: [] })).toBeNull();
    expect(parseContext({ terms: ["Soniox"] })).toBeNull();
  });

  it("merges text prompts without duplicates", () => {
    const merged = mergeContexts(
      { text: "File context" },
      { text: "Env context" },
      { text: "file CONTEXT" },
    );
    expect(merged?.text).toBe("File context\n\nEnv context");
  });

  it("builds context from the environment", () => {
    const context = contextFromEnv("  Keep English terms.  ");
    expect(context).toEqual({ text: "Keep English terms." });
    expect(contextSummary(context)).toEqual({ text_chars: 19 });
  });

  it("uses strict language only for one explicit hint", () => {
    expect(shouldUseStrictLanguage(["ru"], false, true)).toBe(true);
    expect(shouldUseStrictLanguage(["ru"], true, true)).toBe(false);
    expect(shouldUseStrictLanguage(["ru", "en"], false, true)).toBe(false);
    expect(shouldUseStrictLanguage([], false, true)).toBe(false);
    expect(shouldUseStrictLanguage(["ru"], false, false)).toBe(false);
  });
});
