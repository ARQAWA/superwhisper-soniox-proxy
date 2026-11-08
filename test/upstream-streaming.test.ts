import { describe, expect, it } from "vitest";
import { cleanRequestHeaders, cleanStreamingResponseHeaders } from "../src/upstream.js";

describe("cleanStreamingResponseHeaders", () => {
  it("keeps encoding and content length, drops framing headers", () => {
    const headers = cleanStreamingResponseHeaders({
      "content-type": "audio/mpeg",
      "content-encoding": "gzip",
      "content-length": "100",
      connection: "keep-alive",
    });
    expect(headers).toEqual({
      "content-type": "audio/mpeg",
      "content-encoding": "gzip",
      "content-length": "100",
    });
  });
});

describe("cleanRequestHeaders", () => {
  it("preserves encoding and length for streamed uploads", () => {
    const headers = cleanRequestHeaders(
      {
        "accept-encoding": "br",
        "content-length": "123",
        host: "api.elevenlabs.io",
      },
      "api.elevenlabs.io",
      Buffer.alloc(0),
      true,
    );
    expect(headers["accept-encoding"]).toBe("br");
    expect(headers["content-length"]).toBe("123");
    expect(headers.host).toBe("api.elevenlabs.io");
  });

  it("preserves chunked framing when length is absent", () => {
    const headers = cleanRequestHeaders(
      { "transfer-encoding": "chunked" },
      "api.elevenlabs.io",
      Buffer.alloc(0),
      true,
    );
    expect(headers["transfer-encoding"]).toBe("chunked");
    expect(headers["content-length"]).toBeUndefined();
  });

  it("preserves full transfer-coding lists and trailers", () => {
    const headers = cleanRequestHeaders(
      { "transfer-encoding": "gzip, chunked", trailer: "x-checksum" },
      "api.elevenlabs.io",
      Buffer.alloc(0),
      true,
    );
    expect(headers["transfer-encoding"]).toBe("gzip, chunked");
    expect(headers.trailer).toBe("x-checksum");
  });

  it("preserves response trailers", () => {
    const headers = cleanStreamingResponseHeaders({ trailer: "x-checksum" });
    expect(headers.trailer).toBe("x-checksum");
  });

  it("preserves response transfer codings", () => {
    const headers = cleanStreamingResponseHeaders({
      "transfer-encoding": "gzip, chunked",
      "content-type": "audio/mpeg",
    });
    expect(headers["transfer-encoding"]).toBe("gzip, chunked");
    expect(headers["content-type"]).toBe("audio/mpeg");
  });

  it("marks close-delimited transfer codings", () => {
    const headers = cleanStreamingResponseHeaders({ "transfer-encoding": "gzip" });
    expect(headers["transfer-encoding"]).toBe("gzip");
    expect(headers.connection).toBe("close");
  });

  it("drops encoding for buffered requests", () => {
    const headers = cleanRequestHeaders(
      { "accept-encoding": "br" },
      "api.elevenlabs.io",
      Buffer.from("abc"),
    );
    expect(headers["accept-encoding"]).toBeUndefined();
    expect(headers["content-length"]).toBe("3");
  });
});
