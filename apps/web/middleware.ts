import { type NextRequest } from "next/server";
import { getAuth } from "@/lib/auth/server";

export default async function middleware(request: NextRequest) {
  const authMiddleware = getAuth().middleware({ loginUrl: "/auth/sign-in" });
  return authMiddleware(request);
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, icons, images
     * - auth routes (sign-in, sign-up, etc.)
     * - api/ routes (proxied to control-api, which has its own auth)
     */
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.png$|auth/|api/).*)",
  ],
};
