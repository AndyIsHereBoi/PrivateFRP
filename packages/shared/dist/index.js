// @bun
// packages/shared/src/constants.ts
var FrameType;
((FrameType2) => {
  FrameType2[FrameType2["AgentHello"] = 1] = "AgentHello";
  FrameType2[FrameType2["ServerHello"] = 2] = "ServerHello";
  FrameType2[FrameType2["Heartbeat"] = 16] = "Heartbeat";
  FrameType2[FrameType2["ConfigPush"] = 17] = "ConfigPush";
  FrameType2[FrameType2["DialTcp"] = 18] = "DialTcp";
  FrameType2[FrameType2["DialUdpSession"] = 19] = "DialUdpSession";
  FrameType2[FrameType2["DataConnHello"] = 32] = "DataConnHello";
  FrameType2[FrameType2["UdpData"] = 33] = "UdpData";
  FrameType2[FrameType2["PoolHello"] = 48] = "PoolHello";
  FrameType2[FrameType2["DialAssign"] = 49] = "DialAssign";
  FrameType2[FrameType2["StreamOpen"] = 64] = "StreamOpen";
  FrameType2[FrameType2["StreamData"] = 65] = "StreamData";
  FrameType2[FrameType2["StreamClose"] = 66] = "StreamClose";
})(FrameType ||= {});
var TunnelType;
((TunnelType2) => {
  TunnelType2["TCP"] = "tcp";
  TunnelType2["UDP"] = "udp";
  TunnelType2["TCPUDP"] = "tcp+udp";
})(TunnelType ||= {});
var AgentStatus;
((AgentStatus2) => {
  AgentStatus2["Disconnected"] = "disconnected";
  AgentStatus2["Connecting"] = "connecting";
  AgentStatus2["Connected"] = "connected";
  AgentStatus2["Error"] = "error";
})(AgentStatus ||= {});
var DEFAULT_PORTS = {
  AGENT: 7000,
  DASHBOARD: 8089
};
var PROTOCOL_VERSION = "1.0";
// packages/shared/src/types.ts
class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolError";
  }
}
var ConnectionErrorCode;
((ConnectionErrorCode2) => {
  ConnectionErrorCode2["AuthFailed"] = "AUTH_FAILED";
  ConnectionErrorCode2["InvalidFrame"] = "INVALID_FRAME";
  ConnectionErrorCode2["Timeout"] = "TIMEOUT";
  ConnectionErrorCode2["Closed"] = "CLOSED";
  ConnectionErrorCode2["Unknown"] = "UNKNOWN";
})(ConnectionErrorCode ||= {});

class ConnectionError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "ConnectionError";
    this.code = code;
  }
}
// packages/shared/src/protocol/frame.ts
var HEADER_SIZE = 9;
function encodeFrame(type, id, body) {
  const bodyLength = body.length;
  const buffer = new ArrayBuffer(HEADER_SIZE + bodyLength);
  const view = new DataView(buffer);
  view.setUint8(0, type);
  view.setUint32(1, id, false);
  view.setUint32(5, bodyLength, false);
  const data = new Uint8Array(buffer);
  if (bodyLength > 0) {
    data.set(body, HEADER_SIZE);
  }
  return data;
}
function decodeFrame(data) {
  if (data.length < HEADER_SIZE) {
    throw new ProtocolError(`Frame too small: ${data.length} bytes`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.length);
  const type = view.getUint8(0);
  const id = view.getUint32(1, false);
  const bodyLength = view.getUint32(5, false);
  if (data.length < HEADER_SIZE + bodyLength) {
    throw new ProtocolError(`Expected ${HEADER_SIZE + bodyLength} bytes, got ${data.length}`);
  }
  let body;
  if (bodyLength > 0) {
    body = data.slice(HEADER_SIZE, HEADER_SIZE + bodyLength);
  } else {
    body = new Uint8Array;
  }
  return { type, id, body };
}
function parseAgentHello(body) {
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Invalid AgentHello JSON");
  }
}
function parseServerHello(body) {
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Invalid ServerHello JSON");
  }
}
function parseHeartbeat(body) {
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Invalid Heartbeat JSON");
  }
}
function parseTunnelConfigs(body) {
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Invalid TunnelConfigs JSON");
  }
}
function parseDialTcp(body) {
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Invalid DialTcp JSON");
  }
}
function parseDialUdpSession(body) {
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Invalid DialUdpSession JSON");
  }
}
function parseStreamData(body) {
  if (body.length < 4) {
    throw new ProtocolError("StreamData body too small");
  }
  const view = new DataView(body.buffer, body.byteOffset, body.length);
  const streamId = view.getUint32(0, false);
  let data;
  if (body.length > 4) {
    data = body.slice(4);
  } else {
    data = new Uint8Array;
  }
  return { streamId, data };
}
function parseStreamClose(body) {
  if (body.length === 0) {
    return { streamId: 0 };
  }
  const text = new TextDecoder().decode(body);
  try {
    const parsed = JSON.parse(text);
    return { streamId: parsed.streamId ?? 0, reason: parsed.reason };
  } catch {
    throw new ProtocolError("Invalid StreamClose JSON");
  }
}
// packages/shared/src/utils/env.ts
function validateServerEnv(env) {
  const errors = [];
  const serverPort = parseInt(env.SERVER_PORT || "");
  if (isNaN(serverPort)) {
    errors.push("SERVER_PORT must be a valid number");
  }
  const dashboardPort = parseInt(env.DASHBOARD_PORT || "");
  if (isNaN(dashboardPort)) {
    errors.push("DASHBOARD_PORT must be a valid number");
  }
  if (!env.DATABASE_PATH) {
    errors.push("DATABASE_PATH is required");
  }
  if (errors.length > 0) {
    throw new Error(`Environment validation failed:
${errors.join(`
`)}`);
  }
  return {
    SERVER_PORT: serverPort,
    DASHBOARD_PORT: dashboardPort,
    DATABASE_PATH: env.DATABASE_PATH,
    TLS_CERT: env.TLS_CERT,
    TLS_KEY: env.TLS_KEY
  };
}
function validateAgentEnv(env) {
  const errors = [];
  if (!env.SERVER_HOST) {
    errors.push("SERVER_HOST is required");
  }
  const serverPort = parseInt(env.SERVER_PORT || "");
  if (isNaN(serverPort)) {
    errors.push("SERVER_PORT must be a valid number");
  }
  if (!env.AGENT_ID) {
    errors.push("AGENT_ID is required");
  }
  if (!env.AGENT_SECRET) {
    errors.push("AGENT_SECRET is required");
  }
  if (errors.length > 0) {
    throw new Error(`Environment validation failed:
${errors.join(`
`)}`);
  }
  return {
    SERVER_HOST: env.SERVER_HOST,
    SERVER_PORT: serverPort,
    AGENT_ID: env.AGENT_ID,
    AGENT_SECRET: env.AGENT_SECRET,
    TLS_REJECT_UNAUTHORIZED: env.TLS_REJECT_UNAUTHORIZED !== "false"
  };
}
function getDefaultEnv() {
  return {
    SERVER_PORT: "7000",
    DASHBOARD_PORT: "8089",
    DATABASE_PATH: "./data/privatefrp.db",
    TLS_REJECT_UNAUTHORIZED: "true"
  };
}
// packages/shared/src/utils/config.ts
function loadServerConfig() {
  const env = { ...getDefaultEnv(), ...globalThis.Bun?.env || {} };
  const validated = validateServerEnv(env);
  return {
    serverPort: validated.SERVER_PORT,
    dashboardPort: validated.DASHBOARD_PORT,
    databasePath: validated.DATABASE_PATH,
    tlsCert: validated.TLS_CERT,
    tlsKey: validated.TLS_KEY
  };
}
function loadAgentConfig() {
  const env = { ...getDefaultEnv(), ...globalThis.Bun?.env || {} };
  const validated = validateAgentEnv(env);
  return {
    serverHost: validated.SERVER_HOST,
    serverPort: validated.SERVER_PORT,
    agentId: validated.AGENT_ID,
    agentSecret: validated.AGENT_SECRET,
    tlsRejectUnauthorized: validated.TLS_REJECT_UNAUTHORIZED !== false
  };
}
export {
  validateServerEnv,
  validateAgentEnv,
  parseTunnelConfigs,
  parseStreamData,
  parseStreamClose,
  parseServerHello,
  parseHeartbeat,
  parseDialUdpSession,
  parseDialTcp,
  parseAgentHello,
  loadServerConfig,
  loadAgentConfig,
  getDefaultEnv,
  encodeFrame,
  decodeFrame,
  TunnelType,
  ProtocolError,
  PROTOCOL_VERSION,
  FrameType,
  DEFAULT_PORTS,
  ConnectionErrorCode,
  ConnectionError,
  AgentStatus
};
