import { describe, expect, it } from "vitest";
import { buildPac, hostMatchesAllowlist, parseAllowedHosts } from "../src/pac.js";

const defaults = parseAllowedHosts(
  "api.superwhisper.com,api.deepgram.com,api.elevenlabs.io,api.soniox.com",
);

function loadPac(content: string): (url: string, host: string) => string {
  return new Function(`${content}\nreturn FindProxyForURL;`)() as (
    url: string,
    host: string,
  ) => string;
}

describe("allowlist matching", () => {
  it("matches exact allowlisted hosts only", () => {
    for (const host of defaults) {
      expect(hostMatchesAllowlist(host, defaults)).toBe(true);
    }
    expect(hostMatchesAllowlist("example.com", defaults)).toBe(false);
    expect(hostMatchesAllowlist("api.deepgram.com.evil.test", defaults)).toBe(false);
    expect(hostMatchesAllowlist("notapi.deepgram.com", defaults)).toBe(false);
  });

  it("supports wildcard entries and normalizes case and trailing dots", () => {
    const allowed = parseAllowedHosts("*.soniox.com, API.ElevenLabs.IO. ");
    expect(hostMatchesAllowlist("wss.api.soniox.com", allowed)).toBe(true);
    expect(hostMatchesAllowlist("soniox.com", allowed)).toBe(false);
    expect(hostMatchesAllowlist("api.elevenlabs.io.", allowed)).toBe(true);
  });
});

describe("PAC generation", () => {
  const pac = buildPac({
    proxyHost: "127.0.0.1",
    proxyPort: 8443,
    allowedHosts: [...defaults, "*.example.test"],
  });
  const findProxy = loadPac(pac);

  it("sends allowlisted hosts through the local proxy", () => {
    for (const host of defaults) {
      expect(findProxy(`https://${host}/v1/listen`, host)).toBe(
        "PROXY 127.0.0.1:8443; DIRECT",
      );
    }
  });

  it("keeps unrelated hosts direct", () => {
    for (const host of ["example.com", "api.deepgram.com.evil.test", "google.com"]) {
      expect(findProxy(`https://${host}/`, host)).toBe("DIRECT");
    }
  });

  it("applies wildcard suffixes", () => {
    expect(findProxy("https://api.example.test/", "api.example.test")).toBe(
      "PROXY 127.0.0.1:8443; DIRECT",
    );
    expect(findProxy("https://example.test/", "example.test")).toBe("DIRECT");
  });

  it("normalizes the host the PAC runtime passes in", () => {
    expect(findProxy("https://api.deepgram.com/", "API.Deepgram.COM")).toBe(
      "PROXY 127.0.0.1:8443; DIRECT",
    );
  });
});
