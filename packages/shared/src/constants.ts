export const PROTOCOL_VERSION = 1;

export const FRAME_TYPES = {
  AGENT_HELLO: 'AgentHello',
  SERVER_HELLO: 'ServerHello',
  HEARTBEAT: 'Heartbeat',
  CONFIG_PUSH: 'ConfigPush',
  CONFIG_ACK: 'ConfigAck',
  DIAL_TCP: 'DialTcp',
  DIAL_UDP_SESSION: 'DialUdpSession',
  STREAM_OPEN: 'StreamOpen',
  STREAM_DATA: 'StreamData',
  STREAM_CLOSE: 'StreamClose',
  UDP_DATA: 'UdpData',
  ERROR: 'Error'
} as const;

export const DEFAULTS = {
  SERVER_HOST: '0.0.0.0',
  AGENT_PORT: 7000,
  DATA_PORT: 7001,
  DASHBOARD_PORT: 8080,
  PUBLIC_HTTP_PORT: 9000,
  AGENT_RECONNECT_MS: 1000,
  AGENT_RECONNECT_MAX_MS: 15000,
  HEARTBEAT_INTERVAL_MS: 5000,
  STREAM_IDLE_TIMEOUT_MS: 30000
} as const;

export const COOKIE_NAMES = {
  DASHBOARD_SESSION: 'privatefrp_dashboard_session'
} as const;