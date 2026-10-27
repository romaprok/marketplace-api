import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Express 4 doesn't catch a rejected promise from a handler: without this a
// database error in a route is an unhandled rejection that kills the process.
export const handle =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
