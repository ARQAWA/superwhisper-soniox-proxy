import { describe, expect, it } from "vitest";
import { sonioxLanguagePolicy } from "../src/language.js";

describe("Soniox language policy", () => {
  it("turns the Hindi sentinel into automatic detection", () => {
    expect(sonioxLanguagePolicy("hi", "hi")).toEqual({
      language: "auto",
      hints: [],
      identify: true,
    });
    expect(sonioxLanguagePolicy("hi-IN", "hi")).toEqual({
      language: "auto",
      hints: [],
      identify: true,
    });
  });

  it("keeps a fixed hint for other languages", () => {
    expect(sonioxLanguagePolicy("ru", "hi")).toEqual({
      language: "ru",
      hints: ["ru"],
      identify: false,
    });
    expect(sonioxLanguagePolicy("fr", "hi")).toEqual({
      language: "fr",
      hints: ["fr"],
      identify: true,
    });
  });

  it("keeps the ru/en fallback for auto and empty values", () => {
    expect(sonioxLanguagePolicy("auto", "hi")).toEqual({
      language: "auto",
      hints: ["ru", "en"],
      identify: true,
    });
    expect(sonioxLanguagePolicy("", "hi")).toEqual({
      language: "auto",
      hints: ["ru", "en"],
      identify: true,
    });
  });

  it("honors a custom sentinel", () => {
    expect(sonioxLanguagePolicy("xx", "xx")).toEqual({
      language: "auto",
      hints: [],
      identify: true,
    });
  });
});
