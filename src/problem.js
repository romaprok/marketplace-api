const PROBLEM_BASE = "https://marketplace.example.com/problems";

const TITLES = {
  400: "Bad Request",
  404: "Resource not found",
  409: "Conflict",
  422: "Unprocessable Entity",
  500: "Internal Server Error",
};

export function problem({ status, detail, instance, title, type }) {
  const resolvedTitle = title ?? TITLES[status] ?? "Error";
  const slug = resolvedTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return {
    type: type ?? `${PROBLEM_BASE}/${slug}`,
    title: resolvedTitle,
    status,
    detail,
    instance,
  };
}

export function sendProblem(res, req, status, detail, extra = {}) {
  res
    .status(status)
    .type("application/problem+json")
    .json(problem({ status, detail, instance: req.originalUrl, ...extra }));
}
