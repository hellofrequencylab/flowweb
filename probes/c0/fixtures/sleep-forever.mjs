// Fixture for c0/probe-runner, not a row probe: never finishes on its own, and leaves a grandchild
// process (marked by FW_PROBE_MARKER in its environment) that the runner must also kill.
import { spawn } from 'node:child_process';

spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { stdio: 'ignore', env: { ...process.env } });
setTimeout(() => {}, 300000);
