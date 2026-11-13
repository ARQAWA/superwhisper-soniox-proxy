import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { RealtimeResult, RealtimeSttSession, RealtimeToken } from "@soniox/node";
import type { AppConfig } from "./config.js";
import type { Diagnostics } from "./diagnostics.js";
import { errorLabel } from "./errors.js";
import { sonioxLanguagePolicy } from "./language.js";
import type { Logger } from "./logger.js";
import { SonioxService } from "./soniox.js";
import { scribeWebSocket } from "./scribe.js";
import { mergeTokensToWords, tokensToText } from "./tokens.js";
import type { ParsedFile } from "./types.js";
import { redactQuery } from "./url-utils.js";

interface WsDeps {
  config: AppConfig;
  logger: Logger;
  soniox: SonioxService;
  diagnostics: Diagnostics;
}

function splitHostPort(value: string): { hostname: string; port: number } {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return { hostname: trimmed.slice(1, end), port: Number(trimmed.slice(end + 2)) || 443 };
  }
  const idx = trimmed.lastIndexOf(":");
  if (idx === -1) return { hostname: trimmed, port: 443 };
  return { hostname: trimmed.slice(0, idx), port: Number(trimmed.slice(idx + 1)) || 443 };
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const REALTIME_CONTROL_TYPES: Record<string, true> = {
  closestream: true,
  finalize: true,
  keepalive: true,
};

function controlType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.toLowerCase();
  return REALTIME_CONTROL_TYPES[lower] === true ? lower : undefined;
}

function describeMessage(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return { type: typeof payload };
  const obj = payload as Record<string, unknown>;
  const channel = obj.channel as Record<string, unknown> | undefined;
  const alternatives = channel?.alternatives as Array<Record<string, unknown>> | undefined;
  const alt = alternatives?.[0];
  const words = alt?.words as unknown[] | undefined;
  return {
    keys: Object.keys(obj),
    type: typeof obj.type === "string" ? obj.type : undefined,
    is_final: typeof obj.is_final === "boolean" ? obj.is_final : undefined,
    speech_final: typeof obj.speech_final === "boolean" ? obj.speech_final : undefined,
    duration: typeof obj.duration === "number" ? obj.duration : undefined,
    start: typeof obj.start === "number" ? obj.start : undefined,
    transcript_length: typeof alt?.transcript === "string" ? alt.transcript.length : undefined,
    words_count: words?.length,
    alternatives_count: alternatives?.length,
    has_channel: !!channel,
  };
}

function appendWsSchema(config: AppConfig, record: Record<string, unknown>): void {
  const path = `${config.LOG_DIR}/wss-server-schema.json`;
  let records: unknown[] = [];
  try {
    const existing = JSON.parse(readFileSync(path, "utf8")) as { records?: unknown[] };
    records = existing.records ?? [];
  } catch {
    records = [];
  }
  records.push({ captured_at: new Date().toISOString(), ...record });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ records }, null, 2) + "\n", { mode: 0o600 });
}

function copyUpstreamHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (value === undefined) continue;
    if (["host", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"].includes(lower)) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

function rawByteLength(data: WebSocket.RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, chunk) => sum + chunk.length, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.length;
}

export function safeWebSocketCloseCode(code: number): number {
  if (
    (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
  ) {
    return code;
  }
  return 1011;
}

function logClientFrame(logger: Logger, requestId: string, data: WebSocket.RawData, isBinary: boolean, model: string | null): void {
  if (isBinary) {
    logger.debug({ request_id: requestId, model, kind: "binary", bytes: rawByteLength(data) }, "ws client frame");
    return;
  }
  const text = data.toString();
  const json = safeJson(text);
  logger.debug(
    {
      request_id: requestId,
      model,
      kind: "text",
      bytes: Buffer.byteLength(text),
      message_type: controlType(json?.type),
    },
    "ws client frame",
  );
}

function logServerFrame(logger: Logger, requestId: string, data: WebSocket.RawData, isBinary: boolean, model: string | null, config: AppConfig): void {
  if (isBinary) {
    logger.debug({ request_id: requestId, model, kind: "binary", bytes: rawByteLength(data) }, "ws server frame");
    return;
  }
  const text = data.toString();
  const json = safeJson(text);
  const description = json ? describeMessage(json) : { parse_error: true, bytes: Buffer.byteLength(text) };
  logger.debug({ request_id: requestId, model, kind: "text", ...description }, "ws server frame");
  if (config.CAPTURE_TEMPLATE) {
    appendWsSchema(config, { model, ...description });
  }
}

function passthroughWebSocket(req: IncomingMessage, client: WebSocket, deps: WsDeps): void {
  const { config, logger } = deps;
  const requestId = randomUUID();
  const host = splitHostPort(String(req.headers.host ?? "")).hostname;
  const url = new URL(String(req.url ?? "/"), `https://${host}`);
  const model = url.searchParams.get("model");
  const target = `wss://${host}${req.url ?? "/"}`;
  const upstream = new WebSocket(target, {
    headers: copyUpstreamHeaders(req),
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
    rejectUnauthorized: true,
    servername: host,
  } as never);

  const pending: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
  let upstreamOpen = false;

  logger.info({ request_id: requestId, host, path: url.pathname, query: redactQuery(url), model, mode: "passthrough" }, "ws upstream connecting");

  client.on("message", (data, isBinary) => {
    logClientFrame(logger, requestId, data, isBinary, model);
    if (upstreamOpen) upstream.send(data, { binary: isBinary });
    else pending.push({ data, isBinary });
  });
  client.on("close", (code, reason) => {
    logger.info({ request_id: requestId, code, reason_bytes: reason.length, model }, "ws client closed");
    upstream.close();
  });
  client.on("error", (err) => logger.warn({ request_id: requestId, error: errorLabel(err) }, "ws client error"));

  upstream.on("open", () => {
    upstreamOpen = true;
    logger.info({ request_id: requestId, model }, "ws upstream open");
    for (const item of pending) upstream.send(item.data, { binary: item.isBinary });
    pending.length = 0;
  });
  upstream.on("message", (data, isBinary) => {
    logServerFrame(logger, requestId, data, isBinary, model, config);
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("close", (code, reason) => {
    logger.info({ request_id: requestId, code, reason_bytes: reason.length, model }, "ws upstream closed");
    if (client.readyState === WebSocket.OPEN) client.close(safeWebSocketCloseCode(code), reason);
  });
  upstream.on("error", (err) => {
    logger.warn({ request_id: requestId, error: errorLabel(err), model }, "ws upstream error");
    if (client.readyState === WebSocket.OPEN) client.close(1011, "upstream error");
  });
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return data;
}

function realtimeMetadata(requestId: string, model: string, duration: number, channels: number): Record<string, unknown> {
  return {
    transaction_key: "",
    request_id: requestId,
    sha256: "",
    created: new Date().toISOString(),
    duration,
    channels,
    models: [model],
    model_info: {
      "a23df42c-f390-4a31-90b9-c73ec96cf274": { name: model, version: "", arch: "" },
    },
  };
}

function buildResultsPayload(options: {
  tokens: RealtimeToken[];
  start: number;
  duration: number;
  isFinal: boolean;
  speechFinal: boolean;
  requestId: string;
  model: string;
  channels: number;
}): string {
  const words = mergeTokensToWords(options.tokens);
  const text = words.map((word) => word.punctuated_word).join(" ").trim();
  const confidence = words.length
    ? words.reduce((sum, word) => sum + word.confidence, 0) / words.length
    : 1;
  return JSON.stringify({
    type: "Results",
    channel_index: [0, 1],
    duration: options.duration,
    start: options.start,
    is_final: options.isFinal,
    speech_final: options.speechFinal,
    channel: {
      alternatives: [
        {
          transcript: text,
          confidence,
          words,
        },
      ],
    },
    metadata: realtimeMetadata(options.requestId, options.model, options.duration, options.channels),
    from_finalize: false,
  });
}

function sonioxWebSocket(req: IncomingMessage, client: WebSocket, deps: WsDeps): void {
  const { config, logger, soniox } = deps;
  const requestId = randomUUID();
  const host = splitHostPort(String(req.headers.host ?? "")).hostname;
  const url = new URL(String(req.url ?? "/"), `https://${host}`);
  const model = url.searchParams.get("model") ?? config.TARGET_MODEL;
  const sampleRate = Number(url.searchParams.get("sample_rate") ?? 16000);
  const channels = Number(url.searchParams.get("channels") ?? 1);
  const language = (url.searchParams.get("language") ?? "auto").toLowerCase();
  const languagePolicy = sonioxLanguagePolicy(language, config.SONIOX_AUTO_LANGUAGE);
  const languageHints = languagePolicy.hints;
  const identifyLanguage = languagePolicy.identify;
  const diarize = url.searchParams.get("diarize") === "true";
  const actualSampleRate = Number.isFinite(sampleRate) ? sampleRate : 16000;
  const actualChannels = Number.isFinite(channels) ? channels : 1;
  const endpointDetection = config.SONIOX_ENDPOINT_DETECTION && !diarize;

  const diag = deps.diagnostics.startRealtime(requestId, {
    model: config.TARGET_MODEL,
    queryModel: model,
    sampleRate: actualSampleRate,
    channels: actualChannels,
    language,
    identifyLanguage,
    diarize,
    endpointDetection,
    sonioxModel: config.SONIOX_REALTIME_MODEL,
    closeDelayMs: config.WS_CLOSE_DELAY_MS,
  });
  let session: RealtimeSttSession | null = null;
  let sessionReady = false;
  let sessionBaseMs = 0;
  let sessionProcessedMs = 0;
  let sessionGeneration = 0;
  let sessionConnectStartedAt = Date.now();
  let reconnectCount = 0;
  let reconnecting = false;
  let reconnectLimitHit = false;
  let openingFinalSent = false;
  let diagConnected = false;
  let lagSince: number | null = null;
  let terminalStatus: string | null = null;

  const bytesPerMs = (actualSampleRate * actualChannels * 2) / 1000;
  const audioChunks: Array<{ startMs: number; data: Buffer }> = [];
  let audioBytes = 0;
  let audioBufferComplete = true;
  let audioBufferLimitLogged = false;
  let recoveryUnavailable = false;
  const MAX_AUDIO_BUFFER_BYTES = 64 * 1024 * 1024;

  let prefixTokens: RealtimeToken[] = [];
  let prefixMs = 0;
  let prefixBatchPending = false;
  let prefixBatchFailed = false;
  let finalTokens: RealtimeToken[] = [];
  const finalTokenKeys = new Set<string>();
  let tailTokens: RealtimeToken[] = [];
  let closing = false;
  let clientClosing = false;
  let completed = false;
  let closeTimer: NodeJS.Timeout | null = null;
  let closeDeadlineTimer: NodeJS.Timeout | undefined;
  let lagTimer: NodeJS.Timeout | undefined;
  let keepaliveTimer: NodeJS.Timeout | undefined;
  let lastAudioAt = Date.now();
  let recoveryTimer: NodeJS.Timeout | undefined;
  let recoveryHoldTimer: NodeJS.Timeout | undefined;
  let recoveryStarted = false;
  let recoveryFinalReady = false;
  let closeStreamSeen = false;
  let lastTextLength = 0;
  let maxInterimLength = 0;
  let lastSendOk = false;

  const audioEndMs = (): number => audioBytes / bytesPerMs;
  const processedMs = (): number => sessionBaseMs + sessionProcessedMs;
  const allTokens = (): RealtimeToken[] => [...prefixTokens, ...finalTokens, ...tailTokens];

  const appendAudio = (buf: Buffer): void => {
    if (audioBytes + buf.length <= MAX_AUDIO_BUFFER_BYTES) {
      audioChunks.push({ startMs: audioBytes / bytesPerMs, data: Buffer.from(buf) });
    } else {
      audioBufferComplete = false;
      recoveryUnavailable = true;
      if (!audioBufferLimitLogged) {
        audioBufferLimitLogged = true;
        diag.anomaly(
          "audio_buffer_limit",
          { audio_ms: Math.round(audioBytes / bytesPerMs), limit_bytes: MAX_AUDIO_BUFFER_BYTES },
          "warn",
        );
      }
    }
    audioBytes += buf.length;
  };

  const audioSlice = (startMs: number, endMs: number = Number.POSITIVE_INFINITY): Buffer => {
    const startByte = Math.max(0, Math.floor(startMs * bytesPerMs));
    const endByte = Math.min(audioBytes, Math.floor(endMs * bytesPerMs));
    if (endByte <= startByte) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    let offset = 0;
    for (const chunk of audioChunks) {
      const chunkStart = offset;
      const chunkEnd = offset + chunk.data.length;
      const from = Math.max(startByte, chunkStart);
      const to = Math.min(endByte, chunkEnd);
      if (to > from) parts.push(chunk.data.subarray(from - chunkStart, to - chunkStart));
      offset = chunkEnd;
      if (offset >= endByte) break;
    }
    return Buffer.concat(parts);
  };


  const tokenKey = (token: RealtimeToken): string =>
    `${token.start_ms ?? "?"}:${token.end_ms ?? "?"}:${token.text}`;

  const sendTokens = (tokens: RealtimeToken[], isFinal: boolean, speechFinal: boolean): number => {
    lastSendOk = false;
    if (client.readyState !== WebSocket.OPEN) return 0;
    if (tokens.length === 0) return 0;
    const starts = tokens.map((t) => t.start_ms).filter((v): v is number => typeof v === "number");
    const ends = tokens.map((t) => t.end_ms).filter((v): v is number => typeof v === "number");
    const start = starts.length ? Math.min(...starts) / 1000 : 0;
    const end = ends.length ? Math.max(...ends) / 1000 : start;
    const payload = buildResultsPayload({
      tokens,
      start,
      duration: Math.max(0, end - start),
      isFinal,
      speechFinal,
      requestId,
      model: config.TARGET_MODEL,
      channels,
    });
    const textLength = tokensToText(tokens).length;
    try {
      client.send(payload);
      lastSendOk = true;
    } catch (err) {
      diag.anomaly(
        "client_send_failed",
        {
          is_final: isFinal,
          tokens: tokens.length,
          error: errorLabel(err),
        },
        "error",
      );
      return 0;
    }
    if (textLength > 0) lastTextLength = textLength;
    logger.debug(
      {
        request_id: requestId,
        is_final: isFinal,
        speech_final: speechFinal,
        tokens: tokens.length,
        text_length: textLength,
      },
      "ws server results",
    );
    return textLength;
  };

  const sendInterim = (): number => {
    if (closing) return 0;
    const textLength = sendTokens(allTokens(), false, false);
    if (textLength > maxInterimLength) maxInterimLength = textLength;
    diag.interimSent(textLength);
    return textLength;
  };

  const sendEmptyInterim = (): void => {
    if (completed || clientClosing || client.readyState !== WebSocket.OPEN) return;
    try {
      client.send(
        buildResultsPayload({
          tokens: [],
          start: 0,
          duration: 0,
          isFinal: false,
          speechFinal: false,
          requestId,
          model: config.TARGET_MODEL,
          channels,
        }),
      );
    } catch {
      // best effort while holding the app open for batch recovery
    }
  };

  // Soniox slides its token window: once a prefix is finalized, later results
  // contain only newer tokens. Accumulate the finalized prefix or the app loses
  // everything before the last pause.
  const absorbResult = (tokens: RealtimeToken[]): number => {
    const before = finalTokens.length;
    const adjust = (token: RealtimeToken): RealtimeToken =>
      sessionBaseMs === 0
        ? token
        : {
            ...token,
            start_ms:
              typeof token.start_ms === "number" ? token.start_ms + sessionBaseMs : token.start_ms,
            end_ms: typeof token.end_ms === "number" ? token.end_ms + sessionBaseMs : token.end_ms,
          };
    let index = 0;
    while (index < tokens.length && tokens[index].is_final) {
      const token = adjust(tokens[index]);
      const key = tokenKey(token);
      if (!finalTokenKeys.has(key)) {
        finalTokenKeys.add(key);
        finalTokens.push(token);
      }
      index += 1;
    }
    tailTokens = tokens.slice(index).map(adjust);
    return finalTokens.length - before;
  };

  const sendMetadata = (): void => {
    if (client.readyState !== WebSocket.OPEN) return;
    client.send(
      JSON.stringify({
        type: "Metadata",
        ...realtimeMetadata(requestId, config.TARGET_MODEL, processedMs() / 1000, channels),
      }),
    );
  };

  const closeClient = (): void => {
    if (clientClosing) return;
    clientClosing = true;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    // Give the app time to render the final text before the socket disappears.
    closeTimer = setTimeout(() => {
      if (client.readyState === WebSocket.OPEN) client.close(1000, "finished");
    }, config.WS_CLOSE_DELAY_MS);
    closeTimer.unref?.();
  };

  const completeStream = (): void => {
    if (completed) return;
    if (recoveryStarted && !recoveryFinalReady) {
      diag.event("final_ignored_during_recovery", {
        final_tokens: prefixTokens.length + finalTokens.length,
        tail_tokens: tailTokens.length,
      });
      return;
    }
    if (!audioBufferComplete) {
      diag.anomaly(
        "final_suppressed_incomplete_buffer",
        {
          audio_ms: Math.round(audioEndMs()),
          processed_ms: Math.round(processedMs()),
        },
        "error",
      );
      errorClient("audio buffer incomplete");
      return;
    }
    if (prefixBatchPending || prefixBatchFailed) {
      diag.prefixMissingAtFinal();
      if (closing) {
        startBatchRecovery(
          prefixBatchFailed ? "prefix batch failed at final" : "prefix batch missing at final",
        );
      } else {
        diag.event("final_deferred_prefix_pending", {
          prefix_pending: prefixBatchPending,
          prefix_failed: prefixBatchFailed,
        });
      }
      return;
    }
    completed = true;
    clearTimeout(closeDeadlineTimer);
    clearTimeout(recoveryTimer);
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = undefined;
    }
    if (recoveryHoldTimer) clearInterval(recoveryHoldTimer);
    if (lagTimer) clearInterval(lagTimer);
    const tokens = allTokens();
    const clientOpen = client.readyState === WebSocket.OPEN;
    let finalTextLength = 0;
    let delivered = false;
    if (tokens.length > 0) {
      finalTextLength = sendTokens(tokens, true, true);
      delivered = lastSendOk;
    } else if (clientOpen) {
      // Keep Deepgram's shape even for a silent stream.
      try {
        client.send(
          buildResultsPayload({
            tokens: [],
            start: 0,
            duration: processedMs() / 1000,
            isFinal: true,
            speechFinal: true,
            requestId,
            model: config.TARGET_MODEL,
            channels,
          }),
        );
        delivered = true;
      } catch {
        delivered = false;
      }
    }
    logger.info(
      {
        request_id: requestId,
        final_tokens: prefixTokens.length + finalTokens.length,
        tail_tokens: tailTokens.length,
        final_text_length: finalTextLength,
        max_interim_length: maxInterimLength,
        delivered,
      },
      "soniox realtime final response",
    );
    diag.finalSent({
      finalTextLength,
      finalTokens: finalTokens.length,
      tailTokens: tailTokens.length,
      maxInterimLength,
      clientOpen,
      delivered,
      safetyNet: false,
      empty: tokens.length === 0,
    });
    sendMetadata();
    closeClient();
  };

  const startPrefixBatch = (prefixBuffer: Buffer, connectMs: number): void => {
    const pendingMs = Math.round(prefixBuffer.length / bytesPerMs);
    prefixMs = pendingMs;
    sessionBaseMs = pendingMs;
    prefixBatchPending = true;
    prefixBatchFailed = false;
    diag.prefixBatchStarted({ connectMs, prefixMs: pendingMs, bytes: prefixBuffer.length });
    const prefixFile: ParsedFile = {
      field: "audio",
      filename: `prefix-${requestId}.pcm`,
      mimeType: "audio/pcm",
      size: prefixBuffer.length,
      data: prefixBuffer,
    };
    const prefixFields = {
      encoding: "linear16",
      sample_rate: String(actualSampleRate),
      channels: String(actualChannels),
      language,
    };
    const prefixStarted = Date.now();
    void soniox
      .transcribe(prefixFile, prefixFields, requestId, false, "realtime_prefix")
      .then((result) => {
        prefixTokens = result.tokens.map((token) => ({
          text: token.text,
          start_ms: token.start_ms,
          end_ms: token.end_ms,
          confidence: token.confidence,
          is_final: true,
          ...(token.speaker ? { speaker: token.speaker } : {}),
          ...(token.language ? { language: token.language } : {}),
        }));
        prefixBatchPending = false;
        diag.prefixBatchReady({
          tokens: prefixTokens.length,
          textLength: result.text.length,
          latencyMs: Date.now() - prefixStarted,
        });
        if (completed) {
          diag.anomaly("prefix_arrived_after_final", {
            prefix_ms: prefixMs,
            prefix_tokens: prefixTokens.length,
          });
        } else {
          sendInterim();
        }
      })
      .catch((err: Error) => {
        prefixBatchPending = false;
        prefixBatchFailed = true;
        diag.prefixBatchFailed(errorLabel(err));
        logger.warn({ request_id: requestId, error: errorLabel(err) }, "prefix batch failed");
        if (!completed) sendInterim();
      });
  };

  const errorClient = (reason: string, options: { clearInterim?: boolean } = {}): void => {
    if (clientClosing) return;
    clientClosing = true;
    completed = true;
    terminalStatus = "error";
    clearTimeout(closeDeadlineTimer);
    clearTimeout(recoveryTimer);
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = undefined;
    }
    if (recoveryHoldTimer) clearInterval(recoveryHoldTimer);
    if (lagTimer) clearInterval(lagTimer);
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    diag.anomaly(
      "realtime_error_close",
      {
        reason,
        audio_ms: Math.round(audioEndMs()),
        processed_ms: Math.round(processedMs()),
        close_stream: closeStreamSeen,
        final_tokens: prefixTokens.length + finalTokens.length,
        tail_tokens: tailTokens.length,
      },
      "error",
    );
    logger.error(
      {
        request_id: requestId,
        reason,
        audio_ms: Math.round(audioEndMs()),
        processed_ms: Math.round(processedMs()),
      },
      "soniox realtime error close",
    );
    if (client.readyState === WebSocket.OPEN) {
      // The app may keep the last interim in its live text. Clear it before the
      // error close so a failure cannot leave a truncated preview behind.
      if (options.clearInterim !== false) {
        try {
          client.send(
            buildResultsPayload({
              tokens: [],
              start: 0,
              duration: 0,
              isFinal: false,
              speechFinal: false,
              requestId,
              model: config.TARGET_MODEL,
              channels,
            }),
          );
        } catch {
          // best effort
        }
      }
      client.close(1011, "soniox incomplete");
    }
  };

  const finishWithBatch = (tokens: RealtimeToken[]): void => {
    if (completed || clientClosing) return;
    recoveryFinalReady = true;
    prefixTokens = [];
    finalTokens = tokens;
    tailTokens = [];
    prefixBatchPending = false;
    prefixBatchFailed = false;
    sessionBaseMs = 0;
    sessionProcessedMs = Math.round(audioEndMs());
    completeStream();
  };

  const startBatchRecovery = (reason: string): void => {
    if (recoveryStarted || completed || clientClosing) return;
    if (!audioBufferComplete) {
      diag.anomaly(
        "batch_recovery_unavailable",
        {
          reason,
          audio_ms: Math.round(audioEndMs()),
          processed_ms: Math.round(processedMs()),
        },
        "error",
      );
      errorClient("audio buffer incomplete");
      return;
    }
    recoveryStarted = true;
    diag.anomaly(
      "batch_recovery_started",
      {
        reason,
        audio_ms: Math.round(audioEndMs()),
        processed_ms: Math.round(processedMs()),
        close_stream: closeStreamSeen,
      },
      "warn",
    );
    logger.warn(
      {
        request_id: requestId,
        reason,
        audio_ms: Math.round(audioEndMs()),
        processed_ms: Math.round(processedMs()),
      },
      "soniox batch recovery started",
    );
    // Keep the app waiting while the full recording is transcribed. Empty
    // interims reset its idle timer without exposing a truncated transcript.
    sendEmptyInterim();
    recoveryHoldTimer = setInterval(sendEmptyInterim, 500);
    recoveryHoldTimer.unref?.();
    recoveryTimer = setTimeout(() => {
      if (!completed) errorClient("batch recovery timeout");
    }, config.SONIOX_CLOSE_RECOVERY_MS);
    recoveryTimer.unref?.();

    const audio = audioSlice(0, audioEndMs());
    if (audio.length === 0) {
      errorClient("no audio for batch recovery");
      return;
    }
    const file: ParsedFile = {
      field: "audio",
      filename: `recovery-${requestId}.pcm`,
      mimeType: "audio/pcm",
      size: audio.length,
      data: audio,
    };
    const fields = {
      encoding: "linear16",
      sample_rate: String(actualSampleRate),
      channels: String(actualChannels),
      language,
    };
    const started = Date.now();
    void soniox
      .transcribe(file, fields, requestId, false, "realtime_recovery")
      .then((result) => {
        if (completed || clientClosing) return;
        const tokens: RealtimeToken[] = result.tokens.map((token) => ({
          text: token.text,
          start_ms: token.start_ms,
          end_ms: token.end_ms,
          confidence: token.confidence,
          is_final: true,
          ...(token.speaker ? { speaker: token.speaker } : {}),
          ...(token.language ? { language: token.language } : {}),
        }));
        diag.event("batch_recovery_ready", {
          latency_ms: Date.now() - started,
          tokens: tokens.length,
          text_length: result.text.length,
          audio_ms: Math.round(audioEndMs()),
        });
        finishWithBatch(tokens);
      })
      .catch((err: Error) => {
        diag.anomaly("batch_recovery_failed", { error: errorLabel(err) }, "error");
        logger.error({ request_id: requestId, error: errorLabel(err) }, "soniox batch recovery failed");
        if (!completed && !clientClosing) errorClient("batch recovery failed");
      });
  };

  const reconnect = (reason: string): void => {
    if (reconnecting || clientClosing || completed || closing) return;
    if (!audioBufferComplete) {
      recoveryUnavailable = true;
      diag.anomaly(
        "reconnect_skipped_incomplete_buffer",
        {
          reason,
          audio_ms: Math.round(audioEndMs()),
          processed_ms: Math.round(processedMs()),
        },
        "warn",
      );
      return;
    }
    if (reconnectCount >= config.SONIOX_RECONNECT_MAX) {
      diag.anomaly(
        "reconnect_limit",
        {
          attempt: reconnectCount,
          reason,
          audio_ms: Math.round(audioEndMs()),
          processed_ms: Math.round(processedMs()),
        },
        "warn",
      );
      reconnecting = false;
      reconnectLimitHit = true;
      return;
    }
    reconnecting = true;
    reconnectCount += 1;

    let lastFinalEndMs = prefixMs;
    let hasUnknownFinalEnd = false;
    for (const token of finalTokens) {
      if (typeof token.end_ms !== "number") {
        hasUnknownFinalEnd = true;
        break;
      }
      lastFinalEndMs = Math.max(lastFinalEndMs, token.end_ms);
    }
    let resumeMs = hasUnknownFinalEnd
      ? prefixMs
      : Math.max(prefixMs, lastFinalEndMs - config.SONIOX_RECONNECT_OVERLAP_MS);
    if (!hasUnknownFinalEnd) {
      for (let pass = 0; pass <= finalTokens.length; pass += 1) {
        const hasUnknownCrossingStart = finalTokens.some(
          (token) =>
            typeof token.end_ms === "number" &&
            typeof token.start_ms !== "number" &&
            token.end_ms > resumeMs,
        );
        if (hasUnknownCrossingStart) {
          resumeMs = prefixMs;
          break;
        }
        const crossingStarts = finalTokens
          .filter(
            (token) =>
              typeof token.start_ms === "number" &&
              typeof token.end_ms === "number" &&
              token.start_ms < resumeMs &&
              token.end_ms > resumeMs,
          )
          .map((token) => token.start_ms as number);
        if (crossingStarts.length === 0) break;
        const nextResumeMs = Math.max(prefixMs, Math.min(...crossingStarts));
        if (nextResumeMs >= resumeMs) break;
        resumeMs = nextResumeMs;
      }
    }
    resumeMs = Math.min(audioEndMs(), resumeMs);

    diag.anomaly(
      "reconnect",
      {
        reason,
        attempt: reconnectCount,
        resume_ms: Math.round(resumeMs),
        last_final_ms: Math.round(lastFinalEndMs),
        processed_ms: Math.round(processedMs()),
        audio_ms: Math.round(audioEndMs()),
      },
      "warn",
    );
    logger.warn(
      {
        request_id: requestId,
        reason,
        attempt: reconnectCount,
        resume_ms: Math.round(resumeMs),
        last_final_ms: Math.round(lastFinalEndMs),
        processed_ms: Math.round(processedMs()),
        audio_ms: Math.round(audioEndMs()),
      },
      "soniox realtime reconnect",
    );
    finalTokens = finalTokens.filter(
      (token) => typeof token.end_ms === "number" && token.end_ms <= resumeMs,
    );
    finalTokenKeys.clear();
    for (const token of finalTokens) finalTokenKeys.add(tokenKey(token));
    tailTokens = [];
    const old = session;
    session = null;
    sessionReady = false;
    try {
      old?.close();
    } catch {
      // already closed
    }
    lagSince = null;
    openSession(resumeMs, !diagConnected);
  };

  const handleSessionFailure = (error: unknown, generation: number): void => {
    if (generation !== sessionGeneration) return;
    const label = errorLabel(error);
    diag.anomaly(
      "soniox_session_error",
      { error: label, reconnect_count: reconnectCount },
      "warn",
    );
    logger.error({ request_id: requestId, error: label }, "soniox realtime error");
    if (clientClosing || completed || closing) return;
    if (reconnectCount < config.SONIOX_RECONNECT_MAX) {
      reconnect("session_error");
      return;
    }
    // Keep accepting and buffering app audio. At CloseStream this path becomes
    // a full batch recovery instead of losing the rest of the dictation.
    diag.anomaly(
      "reconnect_exhausted",
      {
        error: label,
        reconnect_count: reconnectCount,
        audio_ms: Math.round(audioEndMs()),
        processed_ms: Math.round(processedMs()),
      },
      "warn",
    );
    sessionReady = false;
    reconnectLimitHit = true;
  };

  function attachSession(target: RealtimeSttSession, generation: number, first: boolean): void {
    target.on("connected", () => {
      if (generation !== sessionGeneration) return;
      reconnecting = false;
      reconnectLimitHit = false;
      lagSince = null;
      const connectMs = Date.now() - sessionConnectStartedAt;
      const currentAudioMs = audioEndMs();
      diag.event("session_connected", {
        first,
        connect_ms: connectMs,
        audio_ms: Math.round(currentAudioMs),
        base_ms: Math.round(sessionBaseMs),
      });
      logger.info(
        {
          request_id: requestId,
          model: config.TARGET_MODEL,
          query_model: model,
          sample_rate: sampleRate,
          channels,
          language,
          connect_ms: connectMs,
          reconnect: !first,
        },
        "soniox realtime connected",
      );
      if (!audioBufferComplete) {
        diag.anomaly(
          "connect_with_incomplete_buffer",
          {
            audio_ms: Math.round(audioEndMs()),
            limit_bytes: MAX_AUDIO_BUFFER_BYTES,
          },
          "error",
        );
        errorClient("audio buffer incomplete", { clearInterim: maxInterimLength > 0 });
        return;
      }
      if (recoveryStarted) {
        diag.event("connected_during_recovery", {
          first,
          connect_ms: connectMs,
          audio_ms: Math.round(currentAudioMs),
        });
        return;
      }
      if (!diagConnected) {
        diag.connected(connectMs);
        diagConnected = true;
      }
      if (!openingFinalSent && client.readyState === WebSocket.OPEN) {
        // Match Deepgram's opening empty final segment.
        client.send(
          buildResultsPayload({
            tokens: [],
            start: 0,
            duration: 0,
            isFinal: true,
            speechFinal: true,
            requestId,
            model: config.TARGET_MODEL,
            channels,
          }),
        );
        openingFinalSent = true;
      }
      if (first) {
        const pendingBuffer = audioSlice(0, currentAudioMs);
        const pendingMs = Math.round(pendingBuffer.length / bytesPerMs);
        if (
          config.SONIOX_PREFIX_BATCH_CONNECT_MS > 0 &&
          connectMs >= config.SONIOX_PREFIX_BATCH_CONNECT_MS &&
          pendingMs >= 300 &&
          pendingBuffer.length > 0
        ) {
          // A slow Soniox handshake leaves seconds of queued audio. Sending that
          // burst to realtime puts the server permanently behind live audio, and
          // the app closes before the tail is finalized. Recover the queued prefix
          // with async transcription, keep realtime on the live edge.
          sessionReady = true;
          startPrefixBatch(pendingBuffer, connectMs);
          return;
        }
        sessionBaseMs = 0;
        sessionProcessedMs = 0;
        if (pendingBuffer.length > 0) target.sendAudio(new Uint8Array(pendingBuffer));
        sessionReady = true;
        return;
      }
      const backlog = audioSlice(sessionBaseMs, currentAudioMs);
      if (backlog.length > 0) target.sendAudio(new Uint8Array(backlog));
      sessionReady = true;
    });

    target.on("result", (result: RealtimeResult) => {
      if (generation !== sessionGeneration) return;
      sessionProcessedMs = result.total_audio_proc_ms;
      if (result.tokens.length > 0) {
        const newFinalTokens = absorbResult(result.tokens);
        sendInterim();
        const starts = result.tokens
          .map((token) => token.start_ms)
          .filter((value): value is number => typeof value === "number");
        const ends = result.tokens
          .map((token) => token.end_ms)
          .filter((value): value is number => typeof value === "number");
        diag.result({
          tokens: result.tokens.length,
          finalTokens: prefixTokens.length + finalTokens.length,
          tailTokens: tailTokens.length,
          newFinalTokens,
          totalAudioProcMs: processedMs(),
          finalAudioProcMs: sessionBaseMs + result.final_audio_proc_ms,
          windowStartMs: starts.length ? Math.min(...starts) + sessionBaseMs : null,
          windowEndMs: ends.length ? Math.max(...ends) + sessionBaseMs : null,
          finished: result.finished === true,
          textLength: lastTextLength,
        });
      }
    });

    target.on("endpoint", () => {
      if (generation !== sessionGeneration) return;
      diag.endpoint();
      logger.debug(
        { request_id: requestId, final_tokens: finalTokens.length, tail_tokens: tailTokens.length },
        "soniox realtime endpoint",
      );
      sendInterim();
    });

    target.on("finalized", () => {
      if (generation !== sessionGeneration) return;
      diag.finalized(finalTokens.length, tailTokens.length);
      logger.debug(
        { request_id: requestId, final_tokens: finalTokens.length, tail_tokens: tailTokens.length },
        "soniox realtime finalized",
      );
      sendInterim();
    });

    target.on("finished", () => {
      if (generation !== sessionGeneration) return;
      diag.finished({
        finalTokens: prefixTokens.length + finalTokens.length,
        tailTokens: tailTokens.length,
        totalAudioProcMs: processedMs(),
      });
      logger.info(
        {
          request_id: requestId,
          final_tokens: prefixTokens.length + finalTokens.length,
          tail_tokens: tailTokens.length,
          total_ms: processedMs(),
        },
        "soniox realtime finished",
      );
      completeStream();
    });

    target.on("error", (err: Error) => {
      handleSessionFailure(err, generation);
    });
  }

  function openSession(baseMs: number, first: boolean): void {
    sessionGeneration += 1;
    const generation = sessionGeneration;
    sessionBaseMs = baseMs;
    sessionProcessedMs = 0;
    sessionReady = false;
    reconnecting = false;
    sessionConnectStartedAt = Date.now();
    const target = soniox.createRealtimeSession({
      languageHints,
      identifyLanguage,
      sampleRate: actualSampleRate,
      channels: actualChannels,
      diarize,
      endpointDetection,
      endpointSensitivity: config.SONIOX_ENDPOINT_SENSITIVITY,
      endpointLatencyAdjustmentLevel: config.SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL,
      maxEndpointDelayMs: config.SONIOX_MAX_ENDPOINT_DELAY_MS,
      clientReferenceId: `sw-rt-${requestId}`,
    });
    session = target;
    attachSession(target, generation, first);
    void target.connect().catch((err: Error) => {
      if (generation !== sessionGeneration) return;
      handleSessionFailure(err, generation);
    });
  }

  openSession(0, true);

  if (config.SONIOX_KEEPALIVE_MS > 0) {
    const checkMs = Math.min(config.SONIOX_KEEPALIVE_MS, 1000);
    keepaliveTimer = setInterval(() => {
      if (
        !sessionReady ||
        !session ||
        reconnecting ||
        reconnectLimitHit ||
        recoveryStarted ||
        closing ||
        completed ||
        clientClosing
      ) {
        return;
      }
      const idleMs = Date.now() - lastAudioAt;
      if (idleMs < config.SONIOX_KEEPALIVE_MS) return;
      try {
        session.keepAlive();
        lastAudioAt = Date.now();
        diag.event("keepalive_sent", { idle_ms: idleMs });
        logger.debug({ request_id: requestId, idle_ms: idleMs }, "soniox realtime keepalive");
      } catch (err) {
        diag.event("keepalive_failed", { error: errorLabel(err) });
      }
    }, checkMs);
    keepaliveTimer.unref?.();
  }

  lagTimer = setInterval(() => {
    if (!sessionReady || reconnecting || reconnectLimitHit || recoveryUnavailable || closing || completed || clientClosing) return;
    const lag = audioEndMs() - processedMs();
    if (lag > config.SONIOX_RECONNECT_LAG_MS) {
      if (lagSince === null) lagSince = Date.now();
      else if (Date.now() - lagSince >= 1500) {
        lagSince = null;
        reconnect("lag");
      }
    } else {
      lagSince = null;
    }
  }, 1000);
  lagTimer.unref?.();

  client.on("message", (data, isBinary) => {
    logClientFrame(logger, requestId, data, isBinary, model);
    if (isBinary) {
      lastAudioAt = Date.now();
      diag.audioFrame(rawByteLength(data));
      const buf = toBuffer(data);
      appendAudio(buf);
      if (sessionReady && session) {
        try {
          session.sendAudio(new Uint8Array(buf));
        } catch (err) {
          diag.event("send_audio_failed", {
            error: errorLabel(err),
          });
        }
      }
      return;
    }
    const json = safeJson(data.toString());
    const type = typeof json?.type === "string" ? json.type : "";
    if (/^closestream$/i.test(type)) {
      closeStreamSeen = true;
      closing = true;
      const closeTextLength = tokensToText(allTokens()).length;
      const lag = Math.round(audioEndMs() - processedMs());
      diag.closeStream({
        finalTokens: prefixTokens.length + finalTokens.length,
        tailTokens: tailTokens.length,
        textLength: closeTextLength,
      });
      logger.info(
        {
          request_id: requestId,
          final_tokens: prefixTokens.length + finalTokens.length,
          tail_tokens: tailTokens.length,
          close_text_length: closeTextLength,
          lag_ms: lag,
          session_ready: sessionReady,
          reconnecting,
        },
        "soniox realtime CloseStream",
      );
      diag.finishRequested();
      if (prefixBatchPending || prefixBatchFailed) {
        diag.anomaly(
          "close_stream_prefix_incomplete",
          {
            prefix_pending: prefixBatchPending,
            prefix_failed: prefixBatchFailed,
            close_text_length: closeTextLength,
          },
          "warn",
        );
        startBatchRecovery("prefix incomplete at close");
        return;
      }
      if (!session || !sessionReady || reconnecting || lag > config.SONIOX_CLOSE_ERROR_LAG_MS) {
        diag.anomaly(
          "close_stream_incomplete",
          {
            lag_ms: lag,
            session_ready: sessionReady,
            reconnecting,
            close_text_length: closeTextLength,
          },
          "warn",
        );
        startBatchRecovery("lag at close");
        return;
      }
      void session.finish().catch((err: Error) => {
        diag.finishFailed(errorLabel(err));
        if (!clientClosing) {
          logger.warn({ request_id: requestId, error: errorLabel(err) }, "soniox finish failed");
          startBatchRecovery("finish failed");
        }
      });
      // Do not wait past the app's patience for a partial final. Start a full
      // batch recovery and hold the socket open with empty interims instead.
      closeDeadlineTimer = setTimeout(() => {
        if (!completed) {
          diag.anomaly(
            "finalize_wait_exceeded",
            {
              wait_ms: config.SONIOX_CLOSE_BATCH_DELAY_MS,
              close_text_length: closeTextLength,
              final_tokens: finalTokens.length,
              tail_tokens: tailTokens.length,
            },
            "warn",
          );
          startBatchRecovery("final timeout");
        }
      }, config.SONIOX_CLOSE_BATCH_DELAY_MS);
      closeDeadlineTimer.unref?.();
    } else if (/^finalize$/i.test(type)) {
      diag.clientControl("Finalize");
      try {
        session?.finalize();
      } catch (err) {
        diag.event("finalize_failed", {
          error: errorLabel(err),
        });
      }
    } else if (/^keepalive$/i.test(type)) {
      diag.clientControl("KeepAlive");
      try {
        session?.keepAlive();
      } catch {
        // session may be reconnecting
      }
    } else {
      diag.clientControl(controlType(type) ?? "unknown");
    }
  });

  client.on("close", (code, reason) => {
    clientClosing = true;
    if (recoveryStarted && !recoveryFinalReady) {
      diag.anomaly(
        "client_closed_during_recovery",
        {
          code,
          audio_ms: Math.round(audioEndMs()),
          processed_ms: Math.round(processedMs()),
          reason_length: Buffer.byteLength(reason),
        },
        "error",
      );
      terminalStatus ??= "error";
    }
    const lostTextLength =
      terminalStatus === "error" && !lastSendOk
        ? tokensToText(allTokens()).length
        : closeStreamSeen && !(completed && lastSendOk)
          ? tokensToText(allTokens()).length
          : null;
    diag.clientClosed({
      code,
      reasonLength: Buffer.byteLength(reason),
      lostTextLength,
      finalTokens: prefixTokens.length + finalTokens.length,
      tailTokens: tailTokens.length,
    });
    diag.end(terminalStatus ?? undefined);
    logger.info({ request_id: requestId, code, reason_bytes: reason.length }, "ws soniox client closed");
    clearTimeout(closeDeadlineTimer);
    clearTimeout(recoveryTimer);
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = undefined;
    }
    if (recoveryHoldTimer) clearInterval(recoveryHoldTimer);
    if (lagTimer) clearInterval(lagTimer);
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    try {
      session?.close();
    } catch {
      // already closed
    }
  });
  client.on("error", (err) => {
    diag.event("client_error", { error: errorLabel(err) });
    logger.warn({ request_id: requestId, error: errorLabel(err) }, "ws soniox client error");
  });
}

export function isTargetRealtimeRequest(config: AppConfig, model: string | null): boolean {
  if (!model) return false;
  if (model === config.TARGET_MODEL) return true;
  return config.TARGET_REALTIME_QUERY_MODELS
    .split(",")
    .map((s) => s.trim())
    .includes(model);
}

export function attachWebSocketHandler(server: import("node:http").Server, deps: WsDeps): void {
  const { config, logger } = deps;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const host = splitHostPort(String(req.headers.host ?? "")).hostname;
    const url = new URL(String(req.url ?? "/"), `https://${host}`);
    const model = url.searchParams.get("model");
    const isTarget = host === config.TARGET_HOST && isTargetRealtimeRequest(config, model);
    const isScribe =
      config.SCRIBE_ENABLED &&
      config.WS_MODE !== "passthrough" &&
      host === config.SCRIBE_HOST &&
      url.pathname === config.SCRIBE_PATH;

    if (isScribe) {
      wss.handleUpgrade(req, socket, head, (client) => scribeWebSocket(req, client, deps));
      return;
    }

    if (isTarget && config.WS_MODE === "passthrough" && !config.ALLOW_TARGET_WS_PASSTHROUGH) {
      logger.warn({ host, path: url.pathname, model }, "refusing to pass target realtime audio to upstream");
      socket.end("HTTP/1.1 501 Not Implemented\r\n\r\n");
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      if (isTarget && config.WS_MODE === "soniox") sonioxWebSocket(req, client, deps);
      else passthroughWebSocket(req, client, deps);
    });
  });
}
