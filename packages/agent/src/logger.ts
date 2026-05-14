// @ts-nocheck
const log4js = require("log4js");

function createLog4jsConfig() {
  return {
    appenders: {
      console: {
        type: "console",
      },
    },
    categories: {
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
