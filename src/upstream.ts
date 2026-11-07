import { resolve4, resolve6 } from "node:dns/promises";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { UpstreamResponse } from "./types.js";

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

interface ResolvedHost {
  address: string;
  family: number;
  expiresAt: number;
}

const dnsCache = new Map<string, ResolvedHost>();

export async function resolveRealHost(hostname: string): Promise<ResolvedHost> {
  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached;

  let address: string | null = null;
  let family = 4;
  try {
    const v4 = await resolve4(hostname);
    if (v4.length > 0) {
      address = v4[0];
      family = 4;
    }
  } catch {
    // fall through to IPv6
  }
  if (!address) {
    try {
      const v6 = await resolve6(hostname);
      if (v6.length > 0) {
        address = v6[0];
        family = 6;
      }
    } catch {
      // fall through
    }
  }
  if (!address) {
    throw new Error(`cannot resolve ${hostname} without /etc/hosts`);
  }

  const result = { address, family, expiresAt: Date.now() + 60_000 };
  dnsCache.set(hostname, result);
  return result;
}

function lookupBypassingHosts(
  hostname: string,
  options: { family?: number; all?: boolean },
  callback: (err: NodeJS.ErrnoException | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void,
): void {
  resolveRealHost(hostname)
    .then(({ address, family }) => {
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    })
    .catch((err: Error) => callback(err, undefined, undefined));
}

function cleanRequestHeaders(headers: IncomingHttpHeaders, hostname: string, body: Buffer): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "accept-encoding") continue;
    if (lower === "host") continue;
    if (lower === "content-length") continue;
    if (lower === "expect") continue;
    out[key] = value;
  }
  out.host = hostname;
  if (body.length > 0 || !["GET", "HEAD", "DELETE", "OPTIONS"].includes((headers[":method"] as string) ?? "")) {
    out["content-length"] = String(body.length);
  }
  return out;
}

function cleanResponseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "content-encoding") continue;
    if (lower === "content-length") continue;
    out[key] = value;
  }
  return out;
}

function decodeBody(body: Buffer, encoding: string | undefined): Buffer {
  if (!encoding) return body;
  const normalized = encoding.toLowerCase().trim();
  try {
    if (normalized === "gzip") return gunzipSync(body);
    if (normalized === "deflate") return inflateSync(body);
    if (normalized === "br") return brotliDecompressSync(body);
  } catch {
    return body;
  }
  return body;
}

export interface ForwardRequest {
  hostname: string;
  port: number;
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  timeoutMs: number;
}

export async function forwardRequest(req: ForwardRequest): Promise<UpstreamResponse> {
  const resolved = await resolveRealHost(req.hostname);

  return new Promise<UpstreamResponse>((resolve, reject) => {
    const request = https.request(
      {
        hostname: req.hostname,
        port: req.port,
        method: req.method,
        path: req.path,
        headers: cleanRequestHeaders(req.headers, req.hostname, req.body),
        servername: req.hostname,
        rejectUnauthorized: true,
        lookup: lookupBypassingHosts as never,
        timeout: req.timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks);
          const decoded = decodeBody(raw, response.headers["content-encoding"]);
          const headers = cleanResponseHeaders(response.headers);
          headers["content-length"] = String(decoded.length);
          resolve({
            status: response.statusCode ?? 502,
            statusMessage: response.statusMessage ?? "",
            headers,
            body: decoded,
          });
        });
        response.on("error", reject);
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error(`upstream timeout after ${req.timeoutMs}ms`));
    });
    request.on("error", (err) => reject(err));
    if (req.body.length > 0) request.write(req.body);
    request.end();
  });
}
