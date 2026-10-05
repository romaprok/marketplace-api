import { EventEmitter } from "node:events";

const HISTORY_LIMIT = 100;

// One bus, two transports: the socket.io gateway and the SSE endpoint both
// subscribe here, business logic only ever publishes here.
export class OrderEventsService {
  #emitter = new EventEmitter();
  #streams = new Map(); // orderId -> { nextId, history }

  constructor() {
    // every open SSE connection is a listener; the default cap of 10 is a
    // leak warning meant for a handful of listeners, not for this
    this.#emitter.setMaxListeners(0);
  }

  publish(orderId, status) {
    const stream = this.#stream(orderId);
    // ids are per order, so a client's Last-Event-ID for order A means
    // nothing for order B and can't skip B's events by accident
    const event = {
      id: stream.nextId++,
      orderId,
      status,
      changedAt: new Date().toISOString(),
    };
    stream.history.push(event);
    if (stream.history.length > HISTORY_LIMIT) stream.history.shift();
    this.#emitter.emit("order.status", event);
    return event;
  }

  since(orderId, lastEventId) {
    const stream = this.#streams.get(orderId);
    if (!stream) return [];
    return stream.history.filter((e) => e.id > lastEventId);
  }

  subscribe(listener) {
    this.#emitter.on("order.status", listener);
    return () => this.#emitter.off("order.status", listener);
  }

  #stream(orderId) {
    let stream = this.#streams.get(orderId);
    if (!stream) {
      stream = { nextId: 1, history: [] };
      this.#streams.set(orderId, stream);
    }
    return stream;
  }
}

export const orderEvents = new OrderEventsService();
