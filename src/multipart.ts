import { Readable } from "node:stream";
import { Busboy } from "@fastify/busboy";
import type { ParsedFile, ParsedMultipart } from "./types.js";

const AUDIO_EXTENSIONS = [".wav", ".mp3", ".m4a", ".ogg", ".opus", ".webm", ".flac", ".aif", ".aiff", ".mp4", ".mov"];

function isAudioFile(file: ParsedFile): boolean {
  if (file.mimeType.toLowerCase().startsWith("audio/")) return true;
  if (file.mimeType.toLowerCase() === "video/webm") return true;
  const name = file.filename.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export async function parseMultipart(
  body: Buffer,
  contentType: string,
  maxBodyBytes: number,
): Promise<ParsedMultipart> {
  if (!/^multipart\/form-data/i.test(contentType)) {
    throw new Error("not multipart/form-data");
  }

  const fields: Record<string, string> = {};
  const files: ParsedFile[] = [];
  const pending: Promise<void>[] = [];

  const bb = Busboy({
    headers: { "content-type": contentType },
    limits: {
      fileSize: maxBodyBytes,
      files: 8,
      fields: 64,
      parts: 128,
    },
  });

  const finished = new Promise<void>((resolve, reject) => {
    let failed = false;
    const fail = (err: Error) => {
      if (failed) return;
      failed = true;
      reject(err);
    };

    bb.on("field", (name: string, value: string) => {
      fields[name] = value;
    });

    bb.on("file", (name: string, stream: NodeJS.ReadableStream, filename: string, _transferEncoding: string, mimeType: string) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const done = new Promise<void>((resolveFile) => {
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          chunks.push(chunk);
        });
        stream.on("limit", () => {
          truncated = true;
        });
        stream.on("end", () => {
          if (truncated) {
            fail(new Error(`multipart file ${name} exceeds ${maxBodyBytes} bytes`));
          } else {
            files.push({
              field: name,
              filename: filename || "audio.bin",
              mimeType: mimeType || "application/octet-stream",
              size,
              data: Buffer.concat(chunks, size),
            });
          }
          resolveFile();
        });
        stream.on("error", (err: Error) => {
          fail(err);
          resolveFile();
        });
        stream.resume();
      });
      pending.push(done);
    });

    bb.on("error", (err: Error) => fail(err));
    bb.on("finish", () => {
      Promise.all(pending).then(() => resolve()).catch(fail);
    });
  });

  const input = Readable.from(body);
  input.pipe(bb);
  await finished;

  const audioFiles = files.filter(isAudioFile);
  const preferred =
    audioFiles.find((f) => ["audio", "file", "recording"].includes(f.field)) ??
    audioFiles.sort((a, b) => b.size - a.size)[0] ??
    null;

  return {
    fields,
    fieldNames: Object.keys(fields),
    files,
    audio: preferred,
  };
}
