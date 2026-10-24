import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { PodMessage } from './demo-pod.js';

export interface Pod {
  url: string;
  close(): Promise<void>;
}

// A replica of the Postgres API in a child process (src/demo-pod.ts).
export async function startPod(): Promise<Pod> {
  const child = fork(fileURLToPath(new URL('./demo-pod.js', import.meta.url)), {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const ready = once(child, 'message') as Promise<[PodMessage]>;
  const died = once(child, 'exit').then(() => {
    throw new Error('pod exited before listening');
  });
  const [{ port }] = await Promise.race([ready, died]);
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
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
