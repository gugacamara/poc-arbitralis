import { createApplication } from './application.js';
import { loadConfig } from './config/env.js';

/** Boot do processo: carrega config, sobe a aplicacao e trata sinais do SO. */
async function main(): Promise<void> {
  const config = loadConfig();
  const application = createApplication(config);

  application.worker.start();
  await application.app.listen({ port: config.http.port, host: config.http.host });

  application.logger.info('server listening', {
    port: config.http.port,
    host: config.http.host,
  });

  registerShutdownHandlers(async () => {
    application.logger.info('shutdown requested');
    await application.stop();
  });
}

function registerShutdownHandlers(shutdown: () => Promise<void>): void {
  let shuttingDown = false;

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      shutdown().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

await main();
