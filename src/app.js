import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import * as OpenApiValidator from "express-openapi-validator";

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiSpecPath = path.join(__dirname, "..", "openapi", "openapi.yaml");

export function createApp() {
  const app = express();
  app.use(express.json());

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
      const order = createOrderFromItems(req.body.items);
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
