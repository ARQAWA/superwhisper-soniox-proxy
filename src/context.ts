import { readFileSync } from "node:fs";
import type { TranscriptionContext } from "@soniox/node";
import type { AppConfig } from "./config.js";
import { errorLabel } from "./errors.js";
import type { Logger } from "./logger.js";

const TEXT_MAX_CHARS = 8000;
const TERMS_MAX = 200;
const TERM_MAX_CHARS = 80;
const GENERAL_MAX = 8;
const SCRIBE_KEYTERMS_MAX = 50;
const SCRIBE_KEYTERM_MAX_CHARS = 20;

function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxChars);
}

function cleanTerms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const term = item.trim();
    if (!term || term.length > TERM_MAX_CHARS) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= TERMS_MAX) break;
  }
  return terms;
}

function cleanGeneral(value: unknown): NonNullable<TranscriptionContext["general"]> {
  if (!Array.isArray(value)) return [];
  const out: NonNullable<TranscriptionContext["general"]> = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.key !== "string" || typeof entry.value !== "string") continue;
    const key = entry.key.trim();
    const text = entry.value.trim();
    if (!key || !text || key.length > 80 || text.length > 200) continue;
    const dedupeKey = `${key}\u0000${text}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ key, value: text });
    if (out.length >= GENERAL_MAX) break;
  }
  return out;
}

export function parseContext(value: unknown): TranscriptionContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const general = cleanGeneral(source.general);
  const text = cleanText(source.text, TEXT_MAX_CHARS);
  const terms = cleanTerms(source.terms);
  if (general.length === 0 && !text && terms.length === 0) return null;
  return {
    ...(general.length > 0 ? { general } : {}),
    ...(text ? { text } : {}),
    ...(terms.length > 0 ? { terms } : {}),
  };
}

export function mergeContexts(
  ...contexts: Array<TranscriptionContext | null | undefined>
): TranscriptionContext | null {
  const general: NonNullable<TranscriptionContext["general"]> = [];
  const generalSeen = new Set<string>();
  const terms: string[] = [];
  const termSeen = new Set<string>();
  const textParts: string[] = [];
  const textSeen = new Set<string>();

  for (const context of contexts) {
    if (!context) continue;
    for (const entry of context.general ?? []) {
      const key = `${entry.key}\u0000${entry.value}`;
      if (generalSeen.has(key) || general.length >= GENERAL_MAX) continue;
      generalSeen.add(key);
      general.push(entry);
    }
    for (const term of context.terms ?? []) {
      const key = term.toLocaleLowerCase();
      if (termSeen.has(key) || terms.length >= TERMS_MAX) continue;
      termSeen.add(key);
      terms.push(term);
    }
    const text = context.text?.trim();
    if (text) {
      const key = text.toLocaleLowerCase();
      if (!textSeen.has(key)) {
        textSeen.add(key);
        textParts.push(text);
      }
    }
  }

  const text = textParts.join("\n\n").slice(0, TEXT_MAX_CHARS);
  if (general.length === 0 && !text && terms.length === 0) return null;
  return {
    ...(general.length > 0 ? { general } : {}),
    ...(text ? { text } : {}),
    ...(terms.length > 0 ? { terms } : {}),
  };
}

export function contextFromEnv(text: string, terms: string): TranscriptionContext | null {
  const termList = terms
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);
  return parseContext({ text, terms: termList });
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
  parts.push(contextFromEnv(config.SONIOX_CONTEXT_TEXT, config.SONIOX_CONTEXT_TERMS));
  return mergeContexts(...parts);
}

export function contextSummary(context: TranscriptionContext | null): {
  general: number;
  terms: number;
  text_chars: number;
} {
  return {
    general: context?.general?.length ?? 0,
    terms: context?.terms?.length ?? 0,
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

export function scribeKeyterms(context: TranscriptionContext | null, existing: string[]): string[] {
  if (!context?.terms?.length) return [];
  const seen = new Set(existing.map((term) => term.toLocaleLowerCase()));
  const out: string[] = [];
  for (const term of context.terms) {
    if (term.length > SCRIBE_KEYTERM_MAX_CHARS) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= SCRIBE_KEYTERMS_MAX) break;
  }
  return out;
}
