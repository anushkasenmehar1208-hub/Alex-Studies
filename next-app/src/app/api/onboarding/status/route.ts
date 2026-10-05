export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { AUTH_TOKEN_LOCAL_STORAGE_KEY, getSessionUserId } from "@/lib/auth";
import { sql } from "@/lib/db";

// Debug endpoint: returns the current user's UserProfile/UserMemory
// state so we can verify whether onboarding writes are landing.
function readToken(req: NextRequest): string | null {
  const fromCookie = req.cookies.get(AUTH_TOKEN_LOCAL_STORAGE_KEY)?.value;
  if (fromCookie) return fromCookie;
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function GET(req: NextRequest) {
  try {
    const sessionId = readToken(req);
    if (!sessionId) {
      return NextResponse.json(
        { error: "no token in cookie or header" },
        { status: 401 }
      );
    }
    const userId = await getSessionUserId(sessionId);
    if (!userId) {
      return NextResponse.json({ error: "session expired" }, { status: 401 });
    }

    const memory = await sql<
      {
        step: number;
        degree: string;
        pathway: string;
        is_started: boolean;
        selected_year: string;
        selected_semester: string;
      }[]
    >`
      SELECT step, degree, pathway, is_started, selected_year, selected_semester
      FROM usermemory
      WHERE user_id = ${userId}
      LIMIT 1
    `;

    const profile = await sql<{ is_onboarded: boolean }[]>`
      SELECT is_onboarded FROM userprofile WHERE user_id = ${userId} LIMIT 1
    `;

    return NextResponse.json({
      user_id: userId,
      memory: memory[0] ?? null,
      profile: profile[0] ?? null,
    });
  } catch (err) {
    console.error("[onboarding/status] error:", err);
    return NextResponse.json({ error: "Could not load your study plan. Please try again." }, { status: 503 });
  }
}
