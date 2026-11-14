import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import * as OpenApiValidator from "express-openapi-validator";

import { configService } from "./config/config.service.js";
import { checkDbConnection } from "./db/pool.js";
import {
  products,
  orders,
  findProduct,
  findOrder,
  createOrderFromItems,
} from "./data.js";
import { paginate } from "./pagination.js";
import { sendProblem } from "./problem.js";
import { idempotency } from "./idempotency.js";
import {
  streamOrderEvents,
  updateOrderStatus,
} from "./orders/orders.controller.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiSpecPath = path.join(__dirname, "..", "openapi", "openapi.yaml");

// isReady / isDraining come from server.js (hw-28). Tests and the contract
// suite build the app without a server around it, so by default it is ready.
export function createApp({ isReady = () => true, isDraining = () => false } = {}) {
  const app = express();

  // Kubernetes probes, outside /v1 and the OpenAPI validator. Two questions,
  // two URLs: /healthz "should I be killed" (the process answers at all),
  // /readyz "may I get traffic" (warmed up and not shutting down).
  app.get("/healthz", (req, res) => res.json({ status: "alive" }));
  app.get("/readyz", (req, res) =>
    isReady() ? res.json({ status: "ready" }) : res.status(503).json({ status: "not ready" }),
  );
  // while draining, keep-alive clients are told to reconnect, and a new
  // connection lands on a pod that is still ready
  app.use((req, res, next) => {
    if (isDraining()) res.set("Connection", "close");
    next();
  });

  app.use(express.json());

  app.get("/health", async (req, res) => {
    try {
      await checkDbConnection();
      res.json({ status: "ok", uptime: process.uptime(), db: "ok" });
    } catch (err) {
      res
        .status(503)
        .json({
          status: "error",
          uptime: process.uptime(),
          db: "error",
          message: err.message,
        });
    }
  });

  // SSE lives outside /v1 and outside the OpenAPI validator: a stream that
  // never ends has no response body the validator could check.
  app.get("/orders/:orderId/events", streamOrderEvents);

  app.use(
    OpenApiValidator.middleware({
      apiSpec: apiSpecPath,
      validateRequests: true,
      validateResponses: true,
    }),
  );

  const router = express.Router();

  router.get("/products", (req, res, next) => {
    try {
      const { cursor, limit } = req.query;
      res.json(
        paginate(products, {
          cursor,
          limit: limit !== undefined ? Number(limit) : undefined,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.get("/products/:productId", (req, res) => {
    const product = findProduct(req.params.productId);
    if (!product) {
      return sendProblem(
        res,
        req,
        404,
        `Product ${req.params.productId} was not found.`,
        {
          title: "Resource not found",
        },
      );
    }
    res.json(product);
  });

  router.get("/orders", (req, res, next) => {
    try {
      const { cursor, limit } = req.query;
      res.json(
        paginate(orders, {
          cursor,
          limit: limit !== undefined ? Number(limit) : undefined,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.post("/orders", idempotency, (req, res, next) => {
    try {
      const order = createOrderFromItems(
        req.body.items,
        req.get("x-user-id") ?? null,
      );
      res.status(201).set("Location", `/v1/orders/${order.id}`).json(order);
    } catch (err) {
      next(err);
    }
  });

  router.get("/orders/:orderId", (req, res) => {
    const order = findOrder(req.params.orderId);
    if (!order) {
      return sendProblem(
        res,
        req,
        404,
        `Order ${req.params.orderId} was not found.`,
        {
          title: "Resource not found",
        },
      );
    }
    res.json(order);
  });

  router.patch("/orders/:orderId/status", updateOrderStatus);

  app.use("/v1", router);

  app.use((req, res) => {
    sendProblem(
      res,
      req,
      404,
      `No route for ${req.method} ${req.originalUrl}.`,
      {
        title: "Resource not found",
      },
    );
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    const detail =
      Array.isArray(err.errors) && err.errors.length > 0
        ? err.errors
            .map((e) => `${e.path ?? ""} ${e.message}`.trim())
            .join("; ")
        : err.message || "Internal Server Error";

    if (status >= 500) {
      console.error(err);
    }

    sendProblem(res, req, status, detail);
  });

  return app;
}

export { configService };
