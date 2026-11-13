import { readFileSync } from "node:fs";
import type { TranscriptionContext } from "@soniox/node";
import type { AppConfig } from "./config.js";
import { errorLabel } from "./errors.js";
import type { Logger } from "./logger.js";

const TEXT_MAX_CHARS = 8000;

function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxChars);
}

/**
 * Recognition context is a free-text prompt only. Word and term lists are
 * deliberately dropped: provider term lists were rewriting ordinary words on
 * this setup, so the proxy no longer sends them.
 */
export function parseContext(value: unknown): TranscriptionContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const text = cleanText((value as Record<string, unknown>).text, TEXT_MAX_CHARS);
  return text ? { text } : null;
}

export function mergeContexts(
  ...contexts: Array<TranscriptionContext | null | undefined>
): TranscriptionContext | null {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const context of contexts) {
    const text = context?.text?.trim();
    if (!text) continue;
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(text);
  }
  const text = parts.join("\n\n").slice(0, TEXT_MAX_CHARS);
  return text ? { text } : null;
}

export function contextFromEnv(text: string): TranscriptionContext | null {
  return parseContext({ text });
}

export function loadContextFile(path: string): TranscriptionContext | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parseContext(JSON.parse(raw) as unknown);
}

export function configuredContext(config: AppConfig, logger?: Logger): TranscriptionContext | null {
  const parts: Array<TranscriptionContext | null> = [];
  if (config.SONIOX_CONTEXT_FILE) {
    try {
      parts.push(loadContextFile(config.SONIOX_CONTEXT_FILE));
    } catch (err) {
      logger?.warn(
        { path: config.SONIOX_CONTEXT_FILE, error: errorLabel(err) },
        "soniox context file ignored",
      );
    }
  }
  parts.push(contextFromEnv(config.SONIOX_CONTEXT_TEXT));
  return mergeContexts(...parts);
}

export function contextSummary(context: TranscriptionContext | null): {
  text_chars: number;
} {
  return {
    text_chars: context?.text?.length ?? 0,
  };
}

export function shouldUseStrictLanguage(
  hints: string[],
  identifyLanguage: boolean,
  enabled: boolean,
): boolean {
  return enabled && !identifyLanguage && hints.length === 1 && hints[0].trim().length > 0;
}
