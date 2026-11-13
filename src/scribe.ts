import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import type { AppConfig } from "./config.js";
import type { Diagnostics } from "./diagnostics.js";
import { errorLabel } from "./errors.js";
import type { Logger } from "./logger.js";
import { redactQuery } from "./url-utils.js";
import { elevenLabsAgent } from "./warmup.js";

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
  diagnostics: Diagnostics;
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

function numericQueryParam(url: URL, key: string): number | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function requestParameters(url: URL): Array<[string, string]> {
  return [...url.searchParams].map(([name, value]) => {
    const key = name.toLowerCase().replace(/[-_]/g, "");
    const numericValue = /^\d+(?:\.\d+)?$/.test(value);
    const tokenSetting =
      numericValue &&
      (/^(?:min|max|num|numberof|total).*tokens?/.test(key) ||
        /^tokens?(?:count|limit|size)$/.test(key)) &&
      !/access|refresh|auth|bearer|session|secret|credential|apikey/.test(key);
    const audioSetting =
      numericValue && /(?:size|count|length|duration|rate|threshold|interval|ms|hz)$/.test(key);
    const audioPayload =
      key.includes("audio") &&
      (key === "audio" ||
        /base64|data|bytes|payload|content|file|json|raw|blob|binary|buffer|chunk|samples/.test(key)) &&
      !audioSetting;
    const transcriptPayload =
      key.includes("transcript") &&
      !(key.startsWith("include") && /^(?:true|false)$/i.test(value)) &&
      !(key === "transcriptformat" && /^[a-z0-9_-]+$/i.test(value));
    const sensitive =
      key.includes("key") ||
      /auth|bearer|credential|password|secret|cookie|prompt|context/.test(key) ||
      (key.includes("token") && !tokenSetting) ||
      audioPayload ||
      key === "utterance" ||
      (key.includes("text") &&
        !(key.startsWith("enable") && /^(?:true|false)$/i.test(value))) ||
      transcriptPayload;
    return [name, sensitive ? "[REDACTED]" : value];
  });
}

export interface ScribeFrameSink {
  readyState: number;
  send(data: WebSocket.RawData, options: { binary: boolean }): void;
}

export interface ScribeVadTuning {
  silenceThresholdSecs: number;
  threshold: number;
  minSpeechDurationMs: number;
  minSilenceDurationMs: number;
}

/**
 * Match Scribe's VAD endpointing to the selected Soniox endpoint profile.
 * Only rewrite VAD-mode sockets: manual and turn-prediction commits do not use
 * these parameters, and changing them there would alter unrelated semantics.
 * The single-use token and every unknown query parameter are preserved.
 */
export function applyScribeVadTuning(url: URL, tuning: ScribeVadTuning): URL {
  if (url.searchParams.get("commit_strategy") !== "vad") return new URL(url.toString());
  const next = new URL(url.toString());
  next.searchParams.set("vad_silence_threshold_secs", String(tuning.silenceThresholdSecs));
  next.searchParams.set("vad_threshold", String(tuning.threshold));
  next.searchParams.set("min_speech_duration_ms", String(tuning.minSpeechDurationMs));
  next.searchParams.set("min_silence_duration_ms", String(tuning.minSilenceDurationMs));
  return next;
}

export interface ScribePolicy {
  verbatim: boolean;
}

/**
 * Keyterm prompting is billed separately, so the proxy never forwards it.
 * `no_verbatim` is pinned instead of left to the upstream default: when the
 * field is missing, Scribe cleans fillers, false starts, and repetitions.
 */
export function applyScribePolicy(url: URL, options: ScribePolicy): URL {
  const next = new URL(url.toString());
  const keytermNames = [
    ...new Set(
      [...next.searchParams.keys()].filter((name) => /^keyterms?(\[\])?$/i.test(name)),
    ),
  ];
  for (const name of keytermNames) next.searchParams.delete(name);
  next.searchParams.set("no_verbatim", options.verbatim ? "false" : "true");
  return next;
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
  const { config, logger, diagnostics } = deps;
  const requestId = randomUUID();
  const host = splitHostPort(String(req.headers.host ?? "")).hostname;
  const url = new URL(String(req.url ?? "/"), `https://${host}`);
  const tunedUrl = config.SCRIBE_VAD_TUNING
    ? applyScribeVadTuning(url, {
        silenceThresholdSecs: config.SCRIBE_VAD_SILENCE_THRESHOLD_SECS,
        threshold: config.SCRIBE_VAD_THRESHOLD,
        minSpeechDurationMs: config.SCRIBE_MIN_SPEECH_DURATION_MS,
        minSilenceDurationMs: config.SCRIBE_MIN_SILENCE_DURATION_MS,
      })
    : new URL(url.toString());
  const upstreamUrl = applyScribePolicy(tunedUrl, { verbatim: config.SCRIBE_VERBATIM });
  const vadApplied =
    config.SCRIBE_VAD_TUNING && url.searchParams.get("commit_strategy") === "vad";
  const target = `wss://${host}${upstreamUrl.pathname}${upstreamUrl.search}`;
  const pending: ScribeFrame[] = [];
  let upstreamOpen = false;
  let lastClientFrameAt = 0;
  let clientFrames = 0;
  let binaryFrames = 0;
  let binaryBytes = 0;
  const connectStartedAt = Date.now();

  const upstream = new WebSocket(target, {
    headers: copyUpstreamHeaders(req),
    agent: elevenLabsAgent,
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
      vad_tuning: vadApplied,
      no_verbatim: upstreamUrl.searchParams.get("no_verbatim"),
      keyterms_removed: [...url.searchParams.keys()].filter((name) =>
        /^keyterms?(\[\])?$/i.test(name),
      ).length,
      vad_silence_threshold_secs: vadApplied
        ? numericQueryParam(upstreamUrl, "vad_silence_threshold_secs")
        : null,
      vad_threshold: vadApplied ? numericQueryParam(upstreamUrl, "vad_threshold") : null,
      min_speech_duration_ms: vadApplied
        ? numericQueryParam(upstreamUrl, "min_speech_duration_ms")
        : null,
      min_silence_duration_ms: vadApplied
        ? numericQueryParam(upstreamUrl, "min_silence_duration_ms")
        : null,
    },
    "scribe ws upstream connecting",
  );

  client.on("message", (data, isBinary) => {
    lastClientFrameAt = Date.now();
    clientFrames += 1;
    if (isBinary) {
      binaryFrames += 1;
      binaryBytes += rawByteLength(data);
    }
    logger.debug(
      { request_id: requestId, kind: isBinary ? "binary" : "text", bytes: rawByteLength(data) },
      "scribe ws client frame",
    );
    if (upstreamOpen) upstream.send(data, { binary: isBinary });
    else pending.push({ data, isBinary });
  });

  client.on("close", (code, reason) => {
    logger.info(
      {
        request_id: requestId,
        code,
        reason_bytes: reason.length,
        client_frames: clientFrames,
        binary_frames: binaryFrames,
        binary_bytes: binaryBytes,
        silence_before_close_ms: lastClientFrameAt ? Date.now() - lastClientFrameAt : null,
      },
      "scribe ws client closed",
    );
    upstream.close();
  });

  client.on("error", (err) => {
    logger.warn({ request_id: requestId, error: errorLabel(err) }, "scribe ws client error");
  });

  upstream.on("open", () => {
    upstreamOpen = true;
    diagnostics.recordRequestParameters("scribe", requestParameters(upstreamUrl));
    logger.info(
      { request_id: requestId, connect_ms: Date.now() - connectStartedAt },
      "scribe ws upstream open",
    );
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
