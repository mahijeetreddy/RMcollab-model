import type { Request } from "express";

/**
 * Under `noUncheckedIndexedAccess`, `req.params.x` is `string | undefined` even
 * though Express only runs the handler when the route matched and every declared
 * param is bound. Rather than repeat a can't-happen guard at each call site, the
 * framework's guarantee is asserted once here.
 */
export function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (value === undefined) {
    throw new Error(`route param :${name} missing on ${req.path}`);
  }
  return value;
}
