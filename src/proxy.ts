import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { dirname, extname, resolve } from "node:path";
import tls from "node:tls";
import type { AppConfig } from "./config.js";
import type { Diagnostics } from "./diagnostics.js";
import { errorLabel } from "./errors.js";
import { errorPayload, readRequestBody, sendJson, sendUpstreamResponse, upstreamErrorStatus } from "./http-utils.js";
import type { Logger } from "./logger.js";
import { parseMultipart } from "./multipart.js";
import { SonioxService } from "./soniox.js";
import { attachWebSocketHandler, isScribeModeActive } from "./realtime.js";
import { describeSchema, loadTemplate, renderDeepgramLikeResponse, sanitizeForTemplate } from "./template.js";
import type { ParsedMultipart, RequestMeta, RequestSummary } from "./types.js";
import { forwardRequest, forwardStreamingRequest, resolveRealHost } from "./upstream.js";
import { redactQuery } from "./url-utils.js";

interface CaptureRecord {
  captured_at: string;
  request: RequestSummary & { filename_ext?: string };
  response: {
    status: number;
    content_type: string;
    bytes: number;
    schema: string[];
    template_written: boolean;
  };
}

function splitHostPort(value: string): { hostname: string; port: number } {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    const hostname = trimmed.slice(1, end);
    const port = Number(trimmed.slice(end + 2)) || 443;
    return { hostname, port };
  }
  const idx = trimmed.lastIndexOf(":");
  if (idx === -1) return { hostname: trimmed, port: 443 };
  return { hostname: trimmed.slice(0, idx), port: Number(trimmed.slice(idx + 1)) || 443 };
}

function redactedFilename(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const base = filename.slice(0, filename.length - ext.length);
  if (/^(audio|file|recording|output|test-en)$/i.test(base)) return `${base}${ext || ".bin"}`;
  return `[redacted]${ext || ".bin"}`;
}

function targetModelMatches(config: AppConfig, model: string | null): boolean {
  if (!model) return false;
  return config.TARGET_MODEL.split(",").map((s) => s.trim()).filter(Boolean).includes(model);
}

function audioFromRawBody(body: Buffer, contentType: string, url: URL): ParsedMultipart | null {
  if (!/^(audio|video)\//i.test(contentType)) return null;
  const subtype = contentType.split(";")[0].split("/")[1]?.toLowerCase() || "bin";
  const ext = subtype === "mpeg" ? "mp3" : subtype === "x-wav" ? "wav" : subtype;
  const file = {
    field: "audio",
    filename: `audio.${ext}`,
    mimeType: contentType,
    size: body.length,
    data: body,
  };
  const fields: Record<string, string> = {};
  for (const [key, value] of url.searchParams) fields[key] = value;
  return { fields, fieldNames: Object.keys(fields), files: [file], audio: file };
}

function modelFromRequest(fields: Record<string, string>, url: URL, body: Buffer, contentType: string): string | null {
  for (const key of ["model", "model_id", "modelId", "voice_model", "voiceModelID"]) {
    const value = fields[key] ?? url.searchParams.get(key);
    if (value) return value;
  }
  if (/application\/json/i.test(contentType) && body.length > 0 && body.length < 1024 * 1024) {
    try {
      const json = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      const value = json.model ?? json.model_id ?? json.modelId ?? json.voice_model ?? json.voiceModelID;
      if (typeof value === "string") return value;
    } catch {
      // ignore malformed JSON here; pass-through will handle it
    }
  }
  return null;
}

function pathMatches(config: AppConfig, path: string): boolean {
  if (!config.TARGET_PATH) return true;
  return path === config.TARGET_PATH;
}

function summarizeRequest(
  meta: RequestMeta,
  model: string | null,
  parsed: ParsedMultipart | null,
  config: AppConfig,
): RequestSummary {
  const audio = parsed?.audio ?? null;
  const targetCandidate =
    meta.host === config.TARGET_HOST &&
    meta.method === "POST" &&
    pathMatches(config, meta.path) &&
    targetModelMatches(config, model);
  return {
    host: meta.host,
    method: meta.method,
    path: meta.path,
    query: meta.query,
    contentType: meta.contentType,
    contentLength: meta.contentLength,
    model,
    fieldNames: parsed?.fieldNames ?? [],
    files:
      parsed?.files.map((f) => ({
        field: f.field,
        filename: redactedFilename(f.filename),
        mimeType: f.mimeType,
        size: f.size,
      })) ?? [],
    audioField: audio?.field ?? null,
    targetCandidate,
    targetMatched: targetCandidate && audio !== null,
  };
}

function appendCapture(config: AppConfig, record: CaptureRecord): void {
  let captures: CaptureRecord[] = [];
  try {
    const existing = JSON.parse(readFileSync(config.CAPTURE_PATH, "utf8")) as { captures?: CaptureRecord[] };
    captures = existing.captures ?? [];
  } catch {
    captures = [];
  }
  captures.push(record);
  mkdirSync(dirname(config.CAPTURE_PATH), { recursive: true });
  writeFileSync(config.CAPTURE_PATH, JSON.stringify({ captures }, null, 2) + "\n", { mode: 0o600 });
}

export interface ProxyRuntime {
  mitmEnabled: boolean;
  instanceId: string;
}

export interface ProxyDeps {
  config: AppConfig;
  logger: Logger;
  soniox: SonioxService;
  diagnostics: Diagnostics;
  runtime?: ProxyRuntime;
}

export function createRequestHandler(deps: ProxyDeps) {
  const { config, logger, soniox, diagnostics, runtime } = deps;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const started = Date.now();
    const hostHeader = req.headers.host ?? "";
    const host = splitHostPort(hostHeader).hostname;
    const rawUrl = req.url ?? "/";
    const hostForUrl = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    const url = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${hostForUrl}${rawUrl}`);
    const path = url.pathname;
    const query = redactQuery(url);
    const contentType = String(req.headers["content-type"] ?? "");
    const contentLength = Number(req.headers["content-length"] ?? 0);

    const localHealthHost = host === "127.0.0.1" || host === "::1" || host === "localhost";
    if (localHealthHost && path === "/__health" && (req.method === "GET" || req.method === "HEAD")) {
      sendJson(res, 200, {
        ok: true,
        dry_run: config.DRY_RUN,
        target_host: config.TARGET_HOST,
        target_path: config.TARGET_PATH ?? null,
        target_model: config.TARGET_MODEL,
        target_voice_model_id: config.TARGET_VOICE_MODEL_ID,
        target_realtime_query_models: config.TARGET_REALTIME_QUERY_MODELS,
        ws_mode: config.WS_MODE,
        soniox_realtime_model: config.SONIOX_REALTIME_MODEL,
        soniox_endpoint_detection: config.SONIOX_ENDPOINT_DETECTION,
        soniox_endpoint_sensitivity: config.SONIOX_ENDPOINT_SENSITIVITY,
        soniox_endpoint_latency_adjustment_level: config.SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL,
        soniox_max_endpoint_delay_ms: config.SONIOX_MAX_ENDPOINT_DELAY_MS,
        soniox_keepalive_ms: config.SONIOX_KEEPALIVE_MS,
        mitm_enabled: runtime?.mitmEnabled ?? false,
        pid: process.pid,
        entry_path: resolve(process.argv[1] ?? ""),
        instance_id: runtime?.instanceId ?? "",
        scribe_enabled: config.SCRIBE_ENABLED,
        scribe_host: config.SCRIBE_HOST,
        scribe_path: config.SCRIBE_PATH,
        scribe_model: config.SCRIBE_MODEL,
        scribe_voice_model_id: config.SCRIBE_VOICE_MODEL_ID,
        scribe_vad_tuning: config.SCRIBE_VAD_TUNING,
        scribe_vad_silence_threshold_secs: config.SCRIBE_VAD_SILENCE_THRESHOLD_SECS,
        scribe_vad_threshold: config.SCRIBE_VAD_THRESHOLD,
        scribe_min_speech_duration_ms: config.SCRIBE_MIN_SPEECH_DURATION_MS,
        scribe_min_silence_duration_ms: config.SCRIBE_MIN_SILENCE_DURATION_MS,
        uptime_seconds: Math.round(process.uptime()),
        diagnostics_enabled: diagnostics.isEnabled,
        diagnostics_dir: diagnostics.dir,
      });
      return;
    }

    if (host === config.SCRIBE_HOST) {
      try {
        const streamed = await forwardStreamingRequest(
          {
            hostname: host,
            port: 443,
            method: req.method ?? "GET",
            path: rawUrl.startsWith("http") ? url.pathname + url.search : rawUrl,
            headers: req.headers,
            body: Buffer.alloc(0),
            bodyStream: req,
            timeoutMs: config.UPSTREAM_TIMEOUT_MS,
          },
          res,
        );
        logger.info(
          {
            request_id: requestId,
            status: streamed.status,
            response_bytes: streamed.bytes,
            streaming: true,
            upstream_forwarded: true,
            latency_ms: Date.now() - started,
          },
          "proxy response (streaming pass-through)",
        );
      } catch (err) {
        const status = upstreamErrorStatus(err);
        logger.error(
          {
            request_id: requestId,
            status,
            streaming: true,
            upstream_forwarded: false,
            latency_ms: Date.now() - started,
            error: errorLabel(err),
          },
          "streaming upstream request failed",
        );
        diagnostics.recordError("upstream_stream", err, {
          request_id: requestId,
          host,
          path,
          status,
          latency_ms: Date.now() - started,
        });
        if (res.headersSent) res.destroy(err instanceof Error ? err : undefined);
        else sendJson(res, status, errorPayload(err instanceof Error ? err.message : "upstream error", "upstream_error"));
      }
      return;
    }

    let body: Buffer;
    try {
      body = await readRequestBody(req, config.MAX_BODY_BYTES);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 413;
      logger.warn({ request_id: requestId, host, method: req.method, path, status }, "request body rejected");
      diagnostics.recordError("request_body", err, { request_id: requestId, host, path, status });
      sendJson(res, status, errorPayload(err instanceof Error ? err.message : "request body error", "request_too_large"));
      return;
    }

    const meta: RequestMeta = {
      host,
      method: req.method ?? "GET",
      path,
      query,
      contentType,
      contentLength,
    };

    let parsed: ParsedMultipart | null = null;
    if (/^multipart\/form-data/i.test(contentType)) {
      try {
        parsed = await parseMultipart(body, contentType, config.MAX_BODY_BYTES);
      } catch (err) {
        logger.warn(
          { request_id: requestId, host, method: meta.method, path, error: errorLabel(err) },
          "multipart parse failed; passing through",
        );
      }
    }

    if (!parsed) {
      parsed = audioFromRawBody(body, contentType, url);
    }
    const model = modelFromRequest(parsed?.fields ?? {}, url, body, contentType);
    const summary = summarizeRequest(meta, model, parsed, config);

    logger.info(
      {
        request_id: requestId,
        host: summary.host,
        method: summary.method,
        path: summary.path,
        query: summary.query,
        content_type: summary.contentType,
        content_length: summary.contentLength,
        model: summary.model,
        field_names: summary.fieldNames,
        files: summary.files,
        audio_field: summary.audioField,
        target_candidate: summary.targetCandidate,
        target_matched: summary.targetMatched,
      },
      "proxy request",
    );

    if (summary.targetMatched && !config.DRY_RUN) {
      try {
        if (!parsed?.audio) throw new Error("target request has no audio file");
        const result = await soniox.transcribe(parsed.audio, parsed.fields, requestId, parsed.fields.diarize === "true");
        const template = loadTemplate(config.TEMPLATE_PATH);
        const rendered = renderDeepgramLikeResponse({
          template,
          text: result.text,
          tokens: result.tokens,
          durationSeconds: result.durationMs / 1000,
          requestId: result.transcriptionId,
          language: result.language,
        });
        const responseBody = Buffer.from(JSON.stringify(rendered));
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.setHeader("content-length", String(responseBody.length));
        res.end(responseBody);
        logger.info(
          {
            request_id: requestId,
            status: 200,
            target_matched: true,
            upstream_forwarded: false,
            soniox_transcription_id: result.transcriptionId,
            soniox_client_reference_id: result.clientReferenceId,
            audio_bytes: parsed.audio.size,
            latency_ms: Date.now() - started,
          },
          "proxy response (soniox)",
        );
        return;
      } catch (err) {
        const status = upstreamErrorStatus(err);
        logger.error(
          {
            request_id: requestId,
            status,
            target_matched: true,
            upstream_forwarded: false,
            latency_ms: Date.now() - started,
            error: errorLabel(err),
          },
          "soniox target failed",
        );
        diagnostics.recordError("batch_target", err, {
          request_id: requestId,
          status,
          latency_ms: Date.now() - started,
        });
        sendJson(res, status, errorPayload(err instanceof Error ? err.message : "transcription failed", "soniox_error"));
        return;
      }
    }

    // Dry-run or non-target: transparent pass-through.
    try {
      const upstream = await forwardRequest({
        hostname: host,
        port: 443,
        method: meta.method,
        path: rawUrl.startsWith("http") ? url.pathname + url.search : rawUrl,
        headers: req.headers,
        body,
        timeoutMs: config.UPSTREAM_TIMEOUT_MS,
      });
      sendUpstreamResponse(res, upstream);

      const responseContentType = String(upstream.headers["content-type"] ?? "");
      const isJson = /application\/json/i.test(responseContentType);
      let schema: string[] = [];
      let templateWritten = false;
      if (isJson && upstream.body.length > 0 && upstream.body.length < 8 * 1024 * 1024) {
        try {
          const json = JSON.parse(upstream.body.toString("utf8")) as unknown;
          schema = describeSchema(json);
          if (config.CAPTURE_TEMPLATE && summary.targetCandidate && upstream.status === 200) {
            const template = sanitizeForTemplate(json);
            mkdirSync(dirname(config.TEMPLATE_PATH), { recursive: true });
            writeFileSync(config.TEMPLATE_PATH, JSON.stringify(template, null, 2) + "\n", { mode: 0o644 });
            templateWritten = true;
          }
        } catch {
          schema = ["<invalid json>"];
        }
      }

      if (summary.targetCandidate) {
        const audioFile = parsed?.audio;
        appendCapture(config, {
          captured_at: new Date().toISOString(),
          request: {
            ...summary,
            filename_ext: audioFile ? extname(audioFile.filename) : undefined,
          },
          response: {
            status: upstream.status,
            content_type: responseContentType,
            bytes: upstream.body.length,
            schema,
            template_written: templateWritten,
          },
        });
      }

      logger.info(
        {
          request_id: requestId,
          status: upstream.status,
          response_content_type: responseContentType,
          response_bytes: upstream.body.length,
          target_candidate: summary.targetCandidate,
          target_matched: summary.targetMatched,
          upstream_forwarded: true,
          response_schema: schema,
          latency_ms: Date.now() - started,
        },
        "proxy response (pass-through)",
      );
    } catch (err) {
      const status = upstreamErrorStatus(err);
      logger.error(
        {
          request_id: requestId,
          status,
          upstream_forwarded: false,
          latency_ms: Date.now() - started,
          error: errorLabel(err),
        },
        "upstream request failed",
      );
      diagnostics.recordError("upstream", err, {
        request_id: requestId,
        host,
        path,
        status,
        latency_ms: Date.now() - started,
      });
      sendJson(res, status, errorPayload(err instanceof Error ? err.message : "upstream error", "upstream_error"));
    }
  };
}

export interface ProxyHandle {
  close: () => Promise<void>;
  port: number;
}

export async function startProxy(deps: ProxyDeps): Promise<ProxyHandle> {
  const { config, logger } = deps;
  const runtime: ProxyRuntime = { mitmEnabled: false, instanceId: randomUUID() };
  const handler = createRequestHandler({ ...deps, runtime });
  const servers: http.Server[] = [];
  const sockets = new Set<net.Socket>();
  const trackSocket = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  const makeServer = (): http.Server => {
    const server = http.createServer((req, res) => {
      handler(req, res).catch((err) => {
        logger.error({ error: errorLabel(err) }, "unhandled proxy handler error");
        deps.diagnostics.recordError("handler", err);
        if (!res.headersSent) sendJson(res, 500, errorPayload("proxy internal error", "proxy_error"));
        else res.end();
      });
    });
    server.on("connection", trackSocket);
    server.on("clientError", (err, socket) => {
      logger.warn({ error: err.message }, "client error");
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    return server;
  };

  const keyPath = `${config.CERT_DIR}/leaf.key`;
  const certPath = `${config.CERT_DIR}/leaf.crt`;
  let tlsServer: tls.Server | null = null;
  try {
    const key = readFileSync(keyPath);
    const cert = readFileSync(certPath);
    const sharedHttp = http.createServer((req, res) => {
      handler(req, res).catch((err) => {
        logger.error({ error: errorLabel(err) }, "unhandled MITM handler error");
        deps.diagnostics.recordError("mitm_handler", err);
        if (!res.headersSent) sendJson(res, 500, errorPayload("proxy internal error", "proxy_error"));
        else res.end();
      });
    });
    sharedHttp.on("clientError", (err, socket) => {
      logger.warn({ error: err.message }, "MITM client error");
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    attachWebSocketHandler(sharedHttp, deps);
    tlsServer = tls.createServer({ key, cert, ALPNProtocols: ["http/1.1"] }, (tlsSocket) => {
      logger.debug({ remote: tlsSocket.remoteAddress }, "MITM TLS established");
      trackSocket(tlsSocket);
      sharedHttp.emit("connection", tlsSocket);
    });
    tlsServer.on("connection", trackSocket);
    tlsServer.on("tlsClientError", (err, socket) => {
      logger.warn({ error: err.message }, "MITM TLS client error (possible certificate pinning)");
      socket.destroy();
    });
    runtime.mitmEnabled = true;
  } catch (err) {
    logger.warn(
      { error: errorLabel(err), cert_dir: config.CERT_DIR },
      "MITM certificate not loaded; only CONNECT tunneling will work",
    );
  }

  const onConnect = (req: IncomingMessage, clientSocket: net.Socket, head: Buffer): void => {
    trackSocket(clientSocket);
    const { hostname, port } = splitHostPort(req.url ?? "");
    const scribeMitm =
      config.SCRIBE_ENABLED && hostname === config.SCRIBE_HOST && isScribeModeActive(config);
    if ((hostname === config.TARGET_HOST || scribeMitm) && tlsServer) {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) clientSocket.unshift(head);
      tlsServer.emit("connection", clientSocket);
      return;
    }

    // Non-target CONNECT: raw end-to-end TLS tunnel. We never see its plaintext.
    void (async () => {
      try {
        const resolved = await resolveRealHost(hostname);
        const upstream = net.connect({ host: resolved.address, port, family: resolved.family });
        trackSocket(upstream);
        upstream.once("connect", () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on("error", (err) => {
          logger.warn({ host: hostname, error: err.message }, "CONNECT tunnel upstream error");
          clientSocket.destroy();
        });
        clientSocket.on("error", () => upstream.destroy());
      } catch (err) {
        logger.warn({ host: hostname, error: errorLabel(err) }, "CONNECT tunnel resolve error");
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
    })();
  };

  for (const host of ["127.0.0.1", "::1"]) {
    const server = makeServer();
    server.on("connect", onConnect);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.PROXY_PORT, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      servers.push(server);
      logger.info({ host, port: config.PROXY_PORT }, "proxy listening");
    } catch (err) {
      if (host === "::1") logger.warn({ port: config.PROXY_PORT, error: (err as Error).message }, "IPv6 loopback listen failed");
      else throw err;
    }
  }

  return {
    port: config.PROXY_PORT,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (tlsServer) tlsServer.close();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeAllConnections?.();
            }),
        ),
      );
    },
  };
}
