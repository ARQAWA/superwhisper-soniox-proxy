import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function config(env: NodeJS.ProcessEnv = {}) {
  return loadConfig({ SONIOX_API_KEY: "test-key", ...env });
}

describe("Soniox realtime tuning", () => {
  it("uses Soniox's conservative endpoint defaults", () => {
    const loaded = config();
    expect(loaded.SONIOX_ENDPOINT_DETECTION).toBe(true);
    expect(loaded.SONIOX_ENDPOINT_SENSITIVITY).toBe(0);
    expect(loaded.SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL).toBe(0);
    expect(loaded.SONIOX_MAX_ENDPOINT_DELAY_MS).toBe(2000);
    expect(loaded.SONIOX_KEEPALIVE_MS).toBe(10000);
  });

  it("rejects an unrecognized boolean", () => {
    expect(() => config({ SONIOX_ENDPOINT_DETECTION: "ture" })).toThrow(
      /expected a boolean/,
    );
  });

  it("accepts lower-latency and disabled variants", () => {
    const loaded = config({
      SONIOX_ENDPOINT_DETECTION: "false",
      SONIOX_ENDPOINT_SENSITIVITY: "-0.3",
      SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL: "2",
      SONIOX_MAX_ENDPOINT_DELAY_MS: "1500",
      SONIOX_KEEPALIVE_MS: "5000",
    });
    expect(loaded.SONIOX_ENDPOINT_DETECTION).toBe(false);
    expect(loaded.SONIOX_ENDPOINT_SENSITIVITY).toBe(-0.3);
    expect(loaded.SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL).toBe(2);
    expect(loaded.SONIOX_MAX_ENDPOINT_DELAY_MS).toBe(1500);
    expect(loaded.SONIOX_KEEPALIVE_MS).toBe(5000);
  });
});
