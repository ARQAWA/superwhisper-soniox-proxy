import { randomUUID } from "node:crypto";
import { SonioxNodeClient } from "@soniox/node";
import type { RealtimeSttSession } from "@soniox/node";
import type { TranscriptToken } from "@soniox/node";
import type { AppConfig } from "./config.js";
import { languageHints } from "./config.js";
import type { Logger } from "./logger.js";
import type { ParsedFile } from "./types.js";

export interface SonioxResult {
  text: string;
  tokens: TranscriptToken[];
  durationMs: number;
  transcriptionId: string;
  clientReferenceId: string;
  language: string;
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

function languageFromRequest(fields: Record<string, string>): { hints: string[]; identify: boolean; language: string } {
  const raw = (fields.language ?? fields.language_code ?? fields.languageCode ?? "").trim().toLowerCase();
  if (!raw || raw === "auto" || raw === "multi" || raw === "und") {
    return { hints: ["ru", "en"], identify: true, language: "auto" };
  }
  const first = raw.split(/[-_,]/)[0];
  if (/^[a-z]{2,3}$/.test(first)) {
    return { hints: [first], identify: first !== "ru" && first !== "en", language: first };
  }
  return { hints: ["ru", "en"], identify: true, language: "auto" };
}

export class SonioxService {
  private readonly client: SonioxNodeClient;
  private readonly semaphore: Semaphore;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    if (!config.sonioxApiKey) {
      throw new Error("SONIOX_API_KEY is not configured (env, Keychain, or ~/.config/soniox-proxy/api-key)");
    }
    this.client = new SonioxNodeClient({ api_key: config.sonioxApiKey });
    this.semaphore = new Semaphore(config.SONIOX_MAX_CONCURRENCY);
  }

  createRealtimeSession(options: {
    languageHints: string[];
    identifyLanguage: boolean;
    sampleRate: number;
    channels: number;
    diarize: boolean;
    endpointDetection?: boolean;
  }): RealtimeSttSession {
    return this.client.realtime.stt({
      model: this.config.SONIOX_REALTIME_MODEL,
      audio_format: "pcm_s16le",
      sample_rate: options.sampleRate,
      num_channels: options.channels,
      language_hints: options.languageHints,
      enable_language_identification: options.identifyLanguage,
      enable_speaker_diarization: options.diarize,
      enable_endpoint_detection: options.endpointDetection ?? true,
    });
  }

  async transcribe(
    file: ParsedFile,
    fields: Record<string, string>,
    requestId: string,
    diarize: boolean,
  ): Promise<SonioxResult> {
    const audio = normalizeAudio(file, fields);
    const lang = languageFromRequest(fields);
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
        language_hints: lang.hints,
        enable_language_identification: lang.identify,
        enable_speaker_diarization: diarize,
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
        },
        "soniox transcription completed",
      );
      return {
        text: transcript.text,
        tokens: transcript.tokens,
        durationMs,
        transcriptionId: transcription.id,
        clientReferenceId,
        language: transcript.tokens.find((t) => t.language)?.language ?? lang.language,
      };
    } catch (err) {
      this.logger.error(
        {
          request_id: requestId,
          client_reference_id: clientReferenceId,
          audio_bytes: audio.data.length,
          latency_ms: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        },
        "soniox transcription failed",
      );
      throw err;
    } finally {
      this.semaphore.release();
    }
  }
}
