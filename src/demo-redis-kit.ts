import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { PodMessage } from './demo-pod.js';

export interface Pod {
  url: string;
  // everything the pod printed so far
  log(): string;
  close(): Promise<void>;
}

// One limiter namespace per demo run, shared by all pods of that run.
export const demoRateLimitName = () => `demo-${randomUUID()}`;

// A replica of the Postgres API in a child process (src/demo-pod.ts). The
// caller always closes it; if the demo itself dies, the pod sees the IPC
// channel drop and exits too.
export async function startPod(env: Record<string, string> = {}): Promise<Pod> {
  const child = fork(fileURLToPath(new URL('./demo-pod.js', import.meta.url)), {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ...env },
  });
  let output = '';
  child.stdout!.on('data', (chunk) => (output += chunk));
  child.stderr!.on('data', (chunk) => (output += chunk));

  const ready = once(child, 'message') as Promise<[PodMessage]>;
  const died = once(child, 'exit').then(() => {
    throw new Error(`pod exited before listening:\n${output}`);
  });
  const [{ port }] = await Promise.race([ready, died]);
  return {
    url: `http://127.0.0.1:${port}`,
    log: () => output,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    },
  };
}

export function sessionIdFrom(res: Response): string | undefined {
  for (const cookie of res.headers.getSetCookie()) {
    const match = /^sid=([^;]+)/.exec(cookie);
    if (match) return match[1];
  }
  return undefined;
}
