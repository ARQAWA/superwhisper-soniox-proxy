import { describe, expect, it } from "vitest";
import { redactQuery } from "../src/url-utils.js";

describe("redactQuery", () => {
  it("keeps protocol parameters and hides user-specific values", () => {
    const url = new URL(
      "https://api.deepgram.com/v1/listen?model=nova-3&language=ru&punctuate=true&keywords=secret&keyterm=private&prompt=hello&foo=bar",
    );
    const query = redactQuery(url);
    expect(query).toContain("model=nova-3");
    expect(query).toContain("language=ru");
    expect(query).toContain("punctuate=true");
    expect(query).toContain("keywords=[REDACTED]");
    expect(query).toContain("keyterm=[REDACTED]");
    expect(query).toContain("prompt=[REDACTED]");
    expect(query).toContain("foo=[REDACTED]");
    expect(query).not.toContain("secret");
    expect(query).not.toContain("private");
    expect(query).not.toContain("hello");
  });

  it("returns an empty string when there is no query", () => {
    expect(redactQuery(new URL("https://api.deepgram.com/v1/listen"))).toBe("");
  });
});
