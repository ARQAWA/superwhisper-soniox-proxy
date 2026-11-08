export function errorLabel(error: unknown): string {
  if (!(error instanceof Error)) return "Error";
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Za-z0-9_.:-]{1,40}$/.test(code)) {
    return `${error.name || "Error"}:${code}`;
  }
  return error.name || "Error";
}
