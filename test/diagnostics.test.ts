import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { Diagnostics, type DiagnosticsOptions } from "../src/diagnostics.js";
import type { Logger } from "../src/logger.js";

const logger = pino({ level: "silent" }) as unknown as Logger;

function options(dir: string, enabled = true): DiagnosticsOptions {
  return {
    enabled,
    dir,
    retentionDays: 7,
    audioGapMs: 1500,
    resultGapMs: 8000,
    audioLagMs: 3000,
    closeTimeoutMs: 1500,
  };
}

function sessionFiles(dir: string): string[] {
  const sessions = join(dir, "sessions");
  if (!existsSync(sessions)) return [];
  const files: string[] = [];
  for (const day of readdirSync(sessions)) {
    const dayDir = join(sessions, day);
    for (const name of readdirSync(dayDir)) {
      if (name.endsWith(".jsonl")) files.push(join(dayDir, name));
    }
  }
  return files;
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("diagnostics", () => {
  it("writes a per-stream trace and an ok summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "soniox-diag-"));
    const diagnostics = new Diagnostics(options(dir), logger);
    const trace = diagnostics.startRealtime("req-1234-5678", {
      model: "nova-3",
      queryModel: "nova-2",
      sampleRate: 16000,
      channels: 1,
      language: "ru",
      identifyLanguage: false,
      diarize: false,
      endpointDetection: false,
      sonioxModel: "stt-rt-v6",
      closeDelayMs: 350,
    });

    trace.audioFrame(320);
    trace.audioFrame(320);
    trace.connected(120);
    trace.interimSent(12);
    trace.result({
      tokens: 4,
      finalTokens: 2,
      tailTokens: 2,
      newFinalTokens: 2,
      totalAudioProcMs: 1000,
      finalAudioProcMs: 800,
      windowStartMs: 0,
      windowEndMs: 1000,
      finished: false,
      textLength: 12,
    });
    trace.closeStream({ finalTokens: 2, tailTokens: 2, textLength: 12 });
    trace.finishRequested();
    trace.finished({ finalTokens: 4, tailTokens: 0, totalAudioProcMs: 1100 });
    trace.finalSent({
      finalTextLength: 18,
      finalTokens: 4,
      tailTokens: 0,
      maxInterimLength: 12,
      clientOpen: true,
      delivered: true,
      safetyNet: false,
      empty: false,
    });
    trace.clientClosed({
      code: 1000,
      reasonLength: 0,
      lostTextLength: null,
      finalTokens: 4,
      tailTokens: 0,
    });
    trace.end();

    const files = sessionFiles(dir);
    expect(files).toHaveLength(1);
    const events = readJsonl(files[0]);
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "stream_start",
        "audio_start",
        "soniox_connected",
        "soniox_result",
        "close_stream",
        "finish_requested",
        "soniox_finished",
        "final_result_sent",
        "client_close",
        "stream_end",
      ]),
    );
    expect(events.some((event) => event.event === "anomaly")).toBe(false);

    const summary = readJsonl(join(dir, "summary.jsonl"));
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      kind: "realtime",
      request_id: "req-1234-5678",
      status: "ok",
      final_sent: true,
      audio_frames: 2,
      audio_bytes: 640,
    });
  });

  it("flags a client that leaves before the final result", () => {
    const dir = mkdtempSync(join(tmpdir(), "soniox-diag-"));
    const diagnostics = new Diagnostics(options(dir), logger);
    const trace = diagnostics.startRealtime("req-abandoned", {
      model: "nova-3",
      queryModel: "nova-2",
      sampleRate: 16000,
      channels: 1,
      language: "ru",
      identifyLanguage: false,
      diarize: false,
      endpointDetection: false,
      sonioxModel: "stt-rt-v6",
      closeDelayMs: 350,
    });

    trace.audioFrame(320);
    trace.closeStream({ finalTokens: 10, tailTokens: 5, textLength: 80 });
    trace.clientClosed({
      code: 1006,
      reasonLength: 0,
      lostTextLength: 80,
      finalTokens: 10,
      tailTokens: 5,
    });
    trace.end();

    const summary = readJsonl(join(dir, "summary.jsonl"));
    expect(summary[0]).toMatchObject({
      status: "client_closed_before_final",
      final_sent: false,
      client_close_code: 1006,
    });

    const anomalies = readJsonl(join(dir, "anomalies.jsonl")).map((row) => row.code);
    expect(anomalies).toContain("client_closed_before_final");
    expect(anomalies).toContain("close_without_finished");
  });

  it("flags when Soniox processed far less audio than the proxy received", () => {
    const dir = mkdtempSync(join(tmpdir(), "soniox-diag-"));
    const diagnostics = new Diagnostics(options(dir), logger);
    const trace = diagnostics.startRealtime("req-audio-lag", {
      model: "nova-3",
      queryModel: "nova-2",
      sampleRate: 16000,
      channels: 1,
      language: "ru",
      identifyLanguage: false,
      diarize: false,
      endpointDetection: false,
      sonioxModel: "stt-rt-v6",
      closeDelayMs: 350,
    });

    // 10 seconds of mono s16le audio at 16 kHz, but Soniox reports only 2 seconds.
    trace.audioFrame(320_000);
    trace.result({
      tokens: 4,
      finalTokens: 2,
      tailTokens: 2,
      newFinalTokens: 2,
      totalAudioProcMs: 2000,
      finalAudioProcMs: 1000,
      windowStartMs: 0,
      windowEndMs: 2000,
      finished: false,
      textLength: 12,
    });
    trace.closeStream({ finalTokens: 2, tailTokens: 2, textLength: 12 });
    trace.end();

    const summary = readJsonl(join(dir, "summary.jsonl"));
    expect(summary[0].audio_proc_shortfall_ms).toBe(8000);
    const anomalies = readJsonl(join(dir, "anomalies.jsonl"));
    expect(anomalies.some((row) => row.code === "soniox_audio_lag" && row.shortfall_ms === 8000)).toBe(true);
  });

  it("stays silent and creates no files when disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "soniox-diag-"));
    const diagnostics = new Diagnostics(options(dir, false), logger);
    const trace = diagnostics.startRealtime("req-disabled", {
      model: "nova-3",
      queryModel: "nova-2",
      sampleRate: 16000,
      channels: 1,
      language: "ru",
      identifyLanguage: false,
      diarize: false,
      endpointDetection: false,
      sonioxModel: "stt-rt-v6",
      closeDelayMs: 350,
    });
    trace.audioFrame(320);
    trace.end();

    expect(sessionFiles(dir)).toHaveLength(0);
    expect(existsSync(join(dir, "summary.jsonl"))).toBe(false);
  });
});
