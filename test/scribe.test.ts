import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { forwardScribeFrame } from "../src/scribe.js";

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
