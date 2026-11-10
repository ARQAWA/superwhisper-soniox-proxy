import { describe, expect, it } from "vitest";
import {
  contextFromEnv,
  contextSummary,
  mergeContexts,
  parseContext,
  scribeKeyterms,
  shouldUseStrictLanguage,
} from "../src/context.js";

describe("Soniox context", () => {
  it("parses the supported fields and drops unknown ones", () => {
    const context = parseContext({
      general: [{ key: "domain", value: "software" }],
      text: "  Technical dictation.  ",
      terms: ["Soniox", " soniox ", "Scribe"],
      translation_terms: [{ source: "a", target: "b" }],
    });
    expect(context).toEqual({
      general: [{ key: "domain", value: "software" }],
      text: "Technical dictation.",
      terms: ["Soniox", "Scribe"],
    });
    expect(context).not.toHaveProperty("translation_terms");
  });

  it("rejects an empty or non-object context", () => {
    expect(parseContext(null)).toBeNull();
    expect(parseContext([])).toBeNull();
    expect(parseContext({})).toBeNull();
    expect(parseContext({ terms: [] })).toBeNull();
  });

  it("merges file and environment context without duplicates", () => {
    const merged = mergeContexts(
      { text: "File context", terms: ["Soniox", "Scribe"] },
      { text: "Env context", terms: ["scribe", "Codex"] },
    );
    expect(merged?.text).toBe("File context\n\nEnv context");
    expect(merged?.terms).toEqual(["Soniox", "Scribe", "Codex"]);
  });

  it("builds context from the environment", () => {
    const context = contextFromEnv("", " Soniox, Scribe ,, ");
    expect(context?.terms).toEqual(["Soniox", "Scribe"]);
    expect(contextSummary(context)).toEqual({ general: 0, terms: 2, text_chars: 0 });
  });

  it("uses strict language only for one explicit hint", () => {
    expect(shouldUseStrictLanguage(["ru"], false, true)).toBe(true);
    expect(shouldUseStrictLanguage(["ru"], true, true)).toBe(false);
    expect(shouldUseStrictLanguage(["ru", "en"], false, true)).toBe(false);
    expect(shouldUseStrictLanguage([], false, true)).toBe(false);
    expect(shouldUseStrictLanguage(["ru"], false, false)).toBe(false);
  });

  it("limits Scribe keyterms to the provider contract", () => {
    const terms = [
      "Soniox",
      "soniox",
      "Scribe",
      "a-very-long-term-over-twenty-chars",
      "Codex",
    ];
    const selected = scribeKeyterms({ terms }, ["scribe"]);
    expect(selected).toEqual(["Soniox", "Codex"]);
  });
});
