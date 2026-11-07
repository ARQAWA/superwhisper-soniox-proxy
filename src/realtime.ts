import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { RealtimeResult, RealtimeToken } from "@soniox/node";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { SonioxService } from "./soniox.js";
import { mergeTokensToWords, tokensToText } from "./tokens.js";
import { redactQuery } from "./url-utils.js";

interface WsDeps {
  config: AppConfig;
  logger: Logger;
  soniox: SonioxService;
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
      message_type: typeof json?.type === "string" ? json.type : undefined,
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
    logger.info({ request_id: requestId, code, reason: reason.toString(), model }, "ws client closed");
    upstream.close();
  });
  client.on("error", (err) => logger.warn({ request_id: requestId, error: err.message }, "ws client error"));

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
    logger.info({ request_id: requestId, code, reason: reason.toString(), model }, "ws upstream closed");
    if (client.readyState === WebSocket.OPEN) client.close(code, reason);
  });
  upstream.on("error", (err) => {
    logger.warn({ request_id: requestId, error: err.message, model }, "ws upstream error");
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
  const languageHints = language && !["auto", "multi", "und"].includes(language) ? [language.split("-")[0]] : ["ru", "en"];
  const identifyLanguage = ["auto", "multi", "und"].includes(language);
  const diarize = url.searchParams.get("diarize") === "true";

  const session = soniox.createRealtimeSession({
    languageHints,
    identifyLanguage,
    sampleRate: Number.isFinite(sampleRate) ? sampleRate : 16000,
    channels: Number.isFinite(channels) ? channels : 1,
    diarize,
    // One continuous utterance keeps the app's live text stable; Soniox still
    // finalizes tokens internally, we just do not expose endpoint breaks.
    endpointDetection: false,
  });

  let connected = false;
  const pending: Buffer[] = [];
  let finalTokens: RealtimeToken[] = [];
  const finalTokenKeys = new Set<string>();
  let tailTokens: RealtimeToken[] = [];
  let closing = false;
  let clientClosing = false;
  let completed = false;
  let closeTimer: NodeJS.Timeout | null = null;
  let lastTotalMs = 0;
  let maxInterimLength = 0;

  const allTokens = (): RealtimeToken[] => [...finalTokens, ...tailTokens];

  const tokenKey = (token: RealtimeToken): string =>
    `${token.start_ms ?? "?"}:${token.end_ms ?? "?"}:${token.text}`;

  const sendTokens = (tokens: RealtimeToken[], isFinal: boolean, speechFinal: boolean): number => {
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
    client.send(payload);
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

  const sendInterim = (): void => {
    if (closing) return;
    maxInterimLength = Math.max(maxInterimLength, sendTokens(allTokens(), false, false));
  };

  // Soniox slides its token window: once a prefix is finalized, later results
  // contain only newer tokens. Accumulate the finalized prefix or the app loses
  // everything before the last pause.
  const absorbResult = (tokens: RealtimeToken[]): void => {
    let index = 0;
    while (index < tokens.length && tokens[index].is_final) {
      const token = tokens[index];
      const key = tokenKey(token);
      if (!finalTokenKeys.has(key)) {
        finalTokenKeys.add(key);
        finalTokens.push(token);
      }
      index += 1;
    }
    tailTokens = tokens.slice(index);
  };

  const sendMetadata = (): void => {
    if (client.readyState !== WebSocket.OPEN) return;
    client.send(
      JSON.stringify({
        type: "Metadata",
        ...realtimeMetadata(requestId, config.TARGET_MODEL, lastTotalMs / 1000, channels),
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
  };

  const completeStream = (): void => {
    if (completed) return;
    completed = true;
    const tokens = allTokens();
    let finalTextLength = 0;
    if (tokens.length > 0) {
      finalTextLength = sendTokens(tokens, true, true);
    } else if (client.readyState === WebSocket.OPEN) {
      // Keep Deepgram's shape even for a silent stream.
      client.send(
        buildResultsPayload({
          tokens: [],
          start: 0,
          duration: lastTotalMs / 1000,
          isFinal: true,
          speechFinal: true,
          requestId,
          model: config.TARGET_MODEL,
          channels,
        }),
      );
    }
    logger.info(
      {
        request_id: requestId,
        final_tokens: finalTokens.length,
        tail_tokens: tailTokens.length,
        final_text_length: finalTextLength,
        max_interim_length: maxInterimLength,
      },
      "soniox realtime final response",
    );
    sendMetadata();
    closeClient();
  };

  session.on("connected", () => {
    connected = true;
    logger.info(
      { request_id: requestId, model: config.TARGET_MODEL, query_model: model, sample_rate: sampleRate, channels, language },
      "soniox realtime connected",
    );
    if (client.readyState === WebSocket.OPEN) {
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
    }
    for (const buf of pending) session.sendAudio(new Uint8Array(buf));
    pending.length = 0;
  });

  session.on("result", (result: RealtimeResult) => {
    lastTotalMs = result.total_audio_proc_ms;
    if (result.tokens.length > 0) {
      absorbResult(result.tokens);
      sendInterim();
    }
  });

  session.on("endpoint", () => {
    logger.debug(
      { request_id: requestId, final_tokens: finalTokens.length, tail_tokens: tailTokens.length },
      "soniox realtime endpoint",
    );
    sendInterim();
  });

  session.on("finalized", () => {
    logger.debug(
      { request_id: requestId, final_tokens: finalTokens.length, tail_tokens: tailTokens.length },
      "soniox realtime finalized",
    );
    sendInterim();
  });

  session.on("finished", () => {
    logger.info(
      { request_id: requestId, final_tokens: finalTokens.length, tail_tokens: tailTokens.length, total_ms: lastTotalMs },
      "soniox realtime finished",
    );
    completeStream();
  });

  session.on("error", (err: Error) => {
    logger.error({ request_id: requestId, error: err.message }, "soniox realtime error");
    if (client.readyState === WebSocket.OPEN) client.close(1011, "soniox error");
  });

  client.on("message", (data, isBinary) => {
    logClientFrame(logger, requestId, data, isBinary, model);
    if (isBinary) {
      const buf = toBuffer(data);
      if (connected) session.sendAudio(new Uint8Array(buf));
      else pending.push(buf);
      return;
    }
    const json = safeJson(data.toString());
    const type = typeof json?.type === "string" ? json.type : "";
    if (/^closestream$/i.test(type)) {
      logger.info(
        {
          request_id: requestId,
          final_tokens: finalTokens.length,
          tail_tokens: tailTokens.length,
          close_text_length: tokensToText(allTokens()).length,
        },
        "soniox realtime CloseStream",
      );
      closing = true;
      void session.finish().catch((err: Error) => logger.warn({ request_id: requestId, error: err.message }, "soniox finish failed"));
      // Safety net if the Soniox session never reports finished.
      closeTimer = setTimeout(completeStream, 2500);
    } else if (/^finalize$/i.test(type)) {
      void session.finalize();
    } else if (/^keepalive$/i.test(type)) {
      session.keepAlive();
    }
  });

  client.on("close", (code, reason) => {
    logger.info({ request_id: requestId, code, reason: reason.toString() }, "ws soniox client closed");
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    try {
      session.close();
    } catch {
      // already closed
    }
  });
  client.on("error", (err) => logger.warn({ request_id: requestId, error: err.message }, "ws soniox client error"));

  void session
    .connect()
    .catch((err: Error) => {
      logger.error({ request_id: requestId, error: err.message }, "soniox realtime connect failed");
      if (client.readyState === WebSocket.OPEN) client.close(1011, "soniox connect failed");
    });
}

let targetModeCache: { at: number; value: boolean } = { at: 0, value: false };

function activeModeUsesTargetVoiceModel(config: AppConfig): boolean {
  if (Date.now() - targetModeCache.at < 1000) return targetModeCache.value;
  let modeKey = config.TARGET_MODE_KEY;
  try {
    const out = execFileSync("/usr/bin/defaults", ["read", "com.superduper.superwhisper", "activeModeKey"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    if (out) modeKey = out;
  } catch {
    // fall back to configured mode key
  }
  let value = false;
  try {
    const modePath = join(homedir(), "Documents", "superwhisper", "modes", `${modeKey}.json`);
    const mode = JSON.parse(readFileSync(modePath, "utf8")) as { voiceModelID?: string };
    value = mode.voiceModelID === config.TARGET_VOICE_MODEL_ID;
  } catch {
    value = false;
  }
  targetModeCache = { at: Date.now(), value };
  return value;
}

export function isTargetRealtimeRequest(config: AppConfig, model: string | null): boolean {
  if (!model) return false;
  if (model === config.TARGET_MODEL) return true;
  if (!config.TARGET_REALTIME_QUERY_MODELS.split(",").map((s) => s.trim()).includes(model)) return false;
  return activeModeUsesTargetVoiceModel(config);
}

export function attachWebSocketHandler(server: import("node:http").Server, deps: WsDeps): void {
  const { config, logger } = deps;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const host = splitHostPort(String(req.headers.host ?? "")).hostname;
    const url = new URL(String(req.url ?? "/"), `https://${host}`);
    const model = url.searchParams.get("model");
    const isTarget = host === config.TARGET_HOST && isTargetRealtimeRequest(config, model);

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
