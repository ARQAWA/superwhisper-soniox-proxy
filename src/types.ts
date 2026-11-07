export interface ParsedFile {
  field: string;
  filename: string;
  mimeType: string;
  size: number;
  data: Buffer;
}

export interface ParsedMultipart {
  fields: Record<string, string>;
  fieldNames: string[];
  files: ParsedFile[];
  audio: ParsedFile | null;
}

export interface RequestMeta {
  host: string;
  method: string;
  path: string;
  query: string;
  contentType: string;
  contentLength: number;
}

export interface RequestSummary {
  host: string;
  method: string;
  path: string;
  query: string;
  contentType: string;
  contentLength: number;
  model: string | null;
  fieldNames: string[];
  files: Array<{ field: string; filename: string; mimeType: string; size: number }>;
  audioField: string | null;
  targetCandidate: boolean;
  targetMatched: boolean;
}

export interface UpstreamResponse {
  status: number;
  statusMessage: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}
