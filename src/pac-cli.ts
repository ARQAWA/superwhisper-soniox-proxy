import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildPac, parseAllowedHosts } from "./pac.js";

interface CliOptions {
  proxyHost: string;
  proxyPort: number;
  allowedHosts: string;
  out: string;
}

function usage(): string {
  return [
    "usage: pac-cli --host <proxy-host> --port <proxy-port> --hosts <a,b> --out <path>",
    "generates a PAC file that proxies only the listed hosts",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    proxyHost: "127.0.0.1",
    proxyPort: 8443,
    out: "logs/proxy.pac",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--host":
        if (!value) throw new Error("--host requires a value");
        options.proxyHost = value;
        i += 1;
        break;
      case "--port": {
        if (!value) throw new Error("--port requires a value");
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`invalid port: ${value}`);
        }
        options.proxyPort = port;
        i += 1;
        break;
      }
      case "--hosts":
        if (!value) throw new Error("--hosts requires a value");
        options.allowedHosts = value;
        i += 1;
        break;
      case "--out":
        if (!value) throw new Error("--out requires a value");
        options.out = value;
        i += 1;
        break;
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }
  if (!options.allowedHosts) throw new Error("--hosts is required");
  return options as CliOptions;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const hosts = parseAllowedHosts(options.allowedHosts);
  if (hosts.length === 0) throw new Error("the allowlist is empty");
  const content = buildPac({
    proxyHost: options.proxyHost,
    proxyPort: options.proxyPort,
    allowedHosts: hosts,
  });
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, content, { mode: 0o644 });
  console.log(options.out);
} catch (err) {
  console.error((err as Error).message);
  console.error(usage());
  process.exit(1);
}
