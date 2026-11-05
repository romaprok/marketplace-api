// demo:multipart's uploader, run as its own process. Asks the API which parts
// are still missing, uploads them straight to storage, and with a crash-after
// argument dies after that many parts, like a dropped connection would.
// Its environment: PATH, the API's address and an access token. No storage keys.
import { open, stat } from 'node:fs/promises';

export type UploaderMessage = { t: 'part'; n: number } | { t: 'finished'; alreadyThere: number };

const [apiUrl, fileId, filePath, crashAfterArg] = process.argv.slice(2);
const crashAfter = Number(crashAfterArg ?? 0);
const send = (m: UploaderMessage) => new Promise<void>((resolve) => process.send!(m, () => resolve()));

interface Plan {
  part_size: number;
  done: number[];
  todo: Array<{ part_number: number; url: string }>;
}

const size = (await stat(filePath!)).size;
const file = await open(filePath!);
let uploaded = 0;
let alreadyThere: number | undefined;

for (;;) {
  const res = await fetch(`${apiUrl}/v1/uploads/${fileId}/parts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.DEMO_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`parts plan: ${res.status}`);
  const plan = (await res.json()) as Plan;
  alreadyThere ??= plan.done.length;
  if (plan.todo.length === 0) break;

  for (const { part_number, url } of plan.todo) {
    const start = (part_number - 1) * plan.part_size;
    const bytes = Buffer.alloc(Math.min(plan.part_size, size - start));
    await file.read(bytes, 0, bytes.length, start);
    const put = await fetch(url, { method: 'PUT', body: bytes });
    if (!put.ok) throw new Error(`part ${part_number}: ${put.status}`);
    uploaded++;
    await send({ t: 'part', n: part_number });
    if (crashAfter && uploaded === crashAfter) process.kill(process.pid, 'SIGKILL');
  }
}

await send({ t: 'finished', alreadyThere: alreadyThere ?? 0 });
await file.close();
process.exit(0);
