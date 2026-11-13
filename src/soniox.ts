import { randomUUID } from "node:crypto";
import { FetchHttpClient, SonioxNodeClient } from "@soniox/node";
import type { RealtimeSttSession } from "@soniox/node";
import type { TranscriptToken, TranscriptionContext } from "@soniox/node";
import type { AppConfig } from "./config.js";
import {
  configuredContext,
  contextSummary,
  shouldUseStrictLanguage,
} from "./context.js";
import type { Diagnostics } from "./diagnostics.js";
import { errorLabel } from "./errors.js";
import { sonioxLanguagePolicy, type SonioxLanguagePolicy } from "./language.js";
import type { Logger } from "./logger.js";
import type { ParsedFile } from "./types.js";
import { createWarmFetch } from "./warmup.js";

export interface SonioxResult {
  text: string;
  tokens: TranscriptToken[];
  durationMs: number;
  transcriptionId: string;
  clientReferenceId: string;
  language: string;
}

function diagnosticParameters(
  parameters: Record<string, unknown>,
  context: TranscriptionContext | null,
): Record<string, unknown> {
  const { context: _context, ...rest } = parameters;
  return context ? { ...rest, context: contextSummary(context) } : rest;
}

export interface RecognitionSettingsInput {
  languageHints: string[];
  identifyLanguage: boolean;
  diarize: boolean;
}

export interface RecognitionSettings {
  language_hints?: string[];
  language_hints_strict?: boolean;
  enable_language_identification: boolean;
  enable_speaker_diarization: boolean;
  context?: TranscriptionContext;
}

/**
 * One recognition configuration for batch and realtime. Keeping it in one
 * place guarantees both paths ask Soniox for the same language policy,
 * diarization, and context instead of drifting apart.
 */
export function recognitionSettings(
  config: AppConfig,
  context: TranscriptionContext | null,
  input: RecognitionSettingsInput,
): RecognitionSettings {
  return {
    ...(input.languageHints.length > 0
      ? {
          language_hints: input.languageHints,
          language_hints_strict: shouldUseStrictLanguage(
            input.languageHints,
            input.identifyLanguage,
            config.SONIOX_LANGUAGE_HINTS_STRICT,
          ),
        }
      : {}),
    enable_language_identification: input.identifyLanguage,
    enable_speaker_diarization: input.diarize,
    ...(context ? { context } : {}),
  };
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

function pcmToWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function isRawPcm(file: ParsedFile, fields: Record<string, string>): boolean {
  const mime = file.mimeType.toLowerCase();
  const name = file.filename.toLowerCase();
  if (mime === "audio/l16" || mime === "audio/pcm" || mime === "audio/raw" || mime === "application/octet-stream") {
    if (name.endsWith(".pcm") || name.endsWith(".raw") || fields.encoding?.toLowerCase().includes("linear16")) return true;
  }
  return fields.encoding?.toLowerCase() === "linear16" && (name.endsWith(".pcm") || name.endsWith(".raw"));
}

function normalizeAudio(file: ParsedFile, fields: Record<string, string>): { data: Buffer; filename: string; contentType: string } {
  if (!isRawPcm(file, fields)) {
    return { data: file.data, filename: file.filename, contentType: file.mimeType };
  }
  const sampleRate = Number(fields.sample_rate ?? fields.sampleRate ?? 16000);
  const channels = Number(fields.channels ?? 1);
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 96000) {
    throw new Error(`unsupported PCM sample_rate: ${fields.sample_rate ?? "unknown"}`);
  }
  if (!Number.isFinite(channels) || channels < 1 || channels > 8) {
    throw new Error(`unsupported PCM channels: ${fields.channels ?? "unknown"}`);
  }
  return {
    data: pcmToWav(file.data, sampleRate, channels),
    filename: file.filename.replace(/\.(pcm|raw)$/i, "") + ".wav",
    contentType: "audio/wav",
  };
}

function languageFromRequest(
  fields: Record<string, string>,
  autoLanguage: string,
): SonioxLanguagePolicy {
  const raw = fields.language ?? fields.language_code ?? fields.languageCode ?? "";
  return sonioxLanguagePolicy(raw, autoLanguage);
}

export class SonioxService {
  private readonly client: SonioxNodeClient;
  private readonly semaphore: Semaphore;
  private readonly context: TranscriptionContext | null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly diagnostics?: Diagnostics,
  ) {
    if (!config.sonioxApiKey) {
      throw new Error("SONIOX_API_KEY is not configured (env, Keychain, or ~/.config/soniox-proxy/api-key)");
    }
    this.context = configuredContext(config, logger);
    if (this.context) {
      logger.info({ ...contextSummary(this.context) }, "soniox context loaded");
    }
    this.client = new SonioxNodeClient({
      api_key: config.sonioxApiKey,
      http_client: new FetchHttpClient({
        base_url: config.SONIOX_API_BASE_URL,
        default_headers: {
          Authorization: `Bearer ${config.sonioxApiKey}`,
          "Content-Type": "application/json",
        },
        fetch: createWarmFetch(config.SONIOX_API_BASE_URL),
      }),
    });
    this.semaphore = new Semaphore(config.SONIOX_MAX_CONCURRENCY);
  }

  contextInfo(): { text_chars: number } {
    return contextSummary(this.context);
  }

  createRealtimeSession(options: {
    languageHints: string[];
    identifyLanguage: boolean;
    sampleRate: number;
    channels: number;
    diarize: boolean;
    endpointDetection: boolean;
    endpointSensitivity: number;
    endpointLatencyAdjustmentLevel: number;
    maxEndpointDelayMs: number;
    clientReferenceId: string;
  }): RealtimeSttSession {
    const parameters = {
      model: this.config.SONIOX_REALTIME_MODEL,
      audio_format: "pcm_s16le" as const,
      sample_rate: options.sampleRate,
      num_channels: options.channels,
      ...recognitionSettings(this.config, this.context, {
        languageHints: options.languageHints,
        identifyLanguage: options.identifyLanguage,
        diarize: options.diarize,
      }),
      client_reference_id: options.clientReferenceId,
      enable_endpoint_detection: options.endpointDetection,
      ...(options.endpointDetection
        ? {
            endpoint_sensitivity: options.endpointSensitivity,
            endpoint_latency_adjustment_level: options.endpointLatencyAdjustmentLevel,
            max_endpoint_delay_ms: options.maxEndpointDelayMs,
          }
        : {}),
    };
    const session = this.client.realtime.stt(parameters);
    session.on("connected", () => {
      this.diagnostics?.recordRequestParameters(
        "soniox",
        diagnosticParameters(parameters, this.context),
      );
    });
    return session;
  }

  async transcribe(
    file: ParsedFile,
    fields: Record<string, string>,
    requestId: string,
    diarize: boolean,
    purpose = "request",
  ): Promise<SonioxResult> {
    const audio = normalizeAudio(file, fields);
    const lang = languageFromRequest(fields, this.config.SONIOX_AUTO_LANGUAGE);
    const clientReferenceId = `sw-${randomUUID()}`;
    await this.semaphore.acquire();
    const started = Date.now();
    try {
      const transcription = await this.client.stt.transcribe({
        model: this.config.SONIOX_MODEL,
        file: audio.data,
        filename: audio.filename,
        wait: true,
        cleanup: ["file", "transcription"],
        client_reference_id: clientReferenceId,
        ...recognitionSettings(this.config, this.context, {
          languageHints: lang.hints,
          identifyLanguage: lang.identify,
          diarize,
        }),
        fetch_transcript: true,
        timeout_ms: this.config.SONIOX_TIMEOUT_MS,
        wait_options: {
          timeout_ms: this.config.SONIOX_TIMEOUT_MS,
          interval_ms: 250,
        },
      });

      const transcript = transcription.transcript ?? (await transcription.getTranscript());
      if (!transcript) throw new Error("Soniox returned no transcript");
      const durationMs = transcription.audio_duration_ms ?? 0;
      this.logger.info(
        {
          request_id: requestId,
          client_reference_id: clientReferenceId,
          soniox_transcription_id: transcription.id,
          audio_bytes: audio.data.length,
          audio_duration_ms: durationMs,
          latency_ms: Date.now() - started,
          language: lang.language,
          purpose,
        },
        "soniox transcription completed",
      );
      this.diagnostics?.recordBatch({
        request_id: requestId,
        status: "ok",
        purpose,
        client_reference_id: clientReferenceId,
        soniox_transcription_id: transcription.id,
        audio_bytes: audio.data.length,
        audio_duration_ms: durationMs,
        latency_ms: Date.now() - started,
        language: lang.language,
      });
      return {
        text: transcript.text,
        tokens: transcript.tokens,
        durationMs,
        transcriptionId: transcription.id,
        clientReferenceId,
        language: transcript.tokens.find((t) => t.language)?.language ?? lang.language,
      };
    } catch (err) {
      const label = errorLabel(err);
      this.logger.error(
        {
          request_id: requestId,
          client_reference_id: clientReferenceId,
          audio_bytes: audio.data.length,
          latency_ms: Date.now() - started,
          error: label,
          purpose,
        },
        "soniox transcription failed",
      );
      this.diagnostics?.recordBatch({
        request_id: requestId,
        status: "error",
        purpose,
        client_reference_id: clientReferenceId,
        audio_bytes: audio.data.length,
        latency_ms: Date.now() - started,
        error: label,
      });
      throw err;
    } finally {
      this.semaphore.release();
    }
  }
}
