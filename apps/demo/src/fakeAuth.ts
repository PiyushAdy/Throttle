import type { Request, RequestHandler } from 'express';

/**
 * DEMO-ONLY identity shim (PLAN Phase 5). Populates req.user from the
 * `x-user-id` header so the perUser resolver is demonstrable without real
 * authentication. The limiter never authenticates — real services put real
 * auth upstream of it. Do NOT copy this into a production service.
 */
export const fakeAuth: RequestHandler = (req: Request, _res, next) => {
  const userId = req.header('x-user-id');
  if (userId) {
    req.user = { id: userId, via: 'fake-auth-header' };
  }
  next();
};
