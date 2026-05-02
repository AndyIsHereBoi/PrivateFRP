`packages/agent/src/logger.ts` — simple rolling-file logger that mirrors `console` to `agent.log`.

Functions:
- `configureAgentLogging(logPath: string): void` — create log directory, open `streamroller` `RollingFileStream` for `agent.log`, then wrap `console.log/warn/error` to also write timestamped lines to the rolling file.

Constants:
- `MAX_LOG_BYTES = 10 * 1024 * 1024`, `MAX_LOG_BACKUPS = 3`.
