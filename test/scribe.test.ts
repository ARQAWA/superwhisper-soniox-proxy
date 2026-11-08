import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { applyScribeVadTuning, forwardScribeFrame } from "../src/scribe.js";

interface SentFrame {
  data: WebSocket.RawData;
  binary: boolean;
}

function fakeClient(readyState: 0 | 1 | 2 | 3): { readyState: 0 | 1 | 2 | 3; sent: SentFrame[]; send: (data: WebSocket.RawData, options: { binary: boolean }) => void } {
  return {
    readyState,
    sent: [],
    send(data, options) {
      this.sent.push({ data, binary: options.binary });
    },
  };
}

describe("Scribe VAD tuning", () => {
  const tuning = {
    silenceThresholdSecs: 1.5,
    threshold: 0.4,
    minSpeechDurationMs: 100,
    minSilenceDurationMs: 100,
  };

  it("rewrites VAD endpoint controls and preserves the token and unknown parameters", () => {
    const url = new URL(
      "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&commit_strategy=vad&vad_silence_threshold_secs=0.3&vad_threshold=0.5&min_speech_duration_ms=250&min_silence_duration_ms=250&token=sutkn_test&custom=keep",
    );
    const tuned = applyScribeVadTuning(url, tuning);
    expect(tuned.searchParams.get("vad_silence_threshold_secs")).toBe("1.5");
    expect(tuned.searchParams.get("vad_threshold")).toBe("0.4");
    expect(tuned.searchParams.get("min_speech_duration_ms")).toBe("100");
    expect(tuned.searchParams.get("min_silence_duration_ms")).toBe("100");
    expect(tuned.searchParams.get("token")).toBe("sutkn_test");
    expect(tuned.searchParams.get("custom")).toBe("keep");
  });

  it("does not change manual or turn-prediction commit strategies", () => {
    for (const strategy of ["manual", "turn_prediction"]) {
      const url = new URL(
        `wss://api.elevenlabs.io/v1/speech-to-text/realtime?commit_strategy=${strategy}&vad_silence_threshold_secs=0.3&token=sutkn_test`,
      );
      const tuned = applyScribeVadTuning(url, tuning);
      expect(tuned.searchParams.get("vad_silence_threshold_secs")).toBe("0.3");
      expect(tuned.searchParams.get("token")).toBe("sutkn_test");
    }
  });
});

describe("Scribe forwarding", () => {
  it("forwards upstream text frames unchanged", () => {
    const client = fakeClient(WebSocket.OPEN);
    const frame = Buffer.from(JSON.stringify({ message_type: "committed_transcript", text: "готово" }));
    forwardScribeFrame(client, frame, false);
    expect(client.sent).toEqual([{ data: frame, binary: false }]);
  });

  it("forwards upstream binary frames unchanged", () => {
    const client = fakeClient(WebSocket.OPEN);
    const frame = Buffer.from([1, 2, 3]);
    forwardScribeFrame(client, frame, true);
    expect(client.sent).toEqual([{ data: frame, binary: true }]);
  });

  it("does not send after the client closes", () => {
    const client = fakeClient(WebSocket.CLOSED);
    forwardScribeFrame(client, Buffer.from("late"), false);
    expect(client.sent).toEqual([]);
  });
});
