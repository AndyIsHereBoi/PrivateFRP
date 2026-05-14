// @ts-nocheck
const path = require("path");
const log4js = require("log4js");

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_LOG_BACKUPS = 3;

function createRollingFileConfig(logDir, filename) {
  return {
    type: "dateFile",
    filename: path.join(logDir, filename),
    dateFormatPattern: "-yyyy-MM-dd",
    numBackups: MAX_LOG_BACKUPS,
    compress: true,
  };
}

function createLog4jsConfig(logDir) {
  return {
    appenders: {
      console: {
        type: "console",
      },
      // File appenders - disabled, kept for reference
      // tunnel: createRollingFileConfig(logDir, "tunnel.log"),
      // web: createRollingFileConfig(logDir, "webserver.log"),
    },
    categories: {
      // File logging disabled - kept for reference
      // tunnel: { appenders: ["console", "tunnel"], level: "debug" },
      // web: { appenders: ["console", "web"], level: "debug" },
      default: { appenders: ["console"], level: "debug" },
    },
  };
}

class Logger {
  constructor(category) {
    this.logger = log4js.getLogger(category);
  }

  debug(message, ...args) {
    this.logger.debug(message, ...args);
  }

  info(message, ...args) {
    this.logger.info(message, ...args);
  }

  log(message, ...args) {
    this.logger.info(message, ...args);
  }

  warn(message, ...args) {
    this.logger.warn(message, ...args);
  }

  error(message, ...args) {
    this.logger.error(message, ...args);
  }
}

const tunnelLog = new Logger("tunnel");
const webLog = new Logger("web");

function configureServerLogging(logPath) {
  const resolvedDir = path.resolve(logPath || "./logs");
  try {
    const fs = require("fs");
    fs.mkdirSync(resolvedDir, { recursive: true });
  } catch {
    // ignore if directory already exists
  }
  log4js.configure(createLog4jsConfig(resolvedDir));
}

module.exports = { tunnelLog, webLog, configureServerLogging };
