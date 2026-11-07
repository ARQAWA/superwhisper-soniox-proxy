import { readFileSync } from "node:fs";
import type { TranscriptToken } from "@soniox/node";
import { mergeTokensToWords } from "./tokens.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function sanitizeForTemplate(value: unknown, depth = 0): unknown {
  if (depth > 30) return null;
  if (value === null) return null;
  if (typeof value === "string") return "";
  if (typeof value === "number") return 0;
  if (typeof value === "boolean") return false;
  if (Array.isArray(value)) {
    return value.length > 0 ? [sanitizeForTemplate(value[0], depth + 1)] : [];
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeForTemplate(child, depth + 1);
    }
    return out;
  }
  return null;
}

export function describeSchema(value: unknown, prefix = "", depth = 0): string[] {
  if (depth > 8) return [`${prefix}: ...`];
  if (value === null) return [`${prefix}: null`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}: array<empty>`];
    return [`${prefix}: array`, ...describeSchema(value[0], `${prefix}[]`, depth + 1)];
  }
  if (typeof value === "object") {
    const lines: string[] = [`${prefix}: object`];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      lines.push(...describeSchema(child, prefix ? `${prefix}.${key}` : key, depth + 1));
    }
    return lines;
  }
  return [`${prefix}: ${typeof value}`];
}

export function loadTemplate(path: string): JsonValue {
  return JSON.parse(readFileSync(path, "utf8")) as JsonValue;
}

function setIfPresent(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (Object.prototype.hasOwnProperty.call(obj, key)) obj[key] = value;
}

export interface RenderInput {
  template: JsonValue;
  text: string;
  tokens: TranscriptToken[];
  durationSeconds: number;
  requestId: string;
  language: string;
}

export function renderDeepgramLikeResponse(input: RenderInput): JsonValue {
  const root = structuredClone(input.template) as Record<string, unknown>;
  const results = root.results as Record<string, unknown> | undefined;
  const channels = results?.channels as Array<Record<string, unknown>> | undefined;
  const alternatives = channels?.[0]?.alternatives as Array<Record<string, unknown>> | undefined;
  const alt = alternatives?.[0];
  if (!alt) throw new Error("template does not contain results.channels[0].alternatives[0]");

  setIfPresent(alt, "transcript", input.text);
  const templateWords = (alt.words as Array<Record<string, unknown>> | undefined) ?? [];
  const wordTemplate = templateWords[0] ?? {};
  const sourceTokens = input.tokens.filter((t) => (t.translation_status ?? "none") !== "translation");
  const language = sourceTokens.find((t) => t.language)?.language ?? input.language;
  const mappedWords = mergeTokensToWords(sourceTokens).map((merged) => {
    const word: Record<string, unknown> = { ...wordTemplate };
    setIfPresent(word, "word", merged.word);
    setIfPresent(word, "punctuated_word", merged.punctuated_word);
    setIfPresent(word, "start", merged.start);
    setIfPresent(word, "end", merged.end);
    setIfPresent(word, "confidence", merged.confidence);
    setIfPresent(word, "speaker", merged.speaker ?? 0);
    setIfPresent(word, "language", language);
    return word;
  });
  alt.words = mappedWords;

  const paragraphs = alt.paragraphs as Record<string, unknown> | undefined;
  if (paragraphs) {
    setIfPresent(paragraphs, "transcript", input.text);
    const paragraphList = paragraphs.paragraphs as Array<Record<string, unknown>> | undefined;
    if (paragraphList) {
      const paragraphTemplate = paragraphList[0] ?? {};
      const paragraph: Record<string, unknown> = { ...paragraphTemplate };
      setIfPresent(paragraph, "num_words", mappedWords.length);
      setIfPresent(paragraph, "start", 0);
      setIfPresent(paragraph, "end", input.durationSeconds);
      const sentences = paragraph.sentences as Array<Record<string, unknown>> | undefined;
      if (sentences) {
        const sentenceTemplate = sentences[0] ?? {};
        const sentence: Record<string, unknown> = { ...sentenceTemplate };
        setIfPresent(sentence, "text", input.text);
        setIfPresent(sentence, "start", 0);
        setIfPresent(sentence, "end", input.durationSeconds);
        paragraph.sentences = [sentence];
      }
      paragraphs.paragraphs = [paragraph];
    }
  }

  if (typeof alt.confidence !== "number" || input.tokens.length === 0) {
    setIfPresent(alt, "confidence", 0);
  } else {
    setIfPresent(
      alt,
      "confidence",
      input.tokens.reduce((sum, t) => sum + (t.confidence ?? 0), 0) / input.tokens.length,
    );
  }

  const metadata = root.metadata as Record<string, unknown> | undefined;
  if (metadata) {
    setIfPresent(metadata, "duration", input.durationSeconds);
    setIfPresent(metadata, "channels", 1);
    setIfPresent(metadata, "request_id", input.requestId);
    setIfPresent(metadata, "created", new Date().toISOString());
    setIfPresent(metadata, "language", input.language);
  }

  const topLevelDuration = root.audio_duration_secs;
  if (typeof topLevelDuration === "number") root.audio_duration_secs = input.durationSeconds;

  return root as JsonValue;
}
