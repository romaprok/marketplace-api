import type { Request, Response } from 'express';

// Same problem+json shape as the hw-09 API (src/problem.js)
export function sendProblem(req: Request, res: Response, status: number, title: string, detail: string): void {
  res.status(status).type('application/problem+json').json({
    type: `https://marketplace.example.com/problems/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    title,
    status,
    detail,
    instance: req.originalUrl,
  });
}
