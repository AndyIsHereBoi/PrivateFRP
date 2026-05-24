import process from 'node:process';
import { startAgent } from '../packages/agent/src/index';
import { startServer } from '../packages/server/src/index';

const isServerMode = process.argv.includes('--server') || process.env.SERVER_MODE === '1';

if (isServerMode) {
  await startServer();
} else {
  await startAgent();
}