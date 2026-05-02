`packages/agent/src/index.ts` — binary entrypoint: load env, configure logging, construct and start `Agent`.

Functions:
- `loadEnvFile(fileName: string): void` — locate `fileName` in runtime paths (binary dir when compiled, then CWD), parse simple `KEY=VALUE` lines, and populate `process.env` only when keys are not already set.

Runtime notes:
- Reads env keys: `SERVER_HOST`, `SERVER_PORT`, `AGENT_ID`, `AGENT_SECRET`, `TLS_REJECT_UNAUTHORIZED`, `LOG_PATH`.
- Calls `configureAgentLogging(LOG_PATH)` then constructs `new Agent({ serverHost, serverPort, agentId, agentSecret, tlsRejectUnauthorized })` and calls `agent.start()`.
