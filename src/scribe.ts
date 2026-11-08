import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import type { AppConfig } from "./config.js";
import { errorLabel } from "./errors.js";
import type { Logger } from "./logger.js";
import { redactQuery } from "./url-utils.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const WS_HANDSHAKE_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);

export interface ScribeDeps {
  config: AppConfig;
  logger: Logger;
}

interface ScribeFrame {
  data: WebSocket.RawData;
  isBinary: boolean;
}

function splitHostPort(value: string): { hostname: string; port: number } {
  const trimmed = value.trim();
  const index = trimmed.lastIndexOf(":");
  if (index < 0) return { hostname: trimmed, port: 443 };
  return {
    hostname: trimmed.slice(0, index),
    port: Number(trimmed.slice(index + 1)) || 443,
  };
}

function copyUpstreamHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (value === undefined || WS_HANDSHAKE_HEADERS.has(lower)) continue;
    if (HOP_BY_HOP.has(lower)) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

function rawByteLength(data: WebSocket.RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, chunk) => sum + chunk.length, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.length;
}

export interface ScribeFrameSink {
  readyState: number;
  send(data: WebSocket.RawData, options: { binary: boolean }): void;
}

export function forwardScribeFrame(
  client: ScribeFrameSink,
  data: WebSocket.RawData,
  isBinary: boolean,
): void {
  if (client.readyState !== WebSocket.OPEN) return;
  client.send(data, { binary: isBinary });
}

export function scribeWebSocket(req: IncomingMessage, client: WebSocket, deps: ScribeDeps): void {
  const { config, logger } = deps;
  const requestId = randomUUID();
  const host = splitHostPort(String(req.headers.host ?? "")).hostname;
  const url = new URL(String(req.url ?? "/"), `https://${host}`);
  const target = `wss://${host}${req.url ?? "/"}`;
  const pending: ScribeFrame[] = [];
  let upstreamOpen = false;

  const upstream = new WebSocket(target, {
    headers: copyUpstreamHeaders(req),
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
    rejectUnauthorized: true,
    servername: host,
  } as never);

  logger.info(
    {
      request_id: requestId,
      host,
      path: url.pathname,
      query: redactQuery(url),
      model: url.searchParams.get("model_id"),
      config_model: config.SCRIBE_MODEL,
      mode: "scribe",
    },
    "scribe ws upstream connecting",
  );

  client.on("message", (data, isBinary) => {
    logger.debug(
      { request_id: requestId, kind: isBinary ? "binary" : "text", bytes: rawByteLength(data) },
      "scribe ws client frame",
    );
    if (upstreamOpen) upstream.send(data, { binary: isBinary });
    else pending.push({ data, isBinary });
  });

  client.on("close", (code, reason) => {
    logger.info(
      { request_id: requestId, code, reason_bytes: reason.length },
      "scribe ws client closed",
    );
    upstream.close();
  });

  client.on("error", (err) => {
    logger.warn({ request_id: requestId, error: errorLabel(err) }, "scribe ws client error");
  });

  upstream.on("open", () => {
    upstreamOpen = true;
    logger.info({ request_id: requestId }, "scribe ws upstream open");
    for (const frame of pending) upstream.send(frame.data, { binary: frame.isBinary });
    pending.length = 0;
  });

  upstream.on("message", (data, isBinary) => {
    logger.debug(
      { request_id: requestId, kind: isBinary ? "binary" : "text", bytes: rawByteLength(data) },
      "scribe ws upstream frame",
    );
    forwardScribeFrame(client as unknown as ScribeFrameSink, data, isBinary);
  });

  upstream.on("close", (code, reason) => {
    logger.info(
      { request_id: requestId, code, reason_bytes: reason.length },
      "scribe ws upstream closed",
    );
    if (client.readyState !== WebSocket.OPEN) return;
    if (code === 1000 || code === 1005) client.close(1000);
    else client.close(1011, "scribe upstream closed");
  });

  upstream.on("error", (err) => {
    logger.warn({ request_id: requestId, error: errorLabel(err) }, "scribe ws upstream error");
    if (client.readyState === WebSocket.OPEN) client.close(1011, "scribe upstream error");
  });
}
