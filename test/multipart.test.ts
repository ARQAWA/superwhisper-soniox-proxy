import { describe, expect, it } from "vitest";
import { parseMultipart, rewriteScribeBatch } from "../src/multipart.js";

const boundary = "----soniox-test-boundary";

function rawMultipart(): Buffer {
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nnova-3\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="clip.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`,
    Buffer.from([0x4f, 0x67, 0x67, 0x53]),
    `\r\n--${boundary}--\r\n`,
  ];
  return Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part)));
}

describe("parseMultipart", () => {
  it("extracts fields and prefers the audio file", async () => {
    const parsed = await parseMultipart(
      rawMultipart(),
      `multipart/form-data; boundary=${boundary}`,
      1024 * 1024,
    );
    expect(parsed.fields.model).toBe("nova-3");
    expect(parsed.audio?.filename).toBe("clip.ogg");
    expect(parsed.audio?.size).toBe(4);
    expect(parsed.fieldNames).toContain("model");
  });

  it("rejects non-multipart input", async () => {
    await expect(parseMultipart(Buffer.from("{}"), "application/json", 1024)).rejects.toThrow(
      "not multipart/form-data",
    );
  });
});

describe("rewriteScribeBatch", () => {
  const batchBoundary = "----scribe-batch-boundary";

  function batchBody(): Buffer {
    const parts = [
      `--${batchBoundary}\r\nContent-Disposition: form-data; name="language_code"\r\n\r\nru\r\n`,
      `--${batchBoundary}\r\nContent-Disposition: form-data; name="no_verbatim"\r\n\r\ntrue\r\n`,
      `--${batchBoundary}\r\nContent-Disposition: form-data; name="keyterms[]"\r\n\r\nSoniox\r\n`,
      `--${batchBoundary}\r\nContent-Disposition: form-data; name="keyterms[]"\r\n\r\nScribe\r\n`,
      `--${batchBoundary}\r\nContent-Disposition: form-data; name="diarize"\r\n\r\nfalse\r\n`,
      `--${batchBoundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`,
      Buffer.from([0x4f, 0x67, 0x67, 0x53]),
      `\r\n--${batchBoundary}--\r\n`,
    ];
    return Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part)));
  }

  it("keeps verbatim and drops paid keyterms but keeps language, diarize, and audio", async () => {
    const parsed = await parseMultipart(
      batchBody(),
      `multipart/form-data; boundary=${batchBoundary}`,
      1024 * 1024,
    );
    const rewritten = rewriteScribeBatch(parsed, { verbatim: true });
    const reparsed = await parseMultipart(rewritten.body, rewritten.contentType, 1024 * 1024);

    expect(reparsed.fields.language_code).toBe("ru");
    expect(reparsed.fields.diarize).toBe("false");
    expect(reparsed.fields).not.toHaveProperty("keyterms[]");
    expect(reparsed.fields.no_verbatim).toBe("false");
    expect(rewritten.droppedFields).toEqual(["keyterms[]"]);
    expect(rewritten.noVerbatim).toBe("false");
    expect(reparsed.audio?.filename).toBe("audio.ogg");
    expect(reparsed.audio?.data).toEqual(Buffer.from([0x4f, 0x67, 0x67, 0x53]));
  });

  it("can ask Scribe for cleanup explicitly", async () => {
    const parsed = await parseMultipart(
      batchBody(),
      `multipart/form-data; boundary=${batchBoundary}`,
      1024 * 1024,
    );
    const rewritten = rewriteScribeBatch(parsed, { verbatim: false });
    const reparsed = await parseMultipart(rewritten.body, rewritten.contentType, 1024 * 1024);

    expect(reparsed.fields.no_verbatim).toBe("true");
    expect(rewritten.noVerbatim).toBe("true");
  });
});
