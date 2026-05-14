import path from "path";
import log4js from "log4js";

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_LOG_BACKUPS = 3;

function createRollingFileConfig(filename: string): any {
  return {
    type: "rollingFile" as const,
    filename: path.join("./logs", filename),
    maxLogSize: MAX_LOG_BYTES,
    backups: MAX_LOG_BACKUPS,
    pattern: "-yyyy-MM-dd",
    alwaysIncludePattern: false,
    compress: true,
  };
}

function createLog4jsConfig(logDir: string): log4js.Configuration {
  return {
    appenders: {
      console: {
        type: "console",
        layout: {
          type: "pattern",
          pattern: "[%d] [%p] %-32x{level}- %m",
          tokens: {
            d: () => new Date().toISOString().replace("T", " ").slice(0, 23),
            level: (logEvent: any) => {
              const levelStr = logEvent.level?.toString() ?? "INFO";
              const padding = " ".repeat(Math.max(0, 32 - levelStr.length));
              return `${levelStr}${padding}`;
            },
          },
        },
      },
      tunnel: createRollingFileConfig("tunnel.log"),
      web: createRollingFileConfig("webserver.log"),
    },
    categories: {
      tunnel: { appenders: ["console", "tunnel"], level: "debug" },
      web: { appenders: ["console", "web"], level: "debug" },
      default: { appenders: ["console"], level: "debug" },
    },
  };
}

class Logger {
  private logger: log4js.Logger;

  constructor(category: string) {
    this.logger = log4js.getLogger(category);
  }

  debug(message: string, ...args: unknown[]): void {
    this.logger.debug(message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.logger.info(message, ...args);
  }

  log(message: string, ...args: unknown[]): void {
    this.logger.info(message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.logger.warn(message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.logger.error(message, ...args);
  }
}

export const tunnelLog = new Logger("tunnel");
export const webLog = new Logger("web");

export function configureServerLogging(logPath: string): void {
  const resolvedDir = path.resolve(logPath || "./logs");
  try {
    const fs = require("fs");
    fs.mkdirSync(resolvedDir, { recursive: true });
  } catch {
    // ignore if directory already exists
  }
  log4js.configure(createLog4jsConfig(resolvedDir));
}
