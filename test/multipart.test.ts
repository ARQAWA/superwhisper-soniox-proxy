import { describe, expect, it } from "vitest";
import { parseMultipart } from "../src/multipart.js";

const boundary = "----soniox-test-boundary";

function buildMultipart(): Buffer {
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
      buildMultipart(),
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
