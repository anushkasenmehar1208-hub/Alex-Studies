export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { AUTH_TOKEN_LOCAL_STORAGE_KEY, getSessionUserId } from "@/lib/auth";
import { sql } from "@/lib/db";

// Map Next.js onboarding degree codes to the canonical Reflex degree
// names in REGION_DEGREE_OPTIONS (uni_app.py). Mismatched names cause
// Reflex to treat the user as un-onboarded.
const DEGREE_CODE_TO_REFLEX_NAME: Record<string, string> = {
  // Sri Lanka
  se: "Software Engineering",
  elcs: "Electronics and Computer Science (BECS)",
  ps: "Physical Science",
  bs: "Biological Science",
  // UK / US — Next.js uses generic "cs" / "se" with country context
  "cs-uk": "Computer Science (UK)",
  "se-uk": "Software Engineering (UK)",
  "cs-us": "Computer Science (US)",
  "se-us": "Software Engineering (US)",
  // India
  "btech-cs": "B.Tech Computer Science",
  "btech-it": "B.Tech Information Technology",
};

const ONBOARDING_FINAL_STEP = 6;

function resolveDegreeName(country: string, degree: string): string {
  // UK/US share generic codes with Sri Lanka; resolve the country first.
  return DEGREE_CODE_TO_REFLEX_NAME[`${degree}-${country}`]
    ?? DEGREE_CODE_TO_REFLEX_NAME[degree]
    ?? "Custom";
}

// The Next.js form sends scope-codes like "y1s1" / "y2s4" — Reflex
// stores selected_year as "Year N" and selected_semester as "Semester N"
// (its scope_key helper rebuilds y1s1 from those). Decompose the code.
function parseSemesterCode(code: string): { year: string; semester: string } {
  const match = code.trim().toLowerCase().match(/^y(\d+)s(\d+)$/);
  if (match) {
    return { year: `Year ${match[1]}`, semester: `Semester ${match[2]}` };
  }
  // Fallback for already-canonical values like "Semester 1".
  const semMatch = code.match(/semester\s*(\d+)/i);
  const n = semMatch ? parseInt(semMatch[1], 10) : 1;
  const year = n <= 2 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
  return { year: `Year ${year}`, semester: `Semester ${n}` };
}

function readToken(req: NextRequest): string | null {
  // Cookie set by the Next.js login route.
  const fromCookie = req.cookies.get(AUTH_TOKEN_LOCAL_STORAGE_KEY)?.value;
  if (fromCookie) return fromCookie;
  // Fallback: client passes the localStorage token (set by Reflex/Google
  // OAuth) via Authorization: Bearer <token>.
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function POST(req: NextRequest) {
  try {
    const sessionId = readToken(req);
    if (!sessionId) {
      console.log("[onboarding/complete] no token in cookie or header");
      return NextResponse.json(
        { error: "Not authenticated." },
        { status: 401 }
      );
    }

    const userId = await getSessionUserId(sessionId);
    if (!userId) {
      console.log("[onboarding/complete] session not found in DB");
      return NextResponse.json(
        { error: "Session expired." },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => null);
    const country = String(body?.country ?? "").trim().toLowerCase();
    const degree = String(body?.degree ?? "").trim();
    const pathway = body?.pathway ? String(body.pathway).trim() : "";
    const semester = String(body?.semester ?? "").trim();

    if (!country || !degree || !semester) {
      return NextResponse.json(
        { error: "country, degree, and semester are required." },
        { status: 400 }
      );
    }

    const allowedDegrees: Record<string, string[]> = {
      lk: ["se", "elcs", "ps", "bs"],
      uk: ["cs", "se"],
      us: ["cs", "se"],
      in: ["btech-cs", "btech-it"],
    };
    const scope = semester.match(/^y([1-4])s([1-8])$/);
    if (!allowedDegrees[country]?.includes(degree) || !scope ||
        Math.ceil(Number(scope[2]) / 2) !== Number(scope[1]) ||
        ((degree === "ps" || degree === "bs") && !pathway)) {
      return NextResponse.json({ error: "Choose a valid country, degree, pathway, and semester." }, { status: 400 });
    }

    const reflexDegree = resolveDegreeName(country, degree);
    const { year, semester: reflexSemester } = parseSemesterCode(semester);

    await sql`
      INSERT INTO usermemory
        (user_id, step, name, degree, pathway, is_started,
         selected_year, selected_semester, summary, other_degree_text)
      VALUES
        (${userId}, ${ONBOARDING_FINAL_STEP}, '', ${reflexDegree}, ${pathway}, true,
         ${year}, ${reflexSemester}, '', '')
      ON CONFLICT (user_id) DO UPDATE SET
        step = EXCLUDED.step,
        degree = EXCLUDED.degree,
        pathway = EXCLUDED.pathway,
        is_started = EXCLUDED.is_started,
        selected_year = EXCLUDED.selected_year,
        selected_semester = EXCLUDED.selected_semester,
        updated_at = NOW()
    `;

    await sql`
      UPDATE userprofile
      SET is_onboarded = true
      WHERE user_id = ${userId}
    `;

    console.log(
      `[onboarding/complete] saved user_id=${userId} degree=${reflexDegree} year=${year} semester=${reflexSemester}`
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[onboarding/complete] error:", err);
    return NextResponse.json(
      { error: "Something went wrong saving onboarding." },
      { status: 500 }
    );
  }
}
