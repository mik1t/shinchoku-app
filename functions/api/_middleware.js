import { authenticate } from "../_lib/auth.js";

export async function onRequest(ctx) {
  const who = await authenticate(ctx.request, ctx.env);
  if (who instanceof Response) return who;
  ctx.data.user = who;
  return ctx.next();
}
