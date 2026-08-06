import { createApp } from "./app";
import { loadConfig } from "./config";

async function main(): Promise<void> {
  const config = loadConfig();
  const instance = await createApp(config, { logger: true });
  instance.startBackgroundJobs();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      instance.app.log.info(`${signal} received, shutting down`);
      void instance.close().then(() => process.exit(0));
    });
  }

  await instance.app.listen({ port: config.port, host: config.host });
  instance.app.log.info(
    { adapterMode: config.adapterMode, db: config.dbPath, devRoutes: config.devRoutesEnabled },
    "opensluice gateway ready",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
