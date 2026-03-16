import fs from "fs";
import path from "path";
import util from "util";

const { RollingFileStream } = require("streamroller") as {
  RollingFileStream: new (filename: string, maxSize: number, numBackups: number) => {
    write: (chunk: string) => void;
  };
};

type Level = "log" | "warn" | "error";

type Logger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const nativeConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_LOG_BACKUPS = 3;

type RollingStream = {
  write: (chunk: string) => void;
};

let tunnelLogFile: RollingStream | null = null;
let webLogFile: RollingStream | null = null;

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      return util.inspect(arg, { depth: 4, colors: false, breakLength: 120 });
    })
    .join(" ");
}

function writeLine(logFile: RollingStream | null, level: Level, args: unknown[]): void {
  if (!logFile) return;
  const ts = new Date().toISOString();
  const message = formatArgs(args);
  logFile.write(`${ts} [${level.toUpperCase()}] ${message}\n`);
}

function createLogger(fileGetter: () => RollingStream | null): Logger {
  return {
    log: (...args: unknown[]) => {
      nativeConsole.log(...args);
      writeLine(fileGetter(), "log", args);
    },
    warn: (...args: unknown[]) => {
      nativeConsole.warn(...args);
      writeLine(fileGetter(), "warn", args);
    },
    error: (...args: unknown[]) => {
      nativeConsole.error(...args);
      writeLine(fileGetter(), "error", args);
    },
  };
}

export const tunnelLog = createLogger(() => tunnelLogFile);
export const webLog = createLogger(() => webLogFile);

export function configureServerLogging(logPath: string): void {
  const resolvedDir = path.resolve(logPath || "./logs");
  fs.mkdirSync(resolvedDir, { recursive: true });

  tunnelLogFile = new RollingFileStream(path.join(resolvedDir, "tunnel.log"), MAX_LOG_BYTES, MAX_LOG_BACKUPS);
  webLogFile = new RollingFileStream(path.join(resolvedDir, "webserver.log"), MAX_LOG_BYTES, MAX_LOG_BACKUPS);
}
