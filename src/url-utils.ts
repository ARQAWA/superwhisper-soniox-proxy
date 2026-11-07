const SAFE_QUERY_PARAMS = new Set([
  "alternatives",
  "channels",
  "diarize",
  "encoding",
  "endpointing",
  "filler_words",
  "interim_results",
  "language",
  "mip_opt_out",
  "model",
  "multichannel",
  "numerals",
  "paragraphs",
  "profanity_filter",
  "punctuate",
  "redact",
  "replace",
  "sample_rate",
  "search",
  "smart_format",
  "tag",
  "tier",
  "utterance_end_ms",
  "vad_events",
  "version",
]);

const SENSITIVE_QUERY_PARAMS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "context",
  "cookie",
  "key",
  "keyterm",
  "keyterms",
  "keywords",
  "password",
  "prompt",
  "secret",
  "text",
  "token",
]);

/**
 * Keep the diagnostic value of Deepgram's query parameters without writing
 * user-specific keywords, prompts, credentials, or free text into logs.
 */
export function redactQuery(url: URL): string {
  const parts: string[] = [];
  for (const [key, value] of url.searchParams) {
    const lower = key.toLowerCase();
    if (SENSITIVE_QUERY_PARAMS.has(lower)) {
      parts.push(`${key}=[REDACTED]`);
    } else if (SAFE_QUERY_PARAMS.has(lower)) {
      // Values for these parameters are protocol constants (booleans, language,
      // model names), never transcript content.
      parts.push(`${key}=${value}`);
    } else {
      parts.push(`${key}=[REDACTED]`);
    }
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}
