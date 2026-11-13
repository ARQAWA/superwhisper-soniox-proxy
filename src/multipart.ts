import { randomUUID } from "node:crypto";
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

export interface MultipartPart {
  name: string;
  value?: string;
  filename?: string;
  mimeType?: string;
  data?: Buffer;
}

function headerSafe(value: string): string {
  return value.replace(/[\r\n"]/g, "_");
}

export function buildMultipart(
  parts: MultipartPart[],
  boundary = `----swproxy-${randomUUID()}`,
): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const name = headerSafe(part.name);
    if (part.data) {
      const filename = headerSafe(part.filename ?? "audio.bin");
      const mimeType = headerSafe(part.mimeType || "application/octet-stream");
      chunks.push(
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
            `Content-Type: ${mimeType}\r\n\r\n`,
        ),
        part.data,
        Buffer.from("\r\n"),
      );
    } else {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
            `${part.value ?? ""}\r\n`,
        ),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

const DROPPED_SCRIBE_FIELDS: Record<string, true> = {
  keyterms: true,
  "keyterms[]": true,
};

export interface ScribeBatchRewrite {
  body: Buffer;
  contentType: string;
  droppedFields: string[];
  noVerbatim: "true" | "false";
}

/**
 * SuperWhisper's file-mode Scribe upload carries a keyterm list and a
 * no_verbatim flag. Keyterm prompting is billed separately, so it is always
 * removed. The no_verbatim flag is written explicitly: when it is absent,
 * Scribe falls back to cleanup that deletes fillers and repeated words.
 */
export function rewriteScribeBatch(
  parsed: ParsedMultipart,
  options: { verbatim: boolean },
): ScribeBatchRewrite {
  const parts: MultipartPart[] = [];
  const droppedFields: string[] = [];
  for (const name of parsed.fieldNames) {
    const lower = name.toLowerCase();
    if (DROPPED_SCRIBE_FIELDS[lower]) {
      droppedFields.push(name);
      continue;
    }
    if (lower === "no_verbatim") continue;
    parts.push({ name, value: parsed.fields[name] });
  }
  const noVerbatim = options.verbatim ? "false" : "true";
  parts.push({ name: "no_verbatim", value: noVerbatim });
  for (const file of parsed.files) {
    parts.push({
      name: file.field,
      filename: file.filename,
      mimeType: file.mimeType,
      data: file.data,
    });
  }
  return { ...buildMultipart(parts), droppedFields, noVerbatim };
}
