import { findOrder } from "../data.js";
import { sendProblem } from "../problem.js";
import { orderEvents } from "./order-events.service.js";
import { changeOrderStatus } from "./orders.service.js";

const RETRY_MS = 1000;

function notFound(req, res) {
  sendProblem(res, req, 404, `Order ${req.params.orderId} was not found.`, {
    title: "Resource not found",
  });
}

function writeEvent(res, event) {
  res.write(
    `id: ${event.id}\nevent: order.status\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

// GET /orders/:orderId/events
export function streamOrderEvents(req, res) {
  const order = findOrder(req.params.orderId);
  if (!order) return notFound(req, res);

  const lastEventId = Number(req.get("last-event-id")) || 0;

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // without it EventSource waits its default few seconds before reconnecting
  res.write(`retry: ${RETRY_MS}\n\n`);

  // Replay and subscribe in the same tick. Nothing can be published in
  // between, so a reconnecting client gets neither a gap nor a duplicate.
  for (const event of orderEvents.since(order.id, lastEventId)) {
    writeEvent(res, event);
  }
  const unsubscribe = orderEvents.subscribe((event) => {
    if (event.orderId === order.id) writeEvent(res, event);
  });
  req.on("close", unsubscribe);
}

// PATCH /v1/orders/:orderId/status
export function updateOrderStatus(req, res) {
  const order = changeOrderStatus(req.params.orderId, req.body.status);
  if (!order) return notFound(req, res);
  res.json(order);
}
