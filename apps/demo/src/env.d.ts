declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id?: string; [key: string]: unknown };
    }
  }
}

export {};
