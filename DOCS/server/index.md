`packages/server/src/index.ts` — server binary entrypoint: load env, configure logging, instantiate `DB` and `Server`, then `server.start()`.

Functions:
- `loadEnvFile(fileName: string): void` — same semantics as agent: candidate paths, parse, and set `process.env` keys.

Runtime/env:
- Reads: `AGENT_PORT`, `DASHBOARD_PORT`, `AGENT_TLS_CERT`, `AGENT_TLS_KEY`, `DASHBOARD_SECRET`, `DATA_DIR`, `PUBLIC_IP`, `LOG_PATH`.
- Instantiates `new DB(dataDir)` and `new Server(config, db)` and starts the server.
