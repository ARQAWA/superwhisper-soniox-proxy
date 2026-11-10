import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { isTargetRealtimeRequest } from "../src/realtime.js";

function config(env: NodeJS.ProcessEnv = {}) {
  return loadConfig({ SONIOX_API_KEY: "test-key", ...env });
}

describe("Realtime routing", () => {
  it("accepts the target model without reading app state", () => {
    const loaded = config();
    expect(isTargetRealtimeRequest(loaded, "nova-3")).toBe(true);
  });

  it("accepts the app's realtime query model for Nova 3", () => {
    const loaded = config();
    expect(isTargetRealtimeRequest(loaded, "nova-2")).toBe(true);
  });

  it("rejects other models and missing models", () => {
    const loaded = config();
    expect(isTargetRealtimeRequest(loaded, "nova-1")).toBe(false);
    expect(isTargetRealtimeRequest(loaded, null)).toBe(false);
  });

  it("honors a custom query model list", () => {
    const loaded = config({ TARGET_REALTIME_QUERY_MODELS: "nova-4" });
    expect(isTargetRealtimeRequest(loaded, "nova-4")).toBe(true);
    expect(isTargetRealtimeRequest(loaded, "nova-2")).toBe(false);
  });
});
