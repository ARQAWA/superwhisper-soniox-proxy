import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { AppConfig } from "./config.js";
import { errorLabel } from "./errors.js";
import type { Logger } from "./logger.js";

const KEEPALIVE_OPTIONS = {
  keepAlive: true,
  maxSockets: 1,
  maxFreeSockets: 1,
  scheduling: "lifo" as const,
  timeout: 30_000,
};

/**
 * One warm socket per provider. ElevenLabs reuses this agent for Scribe
 * WebSocket handshakes, so the TLS session is already established when the
 * app opens its first dictation socket. Soniox REST calls reuse
 * `sonioxApiAgent` through the custom fetch adapter below.
 */
export const elevenLabsAgent = new https.Agent(KEEPALIVE_OPTIONS);
export const superwhisperAgent = new https.Agent(KEEPALIVE_OPTIONS);
export const sonioxApiAgent = new https.Agent(KEEPALIVE_OPTIONS);

const originalFetch = globalThis.fetch;

function headerBag(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) out.append(key, item);
    } else {
      out.set(key, value);
    }
  }
  return out;
}

/**
 * Fetch implementation for the Soniox REST client. Requests to the configured
 * API host go through a keep-alive agent, so the first upload and every poll
 * reuse the already-warm connection instead of paying a new TLS handshake.
 */
export function createWarmFetch(baseUrl: string): typeof fetch {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return originalFetch;
  }

  return async function warmFetch(input, init) {
    let request: Request;
    try {
      request = new Request(input, init);
    } catch {
      return originalFetch(input, init);
    }
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.hostname !== base.hostname) {
      return originalFetch(input, init);
    }

    const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
    const headers: Record<string, string | string[]> = {};
    request.headers.forEach((value, key) => {
      if (key !== "content-length" && key !== "host") headers[key] = value;
    });
    headers.host = url.host;
    if (body) headers["content-length"] = String(body.length);

    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        agent: sonioxApiAgent,
        servername: url.hostname,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 502;
          // Response rejects a body for these statuses.
          const bodyAllowed = status !== 204 && status !== 205 && status !== 304;
          try {
            resolve(
              new Response(bodyAllowed ? Buffer.concat(chunks) : null, {
                status,
                statusText: res.statusMessage,
                headers: headerBag(res.headers),
              }),
            );
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (request.signal) {
      if (request.signal.aborted) {
        req.destroy();
        reject(request.signal.reason ?? new Error("request aborted"));
        return promise;
      }
      request.signal.addEventListener(
        "abort",
        () => {
          req.destroy(
            request.signal?.reason instanceof Error
              ? request.signal.reason
              : new Error("request aborted"),
          );
        },
        { once: true },
      );
    }
    if (body && body.length > 0) req.write(body);
    req.end();
    return promise;
  } as typeof fetch;
}

interface ProbeResult {
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
}

function probe(
  hostname: string,
  path: string,
  agent: https.Agent,
  headers: Record<string, string> = {},
): Promise<ProbeResult> {
  const started = Date.now();
  const { promise, resolve } = Promise.withResolvers<ProbeResult>();
  const req = https.request(
    {
      hostname,
      port: 443,
      path,
      method: "GET",
      headers,
      agent,
      servername: hostname,
      timeout: 10_000,
    },
    (res) => {
      res.resume();
      res.on("end", () => resolve({ ok: true, status: res.statusCode ?? null, ms: Date.now() - started }));
      res.on("error", (err) =>
        resolve({ ok: false, status: null, ms: Date.now() - started, error: errorLabel(err) }),
      );
    },
  );
  req.on("timeout", () => req.destroy(new Error("warmup probe timeout")));
  req.on("error", (err) =>
    resolve({ ok: false, status: null, ms: Date.now() - started, error: errorLabel(err) }),
  );
  req.end();
  return promise;
}

async function probeRealtimeHost(hostname: string): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const response = await originalFetch(`https://${hostname}/`, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    return { ok: true, status: response.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: null, ms: Date.now() - started, error: errorLabel(err) };
  }
}

export interface WarmStatusEntry {
  at: string;
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
}

export interface WarmupStatus {
  enabled: boolean;
  interval_ms: number;
  last_run_at: string | null;
  providers: Record<string, WarmStatusEntry>;
}

export interface WarmupHandle {
  start(): void;
  stop(): void;
  run(): Promise<WarmupStatus>;
  status(): WarmupStatus;
}

export function createWarmup(config: AppConfig, logger: Logger): WarmupHandle {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let lastRunAt: string | null = null;
  const providers: Record<string, WarmStatusEntry> = {};

  const snapshot = (): WarmupStatus => ({
    enabled: config.WARMUP_ENABLED,
    interval_ms: config.WARMUP_INTERVAL_MS,
    last_run_at: lastRunAt,
    providers: { ...providers },
  });

  const run = async (): Promise<WarmupStatus> => {
    if (!config.WARMUP_ENABLED || running) return snapshot();
    running = true;
    try {
      let apiHost: string | null = null;
      try {
        apiHost = new URL(config.SONIOX_API_BASE_URL).hostname;
      } catch {
        apiHost = null;
      }
      const jobs: Array<Promise<[string, ProbeResult]>> = [];
      if (apiHost && config.sonioxApiKey) {
        jobs.push(
          probe(apiHost, "/v1/models", sonioxApiAgent, {
            authorization: `Bearer ${config.sonioxApiKey}`,
          }).then((result) => ["soniox_api", result]),
        );
      }
      if (config.SCRIBE_ENABLED) {
        jobs.push(probe(config.SCRIBE_HOST, "/", elevenLabsAgent).then((result) => ["elevenlabs", result]));
      }
      if (config.SCRIBE_BATCH_ENABLED) {
        jobs.push(
          probe(config.SUPERWHISPER_HOST, "/", superwhisperAgent).then((result) => [
            "superwhisper",
            result,
          ]),
        );
      }
      if (config.WS_MODE === "soniox") {
        jobs.push(probeRealtimeHost(config.SONIOX_REALTIME_HOST).then((result) => ["soniox_realtime", result]));
      }

      const results = await Promise.all(jobs);
      const at = new Date().toISOString();
      for (const [name, result] of results) {
        providers[name] = { at, ...result };
      }
      lastRunAt = at;
      logger.debug({ providers }, "warm connection probe");
    } finally {
      running = false;
    }
    return snapshot();
  };

  return {
    start() {
      if (!config.WARMUP_ENABLED || timer) return;
      void run();
      timer = setInterval(() => void run(), config.WARMUP_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    run,
    status: snapshot,
  };
}
