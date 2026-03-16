import fs from "fs";
import path from "path";
import util from "util";

const { RollingFileStream } = require("streamroller") as {
  RollingFileStream: new (filename: string, maxSize: number, numBackups: number) => {
    write: (chunk: string) => void;
  };
};

type Level = "log" | "warn" | "error";

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_LOG_BACKUPS = 3;

type RollingStream = {
  write: (chunk: string) => void;
};

let agentLogFile: RollingStream | null = null;

const nativeConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      return util.inspect(arg, { depth: 4, colors: false, breakLength: 120 });
    })
    .join(" ");
}

function writeLine(level: Level, args: unknown[]): void {
  if (!agentLogFile) return;
  const ts = new Date().toISOString();
  const message = formatArgs(args);
  agentLogFile.write(`${ts} [${level.toUpperCase()}] ${message}\n`);
}

export function configureAgentLogging(logPath: string): void {
  const resolvedDir = path.resolve(logPath || "./logs");
  fs.mkdirSync(resolvedDir, { recursive: true });
  agentLogFile = new RollingFileStream(path.join(resolvedDir, "agent.log"), MAX_LOG_BYTES, MAX_LOG_BACKUPS);

  console.log = (...args: unknown[]) => {
    nativeConsole.log(...args);
    writeLine("log", args);
  };

  console.warn = (...args: unknown[]) => {
    nativeConsole.warn(...args);
    writeLine("warn", args);
  };

  console.error = (...args: unknown[]) => {
    nativeConsole.error(...args);
    writeLine("error", args);
  };
}
