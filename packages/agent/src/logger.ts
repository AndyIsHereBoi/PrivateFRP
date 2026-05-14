// @ts-nocheck
const log4js = require("log4js");

function createLog4jsConfig() {
  return {
    appenders: {
      console: {
        type: "console",
        layout: {
          type: "pattern",
          pattern: "[%d] [%p] %-32x{level}- %m",
          tokens: {
            d: () => new Date().toISOString().replace("T", " ").slice(0, 23),
            level: (logEvent) => {
              const levelStr = logEvent.level?.toString() ?? "INFO";
              const padding = " ".repeat(Math.max(0, 32 - levelStr.length));
              return `${levelStr}${padding}`;
            },
          },
        },
      },
      // File appenders - disabled, kept for reference
      // file: {
      //   type: "dateFile",
      //   filename: "logs/agent.log",
      //   dateFormatPattern: "-yyyy-MM-dd",
      //   numBackups: 3,
      //   compress: true,
      // },
    },
    categories: {
      // File logging disabled - kept for reference
      // default: { appenders: ["console", "file"], level: "debug" },
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

const agentLog = new Logger("agent");

function configureAgentLogging(logPath) {
  log4js.configure(createLog4jsConfig());
}

module.exports = { agentLog, configureAgentLogging };
