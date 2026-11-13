export const MAX_RETRIES = 10;
export const CONNECT_TIMEOUT_MS = 1000;
export const REALTIME_RETRY_TIMEOUT_MS = 5000;
export const FILE_ATTEMPT_TIMEOUT_MS = 5000;
export const FILE_TIMEOUT_MS = 22000;

export interface FileRetries {
  signal: AbortSignal;
  count: number;
}

export function isRetryable(error: unknown): boolean {
  const err = error as { status?: number; statusCode?: number; code?: string; message?: string } | null;
  const status = err?.statusCode ?? err?.status;
  if (status !== undefined) return status === 408 || status === 429 || (status >= 500 && status < 600);
  return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|connection_error|network_error|timeout)$/.test(err?.code ?? "") ||
    /opening handshake has timed out/i.test(err?.message ?? "");
}
