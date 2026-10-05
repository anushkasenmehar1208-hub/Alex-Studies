export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_TOKEN_LOCAL_STORAGE_KEY,
  createSession,
  createUser,
  findUserByUsername,
  GUEST_TOKEN_LOCAL_STORAGE_KEY,
  migrateGuestMemoryToUser,
  storeUserProfileEmail,
} from "@/lib/auth";

const USERNAME_REGEX = /^[a-zA-Z0-9_.-]{3,32}$/;

function normalizeGuestToken(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let token = raw;
  try {
    token = decodeURIComponent(token).trim();
  } catch {}
  try {
    const parsed = JSON.parse(token) as unknown;
    if (typeof parsed === "string") token = parsed.trim();
  } catch {}
  return token;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const username = String(body?.username ?? "").trim();
    const email = String(body?.email ?? "").trim();
    const password = String(body?.password ?? "");
    const guestToken =
      normalizeGuestToken(body?.guestToken) ||
      normalizeGuestToken(req.cookies.get(GUEST_TOKEN_LOCAL_STORAGE_KEY)?.value);

    if (!username || !email || !password) {
      return NextResponse.json(
        { error: "All fields are required." },
        { status: 400 }
      );
    }

    if (!USERNAME_REGEX.test(username)) {
      return NextResponse.json(
        {
          error:
            "Username must be 3-32 characters and only contain letters, numbers, dots, dashes, or underscores.",
        },
        { status: 400 }
      );
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }

    if (Buffer.byteLength(password, "utf8") > 72) {
      return NextResponse.json({ error: "Password must be at most 72 UTF-8 bytes." }, { status: 400 });
    }

    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters with a letter and a number." },
        { status: 400 }
      );
    }

    const existing = await findUserByUsername(username);
    if (existing) {
      return NextResponse.json(
        { error: "That username is already taken." },
        { status: 409 }
      );
    }

    const user = await createUser(username, password);
    await storeUserProfileEmail(user.id, email);
    await migrateGuestMemoryToUser(guestToken, user.id);
    const sessionId = await createSession(user.id);

    const res = NextResponse.json({
      ok: true,
      token: sessionId,
      tokenKey: AUTH_TOKEN_LOCAL_STORAGE_KEY,
    });

    res.cookies.set(AUTH_TOKEN_LOCAL_STORAGE_KEY, sessionId, {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
    });
    if (guestToken) {
      res.cookies.set(GUEST_TOKEN_LOCAL_STORAGE_KEY, guestToken, {
        httpOnly: false,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 10 * 60,
        path: "/",
      });
    }

    return res;
  } catch (err) {
    console.error("[register] error:", err);
    return NextResponse.json(
      { error: "Something went wrong. Try again." },
      { status: 500 }
    );
  }
}
