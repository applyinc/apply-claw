import { auth } from "@/lib/auth/server";

export default auth.middleware({ loginUrl: "/auth/sign-in" });

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, icons, images
     * - auth routes (sign-in, sign-up, etc.)
     * - api/auth routes (auth API handler)
     */
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.png$|auth/|api/auth/).*)",
  ],
};
