import { Server } from "socket.io";

import { findOrder } from "../data.js";
import { orderEvents } from "./order-events.service.js";

export const orderRoom = (orderId) => `orders:${orderId}`;

export function attachOrdersGateway(httpServer, events = orderEvents) {
  const io = new Server(httpServer);

  // There's no real auth in this project yet. The client names itself in
  // the handshake, the same stand-in as X-User-Id on POST /v1/orders.
  // No name, no connection.
  io.use((socket, next) => {
    const userId = socket.handshake.auth?.userId;
    if (typeof userId !== "string" || userId.length === 0) {
      return next(new Error("unauthorized"));
    }
    socket.data.userId = userId;
    next();
  });

  io.on("connection", (socket) => {
    socket.on("join", (orderId, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const order = findOrder(orderId);
      // unknown and foreign orders get the same answer, so a client can't
      // use join to find out which order ids exist
      if (!order || order.buyer_id !== socket.data.userId) {
        reply({ ok: false, error: "forbidden" });
        return;
      }
      socket.join(orderRoom(order.id));
      reply({ ok: true, room: orderRoom(order.id) });
    });
  });

  events.subscribe((event) => {
    io.to(orderRoom(event.orderId)).emit("order.status", event);
  });

  return io;
}
