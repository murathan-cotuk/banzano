import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

// Auth is handled client-side via AuthGuard (localStorage aff_token) — this middleware only
// needs to perform next-intl's locale routing, matching apps/developer's pattern.
export default createMiddleware(routing);

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
