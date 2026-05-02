`packages/server/src/logger.ts` — file-backed loggers for tunnel and webserver activity; mirrors `console` and provides `tunnelLog`/`webLog`.

Exports:
- `tunnelLog: { log,warn,error }` — writes to `tunnel.log` and `console`.
- `webLog: { log,warn,error }` — writes to `webserver.log` and `console`.
- `configureServerLogging(logPath: string): void` — initialize rolling files `tunnel.log` and `webserver.log` (defaults/rotation constants included).
