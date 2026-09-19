import { NextRequest, NextResponse } from "next/server";

const REFLEX_BACKEND_URL =
  process.env.REFLEX_BACKEND_URL || "https://backend.alexstudies.com";

// Paths owned by Next.js — everything else proxies to Reflex.
const NEXT_PATHS = [
  "/",
  "/select",
  "/login",
  "/register",
  "/onboarding",
  "/generate-plan",
  "/exam-forecast",
  "/learn-with-youtube",
  "/robots.txt",
  "/sitemap.xml",
];

const NEXT_PREFIXES = [
  "/api/auth/",
  "/api/onboarding/",
  "/_next/",
];

function isNextPath(pathname: string): boolean {
  if (NEXT_PATHS.includes(pathname)) return true;
  return NEXT_PREFIXES.some((p) => pathname.startsWith(p));
}

function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}`;
  } catch {
    return origin;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname, search, origin } = req.nextUrl;

  // After Next.js /onboarding redirects here with ?onboarded=1, send
  // the user straight to their workspace route. The scope is passed
  // in the URL (?scope=y1s1) because Safari Private doesn't reliably
  // persist the auth cookie, so we can't always look it up server-side.
  // Cookie lookup is the fallback for clients that do send it.
  if (pathname === "/app" && req.nextUrl.searchParams.has("onboarded")) {
    const scopeParam = req.nextUrl.searchParams.get("scope") ?? "";
    if (/^y\d+s\d+$/.test(scopeParam)) {
      return NextResponse.redirect(new URL(`/s/${scopeParam}`, origin));
    }
    const cookie = req.cookies.get("_auth_token")?.value;
    if (cookie) {
      try {
        const statusRes = await fetch(`${origin}/api/onboarding/status`, {
          headers: { Authorization: `Bearer ${cookie}` },
        });
        if (statusRes.ok) {
          const data = (await statusRes.json()) as {
            memory?: {
              is_started?: boolean;
              selected_year?: string;
              selected_semester?: string;
            };
          };
          const m = data.memory;
          if (m?.is_started && m.selected_year && m.selected_semester) {
            const y = m.selected_year.match(/\d+/)?.[0];
            const s = m.selected_semester.match(/\d+/)?.[0];
            if (y && s) {
              return NextResponse.redirect(
                new URL(`/s/y${y}s${s}`, origin)
              );
            }
          }
        }
      } catch {
        // Fall through to normal proxy if the lookup fails.
      }
    }
  }

  if (isNextPath(pathname)) {
    return NextResponse.next();
  }

  // Reflex SPA page routes want a trailing slash (without one the
  // backend 307s to add it, infinite-looping with Next.js's default
  // strip). FastAPI routes (/oauth/*, /api/*, /_event/*, /_upload/*,
  // /stripe/*, /ping, /_health, /_all_routes, /auth-codespace) are
  // matched literally without slash. Static assets (file extension)
  // are also kept as-is.
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(pathname);
  const isApiRoute =
    pathname.startsWith("/oauth/") ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_event") ||
    pathname.startsWith("/_upload") ||
    pathname.startsWith("/stripe/") ||
    pathname === "/ping" ||
    pathname === "/_health" ||
    pathname === "/_all_routes" ||
    pathname === "/auth-codespace" ||
    // FastAPI OAuth endpoints — /auth/google/start and /auth/google/callback
    // are registered as both FastAPI routes AND SPA pages, but the FastAPI
    // handler is the one that does the real work (302 to Google / consume
    // the code). Adding a trailing slash makes Reflex serve the SPA page
    // instead, which crashes on self.router.cookies (deprecated in 0.8.x).
    pathname === "/auth/google/start" ||
    pathname === "/auth/google/callback";
  const upstreamPath =
    !hasExtension && !isApiRoute && !pathname.endsWith("/")
      ? `${pathname}/`
      : pathname;
  const upstream = `${REFLEX_BACKEND_URL}${upstreamPath}${search}`;

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("content-length");
  // Forward cookies to the Reflex backend so auth sessions work
  const cookieHeader = req.cookies.toString();
  if (cookieHeader) {
    headers.set("cookie", cookieHeader);
  }

  const upstreamRes = await fetch(upstream, {
    method: req.method,
    headers,
    body:
      req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
    // @ts-expect-error: Node fetch supports duplex for streaming
    duplex: "half",
  });

  const resHeaders = new Headers(upstreamRes.headers);
  resHeaders.delete("content-encoding");
  resHeaders.delete("content-length");
  resHeaders.delete("transfer-encoding");

  // Reflex generates Location headers using the request Host, which is
  // the backend URL under our proxy. Rewrite to the original request
  // origin so redirects stay on alexstudies.com. Edge runtime rejects
  // relative Locations, so we keep the URL absolute.
  const loc = resHeaders.get("location");
  if (loc) {
    const requestOrigin = normalizeOrigin(req.nextUrl.origin);
    const backendOrigin = normalizeOrigin(REFLEX_BACKEND_URL);
    // Rewrite any redirect pointing to the backend origin to the frontend origin.
    const rewritten = loc.replace(
      new RegExp(`^${backendOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"),
      requestOrigin
    );
    if (rewritten !== loc) resHeaders.set("location", rewritten);
  }

  return new NextResponse(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: resHeaders,
  });
}

export const config = {
  // Run on all paths except Next.js static asset internals. The
  // middleware itself decides whether to proxy or pass through.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico).*)",
  ],
};
