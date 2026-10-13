import { findOrder } from "../data.js";
import { orderEvents } from "./order-events.service.js";

export function changeOrderStatus(orderId, status) {
  const order = findOrder(orderId);
  if (!order) return null;

  order.status = status;
  orderEvents.publish(order.id, status);
  return order;
}
