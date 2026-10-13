// Room isolation demo. Two clients of the same buyer watch two different
// orders, the status of order A changes over HTTP, and the script reports
// who heard it.
//
//   node scripts/realtime-demo.mjs              → A_RECEIVED=1, B_RECEIVED=0
//   node scripts/realtime-demo.mjs --same-room  → A_RECEIVED=1, B_RECEIVED=1
//
// --same-room is the control run: same code, B just joins order A's room.
// If B_RECEIVED stayed 0 there too, the script would be printing a constant.
//
// Exit codes: 0 — result matches the mode, 1 — it doesn't (isolation broken,
// or the control run didn't hear anything), 2 — couldn't run at all.
import { randomUUID } from "node:crypto";
import { io } from "socket.io-client";

const BASE = process.env.API_URL ?? "http://localhost:3000";
const BUYER = "demo-buyer";
const TIMEOUT_MS = 2000;
// B's silence can only be proven by waiting; emits to one room go out in the
// same tick, so if B were in A's room it'd have heard by now
const SILENCE_MS = 500;

const sameRoom = process.argv.includes("--same-room");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
      "x-user-id": BUYER,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function connect(userId) {
  const socket = io(BASE, { auth: { userId }, reconnection: false });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) =>
      reject(new Error(`socket.io connect failed: ${err.message}`)),
    );
  });
}

function join(socket, orderId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no ack for join ${orderId}`)),
      TIMEOUT_MS,
    );
    socket.emit("join", orderId, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

async function waitUntil(check, ms) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await sleep(20);
}

async function main() {
  const item = { items: [{ product_id: "prod_1", quantity: 1 }] };
  const orderA = (await api("POST", "/v1/orders", item)).id;
  const orderB = (await api("POST", "/v1/orders", item)).id;

  const roomB = sameRoom ? orderA : orderB;
  const expectedB = sameRoom ? 1 : 0;

  const clientA = await connect(BUYER);
  const clientB = await connect(BUYER);
  const stranger = await connect("someone-else");

  let aReceived = 0;
  let bReceived = 0;
  clientA.on("order.status", (e) => {
    if (e.orderId === orderA) aReceived = 1;
  });
  clientB.on("order.status", (e) => {
    if (e.orderId === orderA) bReceived = 1;
  });

  // joins are acked before the status changes, otherwise the event could
  // fire before anyone is in the room
  for (const [socket, orderId] of [[clientA, orderA], [clientB, roomB]]) {
    const ack = await join(socket, orderId);
    if (!ack.ok) throw new Error(`join ${orderId} refused: ${ack.error}`);
  }
  const foreign = await join(stranger, orderA);

  await api("PATCH", `/v1/orders/${orderA}/status`, { status: "paid" });
  await waitUntil(() => aReceived === 1, TIMEOUT_MS);
  await sleep(SILENCE_MS);

  console.log(`A_RECEIVED=${aReceived}`);
  console.log(`B_RECEIVED=${bReceived}`);
  console.log(`FOREIGN_JOIN=${foreign.ok ? "allowed" : "denied"}`);

  for (const socket of [clientA, clientB, stranger]) socket.close();

  return aReceived === 1 && bReceived === expectedB && !foreign.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`realtime-demo: ${err.message}`);
    console.error(`is the API running on ${BASE}? See README, "Realtime".`);
    process.exit(2);
  },
);
