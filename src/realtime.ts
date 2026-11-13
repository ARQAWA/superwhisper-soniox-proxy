import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { ConnectionError } from "@soniox/node";
import type { RealtimeResult, RealtimeSttSession, RealtimeToken } from "@soniox/node";
import type { AppConfig } from "./config.js";
import type { Diagnostics } from "./diagnostics.js";
import { errorLabel } from "./errors.js";
import { sonioxLanguagePolicy } from "./language.js";
import type { Logger } from "./logger.js";
import { CONNECT_TIMEOUT_MS, isRetryable, MAX_RETRIES, REALTIME_RETRY_TIMEOUT_MS } from "./retry.js";
import { SonioxService } from "./soniox.js";
import { scribeWebSocket } from "./scribe.js";
import { mergeTokensToWords, tokensToText } from "./tokens.js";
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
  let sessionProcessedMs = 0;
  let sessionGeneration = 0;
  let finishRequested = false;
  let retries = 0;
  let retryDeadline: number | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let connectTimer: NodeJS.Timeout | undefined;
  let finalDeadline: number | undefined;
  let terminalStatus: string | null = null;
  const bytesPerMs = (actualSampleRate * actualChannels * 2) / 1000;
  const bufferedAudio: Buffer[] = [];
  let audioBytes = 0;
  const MAX_REPLAY_AUDIO_BYTES = 64 * 1024 * 1024;
  const finalTokens: RealtimeToken[] = [];
  const finalTokenKeys = new Set<string>();
  let tailTokens: RealtimeToken[] = [];
  let closing = false;
  let clientClosing = false;
  let completed = false;
  let closeTimer: NodeJS.Timeout | null = null;
  let closeDeadlineTimer: NodeJS.Timeout | undefined;
  let keepaliveTimer: NodeJS.Timeout | undefined;
  let lastAudioAt = Date.now();
  let closeStreamSeen = false;
  let lastTextLength = 0;
  let maxInterimLength = 0;
  let lastSendOk = false;

  const audioEndMs = (): number => audioBytes / bytesPerMs;
  const processedMs = (): number => sessionProcessedMs;
  const allTokens = (): RealtimeToken[] => [...finalTokens, ...tailTokens];

  const appendAudio = (buf: Buffer): void => {
    if (audioBytes + buf.length > MAX_REPLAY_AUDIO_BYTES) {
      errorClient("audio replay buffer limit");
      return;
    }
    audioBytes += buf.length;
    bufferedAudio.push(Buffer.from(buf));
  };

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
      errorClient("client send failed");
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
    if (closing || completed || clientClosing) return 0;
    const textLength = sendTokens(allTokens(), false, false);
    if (textLength > maxInterimLength) maxInterimLength = textLength;
    diag.interimSent(textLength);
    return textLength;
  };

  // Soniox drops finalized prefixes from later results; retain them once.
  const absorbResult = (tokens: RealtimeToken[]): number => {
    const before = finalTokens.length;
    let index = 0;
    while (index < tokens.length && tokens[index].is_final) {
      const token = tokens[index];
      const key = `${token.start_ms ?? "?"}:${token.end_ms ?? "?"}:${token.text}`;
      if (!finalTokenKeys.has(key)) {
        finalTokenKeys.add(key);
        finalTokens.push(token);
      }
      index += 1;
    }
    tailTokens = tokens.slice(index);
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
    if (!closing) {
      errorClient("unexpected realtime finish");
      return;
    }
    if (finalDeadline !== undefined && Date.now() >= finalDeadline) {
      errorClient("final timeout");
      return;
    }
    if (retryDeadline !== undefined && Date.now() >= retryDeadline) {
      errorClient("retry timeout");
      return;
    }
    if (processedMs() < Math.floor(audioEndMs())) {
      handleSessionFailure(new ConnectionError("Incomplete realtime response"), sessionGeneration);
      return;
    }
    completed = true;
    clearTimeout(closeDeadlineTimer);
    clearTimeout(retryTimer);
    clearTimeout(connectTimer);
    bufferedAudio.length = 0;
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = undefined;
    }
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
    if (!delivered) {
      errorClient("final send failed");
      return;
    }
    logger.info(
      {
        request_id: requestId,
        final_tokens: finalTokens.length,
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

  const errorClient = (reason: string): void => {
    if (clientClosing) return;
    clientClosing = true;
    completed = true;
    terminalStatus = "error";
    bufferedAudio.length = 0;
    clearTimeout(closeDeadlineTimer);
    clearTimeout(retryTimer);
    clearTimeout(connectTimer);
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = undefined;
    }
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
        final_tokens: finalTokens.length,
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
      client.close(1011, "soniox incomplete");
    }
    cancelSession();
  };

  function cancelSession(): void {
    const previous = session;
    sessionGeneration += 1;
    session = null;
    sessionReady = false;
    clearTimeout(connectTimer);
    try {
      previous?.close();
    } catch {
      // The session may already be closed.
    }
  }

  function handleSessionFailure(error: unknown, generation: number): void {
    if (completed || clientClosing || generation !== sessionGeneration) return;
    const label = errorLabel(error);
    logger.error({ request_id: requestId, error: label }, "soniox realtime error");
    const now = Date.now();
    if (finalDeadline !== undefined && now >= finalDeadline) {
      errorClient("final timeout");
      return;
    }
    if (!isRetryable(error) || retries >= MAX_RETRIES || (retryDeadline !== undefined && now >= retryDeadline)) {
      diag.error(label, true);
      errorClient("session failed");
      return;
    }
    if (retryDeadline === undefined) {
      retryDeadline = now + REALTIME_RETRY_TIMEOUT_MS;
      retryTimer = setTimeout(() => errorClient("retry timeout"), REALTIME_RETRY_TIMEOUT_MS);
      retryTimer.unref?.();
    }
    retries += 1;
    cancelSession();
    sessionProcessedMs = 0;
    finalTokens.length = 0;
    finalTokenKeys.clear();
    tailTokens = [];
    // Leave the current SDK callback before replacing its canceled session.
    queueMicrotask(openSession);
  }

  function finishSession(target: RealtimeSttSession, generation: number): void {
    if (!closing || !sessionReady || finishRequested || completed || clientClosing || generation !== sessionGeneration) return;
    if (finalDeadline !== undefined && Date.now() >= finalDeadline) {
      errorClient("final timeout");
      return;
    }
    finishRequested = true;
    diag.finishRequested();
    void target.finish().catch((err: unknown) => {
      if (completed || clientClosing || generation !== sessionGeneration) return;
      diag.finishFailed(errorLabel(err));
      logger.warn({ request_id: requestId, error: errorLabel(err) }, "soniox finish failed");
      handleSessionFailure(err, generation);
    });
  }

  function attachSession(target: RealtimeSttSession, generation: number, connectStartedAt: number): void {
    const active = (): boolean =>
      !completed && !clientClosing && generation === sessionGeneration && target === session;
    target.on("connected", () => {
      if (!active()) return;
      clearTimeout(connectTimer);
      if (
        (retryDeadline !== undefined && Date.now() >= retryDeadline) ||
        (finalDeadline !== undefined && Date.now() >= finalDeadline)
      ) {
        errorClient("realtime deadline exceeded");
        return;
      }
      const connectMs = Date.now() - connectStartedAt;
      diag.event("session_connected", {
        first: retries === 0,
        connect_ms: connectMs,
        audio_ms: Math.round(audioEndMs()),
        base_ms: 0,
      });
      diag.connected(connectMs);
      logger.info(
        {
          request_id: requestId,
          model: config.TARGET_MODEL,
          query_model: model,
          sample_rate: sampleRate,
          channels,
          language,
          connect_ms: connectMs,
          reconnect: retries > 0,
        },
        "soniox realtime connected",
      );
      try {
        if (retries === 0 && client.readyState === WebSocket.OPEN) {
          client.send(buildResultsPayload({
            tokens: [], start: 0, duration: 0, isFinal: true, speechFinal: true,
            requestId, model: config.TARGET_MODEL, channels,
          }));
        }
        for (const chunk of bufferedAudio) {
          target.sendAudio(new Uint8Array(chunk));
          if (!active()) return;
        }
        if (retryDeadline !== undefined && Date.now() >= retryDeadline) {
          errorClient("retry timeout");
          return;
        }
        sessionReady = true;
        if (closing) {
          finishSession(target, generation);
        } else {
          clearTimeout(retryTimer);
          retryDeadline = undefined;
        }
      } catch (err) {
        handleSessionFailure(err, generation);
      }
    });

    target.on("result", (result: RealtimeResult) => {
      if (!active()) return;
      sessionProcessedMs = Math.max(sessionProcessedMs, result.total_audio_proc_ms);
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
          finalTokens: finalTokens.length,
          tailTokens: tailTokens.length,
          newFinalTokens,
          totalAudioProcMs: processedMs(),
          finalAudioProcMs: result.final_audio_proc_ms,
          windowStartMs: starts.length ? Math.min(...starts) : null,
          windowEndMs: ends.length ? Math.max(...ends) : null,
          finished: result.finished === true,
          textLength: lastTextLength,
        });
      }
    });

    target.on("endpoint", () => {
      if (!active()) return;
      diag.endpoint();
      logger.debug(
        { request_id: requestId, final_tokens: finalTokens.length, tail_tokens: tailTokens.length },
        "soniox realtime endpoint",
      );
      sendInterim();
    });

    target.on("finalized", () => {
      if (!active()) return;
      diag.finalized(finalTokens.length, tailTokens.length);
      logger.debug(
        { request_id: requestId, final_tokens: finalTokens.length, tail_tokens: tailTokens.length },
        "soniox realtime finalized",
      );
      sendInterim();
    });

    target.on("finished", () => {
      if (!active()) return;
      diag.finished({
        finalTokens: finalTokens.length,
        tailTokens: tailTokens.length,
        totalAudioProcMs: processedMs(),
      });
      logger.info(
        {
          request_id: requestId,
          final_tokens: finalTokens.length,
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
    target.on("disconnected", (reason?: string) => {
      // The SDK normally emits a richer error immediately after disconnected.
      queueMicrotask(() => {
        if (active()) {
          handleSessionFailure(new ConnectionError(reason || "WebSocket disconnected"), generation);
        }
      });
    });
  }

  function openSession(): void {
    if (completed || clientClosing) return;
    const now = Date.now();
    const connectTimeoutMs = Math.min(
      CONNECT_TIMEOUT_MS,
      (retryDeadline ?? Infinity) - now,
      (finalDeadline ?? Infinity) - now,
    );
    if (connectTimeoutMs <= 0) {
      errorClient("realtime deadline exceeded");
      return;
    }
    const generation = ++sessionGeneration;
    finishRequested = false;
    try {
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
        connectTimeoutMs,
      });
      session = target;
      attachSession(target, generation, now);
      connectTimer = setTimeout(() => {
        handleSessionFailure(new ConnectionError("Connection timed out"), generation);
      }, connectTimeoutMs);
      connectTimer.unref?.();
      void target.connect().then(() => {
        if (completed || clientClosing || generation !== sessionGeneration) target.close();
      }).catch((err: unknown) => {
        handleSessionFailure(err, generation);
      });
    } catch (err) {
      handleSessionFailure(err, generation);
    }
  }

  openSession();

  if (!completed && config.SONIOX_KEEPALIVE_MS > 0) {
    const checkMs = Math.min(config.SONIOX_KEEPALIVE_MS, 1000);
    keepaliveTimer = setInterval(() => {
      if (
        !sessionReady ||
        !session ||
        closing ||
        completed ||
        clientClosing
      ) {
        return;
      }
      const idleMs = Date.now() - lastAudioAt;
      if (idleMs < config.SONIOX_KEEPALIVE_MS) return;
      const generation = sessionGeneration;
      try {
        session.keepAlive();
        lastAudioAt = Date.now();
        diag.event("keepalive_sent", { idle_ms: idleMs });
        logger.debug({ request_id: requestId, idle_ms: idleMs }, "soniox realtime keepalive");
      } catch (err) {
        diag.event("keepalive_failed", { error: errorLabel(err) });
        handleSessionFailure(err, generation);
      }
    }, checkMs);
    keepaliveTimer.unref?.();
  }

  client.on("message", (data, isBinary) => {
    if (completed || clientClosing || closing) return;
    logClientFrame(logger, requestId, data, isBinary, model);
    if (isBinary) {
      lastAudioAt = Date.now();
      diag.audioFrame(rawByteLength(data));
      const buf = toBuffer(data);
      appendAudio(buf);
      if (completed) return;
      if (sessionReady && session) {
        const generation = sessionGeneration;
        try {
          session.sendAudio(new Uint8Array(buf));
        } catch (err) {
          diag.event("send_audio_failed", {
            error: errorLabel(err),
          });
          handleSessionFailure(err, generation);
        }
      }
      return;
    }
    const json = safeJson(data.toString());
    const type = typeof json?.type === "string" ? json.type : "";
    if (/^closestream$/i.test(type)) {
      closeStreamSeen = true;
      closing = true;
      finalDeadline = Date.now() + config.SONIOX_CLOSE_TIMEOUT_MS;
      closeDeadlineTimer = setTimeout(() => {
        if (!completed) {
          diag.anomaly(
            "finalize_wait_exceeded",
            {
              wait_ms: config.SONIOX_CLOSE_TIMEOUT_MS,
              final_tokens: finalTokens.length,
              tail_tokens: tailTokens.length,
            },
            "warn",
          );
          errorClient("final timeout");
        }
      }, config.SONIOX_CLOSE_TIMEOUT_MS);
      closeDeadlineTimer.unref?.();
      const closeTextLength = tokensToText(allTokens()).length;
      const lag = Math.round(audioEndMs() - processedMs());
      diag.closeStream({
        finalTokens: finalTokens.length,
        tailTokens: tailTokens.length,
        textLength: closeTextLength,
      });
      logger.info(
        {
          request_id: requestId,
          final_tokens: finalTokens.length,
          tail_tokens: tailTokens.length,
          close_text_length: closeTextLength,
          lag_ms: lag,
          session_ready: sessionReady,
        },
        "soniox realtime CloseStream",
      );
      if (session && sessionReady) finishSession(session, sessionGeneration);
    } else if (/^finalize$/i.test(type)) {
      diag.clientControl("Finalize");
      const generation = sessionGeneration;
      try {
        session?.finalize();
      } catch (err) {
        diag.event("finalize_failed", {
          error: errorLabel(err),
        });
        handleSessionFailure(err, generation);
      }
    } else if (/^keepalive$/i.test(type)) {
      diag.clientControl("KeepAlive");
      const generation = sessionGeneration;
      try {
        session?.keepAlive();
      } catch (err) {
        handleSessionFailure(err, generation);
      }
    } else {
      diag.clientControl(controlType(type) ?? "unknown");
    }
  });

  client.on("close", (code, reason) => {
    clientClosing = true;
    bufferedAudio.length = 0;
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
      finalTokens: finalTokens.length,
      tailTokens: tailTokens.length,
    });
    diag.end(terminalStatus ?? undefined);
    logger.info({ request_id: requestId, code, reason_bytes: reason.length }, "ws soniox client closed");
    clearTimeout(closeDeadlineTimer);
    clearTimeout(retryTimer);
    clearTimeout(connectTimer);
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = undefined;
    }
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    cancelSession();
  });
  client.on("error", (err) => {
    diag.event("client_error", { error: errorLabel(err) });
    logger.warn({ request_id: requestId, error: errorLabel(err) }, "ws soniox client error");
    errorClient("client error");
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
