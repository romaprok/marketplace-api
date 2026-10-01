import crypto from "node:crypto";
import { sendProblem } from "./problem.js";

const store = new Map(); // key -> { fingerprint, status: 'in-flight' | 'done', response? }
const TTL_MS = 24 * 60 * 60 * 1000;

function fingerprint(body) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(body ?? {}))
    .digest("hex");
}

export function idempotency(req, res, next) {
  const key = req.headers["idempotency-key"];
  const fp = fingerprint(req.body);
  const existing = store.get(key);

  if (existing) {
    if (existing.fingerprint !== fp) {
      return sendProblem(
        res,
        req,
        422,
        `Idempotency-Key "${key}" was already used with a different request body.`,
        { title: "Idempotency key reused with a different body" },
      );
    }

    if (existing.status === "in-flight") {
      return sendProblem(
        res,
        req,
        409,
        `A request with Idempotency-Key "${key}" is already being processed.`,
        { title: "Conflict" },
      );
    }

    res.set("Idempotency-Replay", "true");
    for (const [name, value] of Object.entries(existing.response.headers)) {
      res.set(name, value);
    }
    return res
      .status(existing.response.status)
      .type("application/json")
      .json(existing.response.body);
  }

  store.set(key, { fingerprint: fp, status: "in-flight" });
  const timer = setTimeout(() => {
    const entry = store.get(key);
    if (entry && entry.status === "in-flight") store.delete(key);
  }, TTL_MS);
  timer.unref();

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const headers = {};
      const location = res.get("Location");
      if (location) headers.Location = location;
      store.set(key, {
        fingerprint: fp,
        status: "done",
        response: { status: res.statusCode, body, headers },
      });
    } else {
      store.delete(key);
    }
    return originalJson(body);
  };

  next();
}
