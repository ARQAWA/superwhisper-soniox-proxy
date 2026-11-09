import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const boolFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return defaultValue;
      const lower = v.toLowerCase();
      if (["1", "true", "yes", "on"].includes(lower)) return true;
      if (["0", "false", "no", "off"].includes(lower)) return false;
      ctx.addIssue({
        code: "custom",
        message: `expected a boolean (true/false, 1/0, yes/no, on/off), got "${v}"`,
      });
      return false;
    });

const EnvSchema = z.object({
  PROXY_HOST: z.string().default("127.0.0.1"),
  PROXY_PORT: z.coerce.number().int().min(1).max(65535).default(8443),
  PROXY_HEALTH_HOST: z.string().default("127.0.0.1"),
  TARGET_HOST: z.string().default("api.deepgram.com"),
  TARGET_PATH: z.string().default("/v1/listen"),
  TARGET_MODEL: z.string().default("nova-3"),
  TARGET_VOICE_MODEL_ID: z.string().default("sw-deepgram-nova-3"),
  TARGET_MODE_KEY: z.string().default("soniox-target"),
  TARGET_REALTIME_QUERY_MODELS: z.string().default("nova-2,nova-3"),
  DRY_RUN: boolFromEnv(false),
  CAPTURE_TEMPLATE: boolFromEnv(false),
  LOG_LEVEL: z.string().default("info"),
  DIAG_ENABLED: boolFromEnv(true),
  DIAG_DIR: z.string().default(join(homedir(), "Library", "Caches", "soniox-proxy", "diagnostics")),
  DIAG_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  DIAG_AUDIO_GAP_MS: z.coerce.number().int().min(100).default(1500),
  DIAG_RESULT_GAP_MS: z.coerce.number().int().min(500).default(8000),
  DIAG_AUDIO_LAG_MS: z.coerce.number().int().min(500).default(3000),
  DIAG_CLOSE_TIMEOUT_MS: z.coerce.number().int().min(250).default(1500),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60000),
  SONIOX_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60000),
  MAX_BODY_BYTES: z.coerce.number().int().min(1024).default(64 * 1024 * 1024),
  SONIOX_MODEL: z.string().default("stt-async-v6"),
  SONIOX_REALTIME_MODEL: z.string().default("stt-rt-v6"),
  SONIOX_ENDPOINT_DETECTION: boolFromEnv(true),
  SONIOX_ENDPOINT_SENSITIVITY: z.coerce.number().min(-1).max(1).default(0),
  SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL: z.coerce.number().int().min(0).max(3).default(0),
  SONIOX_MAX_ENDPOINT_DELAY_MS: z.coerce.number().int().min(500).max(3000).default(2000),
  SONIOX_KEEPALIVE_MS: z.coerce.number().int().min(0).max(15000).default(10000),
  SONIOX_PREFIX_BATCH_CONNECT_MS: z.coerce.number().int().min(0).max(10000).default(1200),
  SONIOX_RECONNECT_LAG_MS: z.coerce.number().int().min(1000).max(30000).default(4000),
  SONIOX_RECONNECT_MAX: z.coerce.number().int().min(0).max(10).default(3),
  SONIOX_RECONNECT_OVERLAP_MS: z.coerce.number().int().min(0).max(2000).default(500),
  SONIOX_CLOSE_ERROR_LAG_MS: z.coerce.number().int().min(500).max(30000).default(2000),
  SONIOX_CLOSE_BATCH_DELAY_MS: z.coerce.number().int().min(250).max(5000).default(1000),
  SONIOX_CLOSE_RECOVERY_MS: z.coerce.number().int().min(2000).max(60000).default(15000),
  WS_MODE: z.enum(["passthrough", "soniox"]).default("soniox"),
  SCRIBE_ENABLED: boolFromEnv(true),
  SCRIBE_HOST: z.string().default("api.elevenlabs.io"),
  SCRIBE_PATH: z.string().default("/v1/speech-to-text/realtime"),
  SCRIBE_VOICE_MODEL_ID: z.string().default("sw-elevenlabs-scribe"),
  SCRIBE_MODEL: z.string().default("scribe_v2_realtime"),
  SCRIBE_VAD_TUNING: boolFromEnv(true),
  SCRIBE_VAD_SILENCE_THRESHOLD_SECS: z.coerce.number().min(0.192).max(3).default(1),
  SCRIBE_VAD_THRESHOLD: z.coerce.number().min(0.1).max(0.9).default(0.4),
  SCRIBE_MIN_SPEECH_DURATION_MS: z.coerce.number().int().min(50).max(2000).default(100),
  SCRIBE_MIN_SILENCE_DURATION_MS: z.coerce.number().int().min(50).max(2000).default(100),
  PROXY_ALLOWED_HOSTS: z
    .string()
    .default("api.superwhisper.com,api.deepgram.com,api.elevenlabs.io,api.soniox.com"),
  ALLOW_TARGET_WS_PASSTHROUGH: boolFromEnv(false),
  WS_CLOSE_DELAY_MS: z.coerce.number().int().min(0).max(5000).default(350),
  SONIOX_LANGUAGE_HINTS: z.string().default("ru,en"),
  SONIOX_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  CERT_DIR: z.string().default(join(process.cwd(), "certs")),
  LOG_DIR: z.string().default(join(process.cwd(), "logs")),
  PAC_PATH: z.string().default(join(process.cwd(), "logs", "proxy.pac")),
  TEMPLATE_PATH: z
    .string()
    .default(join(process.cwd(), "fixtures", "superwhisper-response.template.json")),
  CAPTURE_PATH: z
    .string()
    .default(join(process.cwd(), "fixtures", "recon-capture.json")),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  sonioxApiKey: string | null;
};

function readKeychainKey(): string | null {
  try {
    const out = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", "soniox-proxy", "-a", "SONIOX_API_KEY", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

function readKeyFile(): string | null {
  const path = join(homedir(), ".config", "soniox-proxy", "api-key");
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      throw new Error(
        `Refusing to use ${path}: permissions ${mode.toString(8)} expose the key. Run chmod 600.`,
      );
    }
    return readFileSync(path, "utf8").trim() || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  return {
    ...parsed,
    sonioxApiKey: env.SONIOX_API_KEY?.trim() || readKeychainKey() || readKeyFile(),
  };
}

export function languageHints(config: AppConfig): string[] {
  return config.SONIOX_LANGUAGE_HINTS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
