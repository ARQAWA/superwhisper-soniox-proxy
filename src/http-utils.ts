import type { IncomingMessage, ServerResponse } from "node:http";
import type { UpstreamResponse } from "./types.js";

export async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw Object.assign(new Error(`request body exceeds ${maxBytes} bytes`), { statusCode: 413 });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

export function sendUpstreamResponse(res: ServerResponse, upstream: UpstreamResponse): void {
  res.statusCode = upstream.status;
  res.statusMessage = upstream.statusMessage;
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (value === undefined) continue;
    res.setHeader(key, value);
  }
  res.setHeader("content-length", String(upstream.body.length));
  res.end(upstream.body);
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(body.length));
  res.end(body);
}

export function errorPayload(message: string, code: string): unknown {
  return { error: message, code };
}

export function upstreamErrorStatus(err: unknown): number {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (message.includes("timeout")) return 504;
  if (message.includes("exceeds") || message.includes("too large")) return 413;
  if (message.includes("unsupported") || message.includes("invalid")) return 400;
  if (message.includes("401") || message.includes("unauthorized") || message.includes("api key")) return 401;
  if (message.includes("429") || message.includes("quota") || message.includes("rate limit")) return 429;
  return 502;
}
