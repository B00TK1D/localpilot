import { startProxyServer } from './proxy.js';

const { server, config } = await startProxyServer();
console.log(`localpilot proxy listening on http://0.0.0.0:${config.port}`);
console.log(`forwarding completion traffic to ${config.lmStudioBaseUrl}`);

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`received ${signal}, shutting down localpilot`);

  server.close((error) => {
    if (error) {
      console.error(`error during shutdown: ${error.message}`);
      process.exit(1);
      return;
    }

    console.log('localpilot shutdown complete');
    process.exit(0);
  });

  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }

  setTimeout(() => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  }, 250).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
