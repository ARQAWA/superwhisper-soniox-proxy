import {
  appendFileSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { errorLabel } from "./errors.js";
import type { Logger } from "./logger.js";

const SUMMARY_ROTATE_BYTES = 8 * 1024 * 1024;
const MAX_TRACE_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_FILES = 2000;

export interface DiagnosticsOptions {
  enabled: boolean;
  dir: string;
  retentionDays: number;
  audioGapMs: number;
  resultGapMs: number;
  audioLagMs: number;
  closeTimeoutMs: number;
}

type JsonRecord = Record<string, unknown>;
type Severity = "warn" | "error";

export function diagnosticsOptionsFromConfig(config: AppConfig): DiagnosticsOptions {
  return {
    enabled: config.DIAG_ENABLED,
    dir: config.DIAG_DIR,
    retentionDays: config.DIAG_RETENTION_DAYS,
    audioGapMs: config.DIAG_AUDIO_GAP_MS,
    resultGapMs: config.DIAG_RESULT_GAP_MS,
    audioLagMs: config.DIAG_AUDIO_LAG_MS,
    closeTimeoutMs: config.DIAG_CLOSE_TIMEOUT_MS,
  };
}

export interface RealtimeStartMeta {
  model: string;
  queryModel: string | null;
  sampleRate: number;
  channels: number;
  language: string;
  identifyLanguage: boolean;
  diarize: boolean;
  endpointDetection: boolean;
  sonioxModel: string;
  closeDelayMs: number;
}

export interface RealtimeResultSnapshot {
  tokens: number;
  finalTokens: number;
  tailTokens: number;
  newFinalTokens: number;
  totalAudioProcMs: number;
  finalAudioProcMs: number;
  windowStartMs: number | null;
  windowEndMs: number | null;
  finished: boolean;
  textLength: number | null;
}

/**
 * Per-stream diagnostic trace. Writes one JSONL file per WebSocket session and
 * a compact summary line. Never receives audio, transcript text, tokens, keys,
 * Authorization headers, or cookies: only sizes, counts, timings, and codes.
 */
export class SessionTrace {
  private readonly startedAt = Date.now();
  private readonly startedIso = new Date(this.startedAt).toISOString();
  private readonly filePath: string | null;
  private ended = false;
  private traceBytes = 0;
  private traceTruncated = false;

  private audioFrames = 0;
  private audioBytes = 0;
  private firstAudioAt: number | null = null;
  private lastAudioAt: number | null = null;
  private lastFrameAt: number | null = null;
  private firstAudioIso: string | null = null;
  private lastAudioIso: string | null = null;
  private maxAudioGapMs = 0;
  private audioTickFrames = 0;
  private audioTickBytes = 0;
  private bytesPerSecond = 0;
  private readonly audioTimer: NodeJS.Timeout | undefined;

  private resultCount = 0;
  private lastResultAt: number | null = null;
  private maxResultGapMs = 0;
  private maxTotalAudioProcMs = 0;
  private audioLagFlagged = false;
  private lastTextLength = 0;
  private maxInterimLength = 0;

  private connectedAt: number | null = null;
  private connectFailedFlag = false;
  private fatalErrorFlag = false;
  private closeStreamAt: number | null = null;
  private closeTextLength: number | null = null;
  private finishRequestedAt: number | null = null;
  private finishedAt: number | null = null;
  private finalSentFlag = false;
  private finalTextLength: number | null = null;
  private clientCloseAt: number | null = null;
  private clientCloseCode: number | null = null;
  private safetyNetFlag = false;
  private prefixMs = 0;
  private prefixTokenCount = 0;
  private prefixTextLength = 0;
  private prefixLatencyMs: number | null = null;
  private prefixReady = false;
  private prefixFailedFlag = false;

  constructor(
    private readonly options: DiagnosticsOptions,
    private readonly logger: Logger,
    private readonly kind: "realtime" | "batch",
    private readonly requestId: string,
    private readonly appendSummary: (record: JsonRecord) => void,
    private readonly appendAnomaly: (record: JsonRecord) => void,
    filePath: string | null,
  ) {
    this.filePath = filePath;
    if (this.filePath) {
      this.audioTimer = setInterval(() => this.flushAudioStats(), 2000);
      this.audioTimer.unref?.();
    } else {
      this.audioTimer = undefined;
    }
  }

  event(name: string, data: JsonRecord = {}): void {
    if (!this.filePath || this.ended) return;
    if (this.traceBytes > MAX_TRACE_BYTES) {
      if (!this.traceTruncated) {
        this.traceTruncated = true;
        this.write({ reason: "max_trace_bytes", bytes: this.traceBytes }, "trace_truncated");
      }
      return;
    }
    this.write(data, name);
  }

  private write(data: JsonRecord, event: string): void {
    if (!this.filePath) return;
    try {
      const line = JSON.stringify({
        ...data,
        t: new Date().toISOString(),
        elapsed_ms: Date.now() - this.startedAt,
        event,
      });
      appendFileSync(this.filePath, line + "\n", { mode: 0o600 });
      this.traceBytes += Buffer.byteLength(line) + 1;
    } catch {
      // Diagnostics must never break the audio path.
    }
  }

  private flushAudioStats(): void {
    if (this.ended || this.audioFrames === this.audioTickFrames) return;
    this.event("audio_stats", {
      frames: this.audioFrames,
      bytes: this.audioBytes,
      window_frames: this.audioFrames - this.audioTickFrames,
      window_bytes: this.audioBytes - this.audioTickBytes,
      last_frame_age_ms: this.lastAudioAt === null ? null : Date.now() - this.lastAudioAt,
    });
    this.audioTickFrames = this.audioFrames;
    this.audioTickBytes = this.audioBytes;
  }

  start(meta: RealtimeStartMeta): void {
    this.bytesPerSecond = meta.sampleRate * meta.channels * 2;
    this.event("stream_start", {
      model: meta.model,
      query_model: meta.queryModel,
      sample_rate: meta.sampleRate,
      channels: meta.channels,
      language: meta.language,
      identify_language: meta.identifyLanguage,
      diarize: meta.diarize,
      endpoint_detection: meta.endpointDetection,
      soniox_model: meta.sonioxModel,
      close_delay_ms: meta.closeDelayMs,
    });
  }

  audioFrame(bytes: number, now = Date.now()): void {
    this.audioFrames += 1;
    this.audioBytes += bytes;
    if (this.firstAudioAt === null) {
      this.firstAudioAt = now;
      this.firstAudioIso = new Date(now).toISOString();
      this.lastFrameAt = now;
      this.lastAudioAt = now;
      this.lastAudioIso = new Date(now).toISOString();
      this.event("audio_start", { bytes, frames: this.audioFrames });
      return;
    }
    const gap = this.lastFrameAt === null ? 0 : now - this.lastFrameAt;
    if (gap > this.maxAudioGapMs) this.maxAudioGapMs = gap;
    if (gap > this.options.audioGapMs) {
      this.event("audio_gap", {
        gap_ms: gap,
        frames: this.audioFrames,
        bytes: this.audioBytes,
      });
    }
    this.lastFrameAt = now;
    this.lastAudioAt = now;
    this.lastAudioIso = new Date(now).toISOString();
  }

  clientControl(type: string): void {
    this.event("client_control", { type });
  }

  connectFailed(message: string): void {
    this.connectFailedFlag = true;
    this.event("soniox_connect_failed", { error: truncate(message) });
  }

  connected(connectMs: number): void {
    this.connectedAt = Date.now();
    this.event("soniox_connected", { connect_ms: connectMs });
  }

  prefixBatchStarted(info: { connectMs: number; prefixMs: number; bytes: number }): void {
    this.prefixMs = info.prefixMs;
    this.event("prefix_batch_started", {
      connect_ms: info.connectMs,
      prefix_ms: info.prefixMs,
      bytes: info.bytes,
    });
  }

  prefixBatchReady(info: { tokens: number; textLength: number; latencyMs: number }): void {
    this.prefixReady = true;
    this.prefixTokenCount = info.tokens;
    this.prefixTextLength = info.textLength;
    this.prefixLatencyMs = info.latencyMs;
    this.event("prefix_batch_ready", {
      prefix_ms: this.prefixMs,
      tokens: info.tokens,
      text_length: info.textLength,
      latency_ms: info.latencyMs,
    });
  }

  prefixBatchFailed(message: string): void {
    this.prefixFailedFlag = true;
    this.event("prefix_batch_failed", { error: truncate(message) });
    this.anomaly("prefix_batch_failed", { error: truncate(message) }, "error");
  }

  prefixMissingAtFinal(): void {
    this.anomaly("prefix_missing_at_final", {
      prefix_ms: this.prefixMs,
      prefix_ready: this.prefixReady,
      prefix_failed: this.prefixFailedFlag,
      prefix_latency_ms: this.prefixLatencyMs,
    });
  }

  result(snapshot: RealtimeResultSnapshot): void {
    const now = Date.now();
    const gap = this.lastResultAt === null ? null : now - this.lastResultAt;
    this.resultCount += 1;
    if (gap !== null && gap > this.maxResultGapMs) {
      this.maxResultGapMs = gap;
      if (gap > this.options.resultGapMs) {
        this.event("result_gap", { gap_ms: gap, results: this.resultCount });
      }
    }
    this.lastResultAt = now;
    if (snapshot.totalAudioProcMs > this.maxTotalAudioProcMs) {
      this.maxTotalAudioProcMs = snapshot.totalAudioProcMs;
    }
    if (typeof snapshot.textLength === "number" && snapshot.textLength > 0) {
      this.lastTextLength = snapshot.textLength;
    }
    this.event("soniox_result", {
      tokens: snapshot.tokens,
      final_tokens: snapshot.finalTokens,
      tail_tokens: snapshot.tailTokens,
      new_final_tokens: snapshot.newFinalTokens,
      total_audio_proc_ms: snapshot.totalAudioProcMs,
      final_audio_proc_ms: snapshot.finalAudioProcMs,
      window_start_ms: snapshot.windowStartMs,
      window_end_ms: snapshot.windowEndMs,
      finished: snapshot.finished,
      text_length: snapshot.textLength,
      since_last_result_ms: gap,
      accumulated_text_length: this.lastTextLength,
    });
  }

  finalized(finalTokens: number, tailTokens: number): void {
    this.event("soniox_finalized", {
      results: this.resultCount,
      final_tokens: finalTokens,
      tail_tokens: tailTokens,
      text_length: this.lastTextLength,
    });
  }

  endpoint(): void {
    this.event("soniox_endpoint", { results: this.resultCount, text_length: this.lastTextLength });
  }

  interimSent(textLength: number): void {
    if (textLength > this.maxInterimLength) this.maxInterimLength = textLength;
  }

  closeStream(info: { finalTokens: number; tailTokens: number; textLength: number }): void {
    this.closeStreamAt = Date.now();
    this.closeTextLength = info.textLength;
    this.checkAudioLag("close_stream");
    this.event("close_stream", {
      final_tokens: info.finalTokens,
      tail_tokens: info.tailTokens,
      text_length: info.textLength,
      audio_frames: this.audioFrames,
      audio_bytes: this.audioBytes,
      max_audio_gap_ms: this.maxAudioGapMs,
      results: this.resultCount,
      total_audio_proc_ms: this.maxTotalAudioProcMs,
      audio_proc_shortfall_ms: this.audioProcShortfallMs(),
    });
  }

  finishRequested(): void {
    this.finishRequestedAt = Date.now();
    this.event("finish_requested", {
      close_to_finish_request_ms:
        this.closeStreamAt === null ? null : this.finishRequestedAt - this.closeStreamAt,
    });
  }

  finishFailed(message: string): void {
    this.event("finish_failed", { error: truncate(message) });
  }

  finished(info: { finalTokens: number; tailTokens: number; totalAudioProcMs: number }): void {
    this.finishedAt = Date.now();
    this.checkAudioLag("finished");
    const closeToFinish =
      this.closeStreamAt === null ? null : this.finishedAt - this.closeStreamAt;
    if (this.closeStreamAt === null) {
      this.anomaly("finished_without_close_stream", {
        total_audio_proc_ms: info.totalAudioProcMs,
        final_tokens: info.finalTokens,
      });
    } else if (closeToFinish !== null && closeToFinish > this.options.closeTimeoutMs) {
      this.anomaly("slow_finalize", {
        close_to_finish_ms: closeToFinish,
        threshold_ms: this.options.closeTimeoutMs,
        final_tokens: info.finalTokens,
        wait_requested_ms:
          this.finishRequestedAt === null ? null : this.finishedAt - this.finishRequestedAt,
      });
    }
    this.event("soniox_finished", {
      final_tokens: info.finalTokens,
      tail_tokens: info.tailTokens,
      total_audio_proc_ms: info.totalAudioProcMs,
      close_to_finish_ms: closeToFinish,
      results: this.resultCount,
    });
  }

  finalSent(info: {
    finalTextLength: number;
    finalTokens: number;
    tailTokens: number;
    maxInterimLength: number;
    clientOpen: boolean;
    delivered: boolean;
    safetyNet: boolean;
    empty: boolean;
  }): void {
    this.finalTextLength = info.finalTextLength;
    if (info.delivered) this.finalSentFlag = true;
    if (info.delivered && info.maxInterimLength > info.finalTextLength) {
      this.anomaly("final_shorter_than_interim", {
        final_text_length: info.finalTextLength,
        max_interim_length: info.maxInterimLength,
        final_tokens: info.finalTokens,
        tail_tokens: info.tailTokens,
      });
    }
    this.event("final_result_sent", {
      final_text_length: info.finalTextLength,
      final_tokens: info.finalTokens,
      tail_tokens: info.tailTokens,
      max_interim_length: info.maxInterimLength,
      client_open: info.clientOpen,
      delivered: info.delivered,
      safety_net: info.safetyNet,
      empty: info.empty,
      close_to_final_ms: this.closeStreamAt === null ? null : Date.now() - this.closeStreamAt,
    });
  }

  clientClosed(info: {
    code: number;
    reasonLength: number;
    lostTextLength: number | null;
    finalTokens: number;
    tailTokens: number;
  }): void {
    if (this.ended) return;
    this.clientCloseAt = Date.now();
    this.clientCloseCode = info.code;
    const waited = this.closeStreamAt === null ? null : this.clientCloseAt - this.closeStreamAt;
    this.event("client_close", {
      code: info.code,
      reason_length: info.reasonLength,
      had_close_stream: this.closeStreamAt !== null,
      final_sent: this.finalSentFlag,
      finished: this.finishedAt !== null,
      waited_from_close_ms: waited,
      lost_text_length: info.lostTextLength,
      final_tokens: info.finalTokens,
      tail_tokens: info.tailTokens,
      audio_frames: this.audioFrames,
    });
    if (this.closeStreamAt !== null && !this.finalSentFlag) {
      this.anomaly("client_closed_before_final", {
        client_close_code: info.code,
        waited_from_close_ms: waited,
        lost_text_length: info.lostTextLength,
        close_text_length: this.closeTextLength,
        final_tokens: info.finalTokens,
        tail_tokens: info.tailTokens,
        finished: this.finishedAt !== null,
      });
    }
    if (this.closeStreamAt !== null && this.finishedAt === null) {
      this.anomaly("close_without_finished", {
        client_close_code: info.code,
        waited_from_close_ms: waited,
        final_tokens: info.finalTokens,
        tail_tokens: info.tailTokens,
      });
    }
  }

  error(message: string, fatal: boolean): void {
    if (this.ended) return;
    this.fatalErrorFlag = true;
    this.event("soniox_error", { error: truncate(message), fatal });
    this.anomaly("soniox_error", { error: truncate(message), fatal }, "error");
  }

  safetyNet(info: JsonRecord): void {
    this.safetyNetFlag = true;
    this.anomaly("finalize_safety_net", info);
  }

  anomaly(code: string, details: JsonRecord = {}, severity: Severity = "warn"): void {
    if (this.ended) return;
    const record = {
      at: new Date().toISOString(),
      kind: this.kind,
      request_id: this.requestId,
      code,
      severity,
      ...details,
    };
    this.event("anomaly", { code, severity, ...details });
    this.appendAnomaly(record);
    const level = severity === "error" ? "error" : "warn";
    this.logger[level](
      { request_id: this.requestId, diag: true, code, ...details },
      "diagnostic anomaly",
    );
  }

  end(explicitStatus?: string): void {
    if (this.ended) return;
    const record = this.summary(explicitStatus);
    this.event("stream_end", record);
    this.ended = true;
    clearInterval(this.audioTimer);
    this.appendSummary(record);
  }

  private audioProcShortfallMs(): number | null {
    if (this.bytesPerSecond <= 0) return null;
    return Math.round((this.audioBytes / this.bytesPerSecond) * 1000 - this.maxTotalAudioProcMs);
  }

  private checkAudioLag(stage: string): void {
    if (this.audioLagFlagged) return;
    const shortfall = this.audioProcShortfallMs();
    if (shortfall === null || shortfall <= this.options.audioLagMs) return;
    this.audioLagFlagged = true;
    this.anomaly("soniox_audio_lag", {
      stage,
      expected_audio_ms: Math.round((this.audioBytes / this.bytesPerSecond) * 1000),
      processed_audio_ms: this.maxTotalAudioProcMs,
      shortfall_ms: shortfall,
      threshold_ms: this.options.audioLagMs,
      results: this.resultCount,
    });
  }

  private summary(explicitStatus?: string): JsonRecord {
    const endedAt = Date.now();
    let status = explicitStatus;
    if (!status) {
      if (this.connectFailedFlag) status = "connect_failed";
      else if (this.fatalErrorFlag) status = "error";
      else if (this.finalSentFlag) {
        status = this.safetyNetFlag ? "final_sent_after_safety_net" : "ok";
      } else if (this.finishedAt !== null) status = "finished_without_final";
      else if (this.closeStreamAt !== null) status = "client_closed_before_final";
      else if (this.clientCloseAt !== null) status = "aborted";
      else status = "open";
    }
    return {
      kind: this.kind,
      request_id: this.requestId,
      status,
      started_at: this.startedIso,
      ended_at: new Date(endedAt).toISOString(),
      duration_ms: endedAt - this.startedAt,
      connected: this.connectedAt !== null,
      connect_failed: this.connectFailedFlag,
      audio_frames: this.audioFrames,
      audio_bytes: this.audioBytes,
      audio_seconds:
        this.bytesPerSecond > 0
          ? Math.round((this.audioBytes / this.bytesPerSecond) * 100) / 100
          : null,
      first_audio_at: this.firstAudioIso,
      last_audio_at: this.lastAudioIso,
      max_audio_gap_ms: this.maxAudioGapMs,
      results: this.resultCount,
      max_result_gap_ms: this.maxResultGapMs,
      max_total_audio_proc_ms: this.maxTotalAudioProcMs,
      audio_proc_shortfall_ms: this.audioProcShortfallMs(),
      prefix_batch: this.prefixMs > 0,
      prefix_ms: this.prefixMs,
      prefix_tokens: this.prefixTokenCount,
      prefix_text_length: this.prefixTextLength,
      prefix_latency_ms: this.prefixLatencyMs,
      prefix_ready: this.prefixReady,
      prefix_failed: this.prefixFailedFlag,
      close_stream: this.closeStreamAt !== null,
      close_text_length: this.closeTextLength,
      finish_requested: this.finishRequestedAt !== null,
      finished: this.finishedAt !== null,
      close_to_finish_ms:
        this.closeStreamAt === null || this.finishedAt === null ? null : this.finishedAt - this.closeStreamAt,
      final_sent: this.finalSentFlag,
      final_text_length: this.finalTextLength,
      max_interim_length: this.maxInterimLength,
      safety_net: this.safetyNetFlag,
      client_closed: this.clientCloseAt !== null,
      client_close_code: this.clientCloseCode,
      fatal_error: this.fatalErrorFlag,
      trace_truncated: this.traceTruncated,
    };
  }
}

export class Diagnostics {
  private readonly enabled: boolean;
  private readonly options: DiagnosticsOptions;
  private readonly sessionsDir: string;
  private readonly summaryPath: string;
  private readonly anomaliesPath: string;
  private summaryWrites = 0;
  private anomalyWrites = 0;

  constructor(options: DiagnosticsOptions, private readonly logger: Logger) {
    this.options = options;
    this.sessionsDir = join(options.dir, "sessions");
    this.summaryPath = join(options.dir, "summary.jsonl");
    this.anomaliesPath = join(options.dir, "anomalies.jsonl");
    this.enabled = options.enabled && this.prepare();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get dir(): string {
    return this.options.dir;
  }

  private prepare(): boolean {
    try {
      mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(this.options.dir, "meta.json"),
        JSON.stringify(
          {
            started_at: new Date().toISOString(),
            pid: process.pid,
            node: process.version,
            cwd: process.cwd(),
            diagnostics_dir: this.options.dir,
            retention_days: this.options.retentionDays,
            audio_gap_ms: this.options.audioGapMs,
            result_gap_ms: this.options.resultGapMs,
            close_timeout_ms: this.options.closeTimeoutMs,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      this.cleanup();
      return true;
    } catch (err) {
      this.logger.warn(
        { error: errorLabel(err), dir: this.options.dir },
        "diagnostics disabled: cannot create directory",
      );
      return false;
    }
  }

  startRealtime(requestId: string, meta: RealtimeStartMeta): SessionTrace {
    const filePath = this.enabled ? this.newTracePath("realtime", requestId) : null;
    const trace = new SessionTrace(
      this.options,
      this.logger,
      "realtime",
      requestId,
      (record) => this.appendSummary(record),
      (record) => this.appendAnomaly(record),
      filePath,
    );
    trace.start(meta);
    return trace;
  }

  recordBatch(record: JsonRecord): void {
    if (!this.enabled) return;
    this.appendSummary({
      kind: "batch",
      status: "ok",
      at: new Date().toISOString(),
      ...record,
    });
    if (record.status && record.status !== "ok") {
      this.appendAnomaly({
        at: new Date().toISOString(),
        kind: "batch",
        severity: "error",
        code: "batch_failed",
        ...record,
      });
    }
  }

  recordRequestParameters(provider: "soniox" | "scribe", parameters: unknown): void {
    try {
      mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
      const path = join(this.options.dir, "request-parameters.jsonl");
      const fd = openSync(
        path,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
      try {
        if (!fstatSync(fd).isFile()) throw new Error("request parameter log is not a regular file");
        fchmodSync(fd, 0o600);
        writeFileSync(
          fd,
          JSON.stringify({ at: new Date().toISOString(), provider, parameters }) + "\n",
        );
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      this.logger.warn({ error: errorLabel(err) }, "request parameter log unavailable");
    }
  }

  recordError(scope: string, error: unknown, details: JsonRecord = {}): void {
    if (!this.enabled) return;
    this.appendAnomaly({
      at: new Date().toISOString(),
      kind: "proxy",
      scope,
      severity: "error",
      code: "proxy_error",
      error: errorLabel(error),
      ...details,
    });
  }

  private newTracePath(kind: "realtime" | "batch", requestId: string): string | null {
    try {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const dayDir = join(this.sessionsDir, day);
      mkdirSync(dayDir, { recursive: true, mode: 0o700 });
      const stamp = now.toISOString().slice(11, 23).replace(/[:.]/g, "-");
      return join(dayDir, `${kind}-${stamp}-${requestId.slice(0, 8)}.jsonl`);
    } catch (err) {
      this.logger.warn(
        { error: errorLabel(err) },
        "diagnostics: cannot create session trace",
      );
      return null;
    }
  }

  private appendSummary(record: JsonRecord): void {
    if (!this.enabled) return;
    if (++this.summaryWrites % 200 === 0) this.rotate(this.summaryPath);
    this.append(this.summaryPath, record);
  }

  private appendAnomaly(record: JsonRecord): void {
    if (!this.enabled) return;
    if (++this.anomalyWrites % 200 === 0) this.rotate(this.anomaliesPath);
    this.append(this.anomaliesPath, record);
  }

  private append(path: string, record: JsonRecord): void {
    try {
      appendFileSync(path, JSON.stringify(record) + "\n", { mode: 0o600 });
    } catch {
      // Diagnostics must never break request handling.
    }
  }

  private rotate(path: string): void {
    try {
      if (statSync(path).size < SUMMARY_ROTATE_BYTES) return;
      const backup = `${path}.1`;
      rmSync(backup, { force: true });
      renameSync(path, backup);
    } catch {
      // Missing file or rename failure: keep appending.
    }
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.options.retentionDays * 86_400_000;
    const files: Array<{ path: string; mtime: number }> = [];
    let days: string[] = [];
    try {
      days = readdirSync(this.sessionsDir);
    } catch {
      return;
    }
    for (const day of days) {
      const dayDir = join(this.sessionsDir, day);
      let names: string[] = [];
      try {
        names = readdirSync(dayDir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(dayDir, name);
        try {
          files.push({ path, mtime: statSync(path).mtimeMs });
        } catch {
          // File disappeared.
        }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    for (let i = 0; i < files.length; i += 1) {
      if (i < MAX_SESSION_FILES && files[i].mtime >= cutoff) continue;
      try {
        rmSync(files[i].path, { force: true });
      } catch {
        // Best effort.
      }
    }
  }
}

function truncate(value: string, max = 300): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
