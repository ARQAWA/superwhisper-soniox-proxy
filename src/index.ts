import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { Diagnostics, diagnosticsOptionsFromConfig } from "./diagnostics.js";
import { startProxy } from "./proxy.js";
import { SonioxService } from "./soniox.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const diagnostics = new Diagnostics(diagnosticsOptionsFromConfig(config), logger);
  logger.info(
    {
      dry_run: config.DRY_RUN,
      capture_template: config.CAPTURE_TEMPLATE,
      target_host: config.TARGET_HOST,
      target_path: config.TARGET_PATH ?? null,
      target_model: config.TARGET_MODEL,
      soniox_model: config.SONIOX_MODEL,
      port: config.PROXY_PORT,
      diagnostics_enabled: diagnostics.isEnabled,
      diagnostics_dir: diagnostics.dir,
    },
    "starting soniox proxy",
  );

  const soniox = new SonioxService(config, logger, diagnostics);
  const proxy = await startProxy({ config, logger, soniox, diagnostics });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await Promise.race([
      proxy.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // Deliberately do not print environment or request bodies here.
  process.stderr.write(`soniox proxy failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
