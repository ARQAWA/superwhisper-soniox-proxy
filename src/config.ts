import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const boolFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return defaultValue;
      return ["1", "true", "yes", "on"].includes(v.toLowerCase());
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
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60000),
  SONIOX_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60000),
  MAX_BODY_BYTES: z.coerce.number().int().min(1024).default(64 * 1024 * 1024),
  SONIOX_MODEL: z.string().default("stt-async-v6"),
  SONIOX_REALTIME_MODEL: z.string().default("stt-rt-v6"),
  WS_MODE: z.enum(["passthrough", "soniox"]).default("soniox"),
  ALLOW_TARGET_WS_PASSTHROUGH: boolFromEnv(false),
  WS_CLOSE_DELAY_MS: z.coerce.number().int().min(0).max(5000).default(350),
  SONIOX_LANGUAGE_HINTS: z.string().default("ru,en"),
  SONIOX_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  CERT_DIR: z.string().default(join(process.cwd(), "certs")),
  LOG_DIR: z.string().default(join(process.cwd(), "logs")),
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
