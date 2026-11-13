import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { recognitionSettings } from "../src/soniox.js";

describe("Soniox recognition settings", () => {
  const config = loadConfig({ SONIOX_API_KEY: "test-key" });
  const context = { text: "Technical dictation." };

  it("uses one configuration for batch and realtime", () => {
    const input = { languageHints: ["ru"], identifyLanguage: false, diarize: false };
    const batch = recognitionSettings(config, context, input);
    const realtime = recognitionSettings(config, context, input);

    expect(batch).toEqual(realtime);
    expect(batch).toEqual({
      language_hints: ["ru"],
      language_hints_strict: true,
      enable_language_identification: false,
      enable_speaker_diarization: false,
      context,
    });
  });

  it("keeps auto-detection and diarization consistent", () => {
    const settings = recognitionSettings(config, null, {
      languageHints: ["ru", "en"],
      identifyLanguage: true,
      diarize: true,
    });
    expect(settings.language_hints_strict).toBe(false);
    expect(settings.enable_language_identification).toBe(true);
    expect(settings.enable_speaker_diarization).toBe(true);
    expect(settings).not.toHaveProperty("context");
  });

  it("omits language hints for automatic detection", () => {
    const settings = recognitionSettings(config, null, {
      languageHints: [],
      identifyLanguage: true,
      diarize: false,
    });
    expect(settings).not.toHaveProperty("language_hints");
    expect(settings).not.toHaveProperty("language_hints_strict");
    expect(settings.enable_language_identification).toBe(true);
  });
});
