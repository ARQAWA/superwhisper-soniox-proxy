import { describe, expect, it } from "vitest";
import { safeWebSocketCloseCode } from "../src/realtime.js";

describe("safeWebSocketCloseCode", () => {
  it("keeps sendable application close codes", () => {
    expect(safeWebSocketCloseCode(1000)).toBe(1000);
    expect(safeWebSocketCloseCode(1001)).toBe(1001);
    expect(safeWebSocketCloseCode(1011)).toBe(1011);
    expect(safeWebSocketCloseCode(3000)).toBe(3000);
    expect(safeWebSocketCloseCode(4999)).toBe(4999);
  });

  it("replaces reserved and invalid close codes", () => {
    for (const code of [0, 999, 1004, 1005, 1006, 1015, 5000]) {
      expect(safeWebSocketCloseCode(code)).toBe(1011);
    }
  });
});
