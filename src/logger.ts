import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { AppConfig } from "./config.js";

export function createLogger(config: AppConfig) {
  mkdirSync(config.LOG_DIR, { recursive: true, mode: 0o700 });
  const fileStream = pino.destination({
    dest: join(config.LOG_DIR, "proxy.log"),
    mkdir: true,
    sync: false,
    mode: 0o600,
  });

  return pino(
    {
      level: config.LOG_LEVEL,
      base: { service: "soniox-proxy" },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['x-license']",
          "req.headers['x-signature']",
          "req.headers['x-id']",
          "authorization",
          "cookie",
          "x-license",
          "x-signature",
          "x-id",
          "sonioxApiKey",
          "soniox_api_key",
          "apiKey",
          "api_key",
          "key",
          "audio",
          "text",
          "transcript",
        ],
        censor: "[REDACTED]",
      },
    },
    pino.multistream([
      { level: config.LOG_LEVEL as pino.Level, stream: process.stdout },
      { level: config.LOG_LEVEL as pino.Level, stream: fileStream },
    ]),
  );
}

export type Logger = ReturnType<typeof createLogger>;
