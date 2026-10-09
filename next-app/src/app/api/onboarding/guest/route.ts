import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
const DEMO_SUMMARY = "Anonymous exhibition session. No prior achievements or completed topics are known.";

// Same capability-derived reserved namespace as Reflex _guest_uid_from_token.
// No request-supplied numeric id can access an authenticated student's records.
function guestId(req: NextRequest): number | null {
  const token = req.headers.get("x-alex-guest-token") ?? "";
  if (!/^g_[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  const digest = createHash("sha256").update(`alex-guest:${token}`).digest("hex");
  return 1500000000 + (parseInt(digest.slice(0, 12), 16) % 450000000);
}

export async function GET(req: NextRequest) {
  const uid = guestId(req);
  if (uid === null) return NextResponse.json({ error: "Visitor session required." }, { status: 401 });
  try {
    const rows = await sql`SELECT degree, pathway, selected_year, selected_semester, is_started, summary
      FROM usermemory WHERE user_id = ${uid} LIMIT 1`;
    const memory = rows[0] ?? null;
    // Demo defaults are workspace availability, not completed onboarding.
    return NextResponse.json({ memory: memory ? {
      degree: memory.degree, pathway: memory.pathway,
      selected_year: memory.selected_year, selected_semester: memory.selected_semester,
      is_started: Boolean(memory.is_started && memory.summary !== DEMO_SUMMARY),
    } : null }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load your study plan. Please try again." }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const uid = guestId(req);
  if (uid === null) return NextResponse.json({ error: "Visitor session required." }, { status: 401 });
  const body = await req.json().catch(() => null);
  const country = String(body?.country ?? "").trim().toLowerCase();
  const degree = String(body?.degree ?? "").trim();
  const pathway = String(body?.pathway ?? "").trim();
  const semester = String(body?.semester ?? "").trim();
  const names: Record<string, Record<string, string>> = {
    lk: { se: "Software Engineering", elcs: "Electronics and Computer Science (BECS)", ps: "Physical Science", bs: "Biological Science" },
    uk: { cs: "Computer Science (UK)", se: "Software Engineering (UK)" },
    us: { cs: "Computer Science (US)", se: "Software Engineering (US)" },
    in: { "btech-cs": "B.Tech Computer Science", "btech-it": "B.Tech Information Technology" },
  };
  const name = names[country]?.[degree];
  const scope = semester.match(/^y([1-4])s([1-8])$/);
  if (!name || !scope || Math.ceil(Number(scope[2]) / 2) !== Number(scope[1]) ||
      ((degree === "ps" || degree === "bs") && !pathway) || pathway.length > 200) {
    return NextResponse.json({ error: "Choose a valid country, degree, pathway, and semester." }, { status: 400 });
  }
  try {
    await sql`INSERT INTO usermemory
      (user_id, step, name, degree, pathway, is_started, selected_year, selected_semester, summary, other_degree_text)
      VALUES (${uid}, 6, 'Visitor', ${name}, ${pathway}, true, ${`Year ${scope[1]}`}, ${`Semester ${scope[2]}`}, '', '')
      ON CONFLICT (user_id) DO UPDATE SET
        step = EXCLUDED.step, degree = EXCLUDED.degree, pathway = EXCLUDED.pathway,
        is_started = true, selected_year = EXCLUDED.selected_year, selected_semester = EXCLUDED.selected_semester,
        summary = CASE WHEN usermemory.summary = ${DEMO_SUMMARY} THEN '' ELSE usermemory.summary END,
        updated_at = NOW()`;
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not save your study plan. Please try again." }, { status: 503 });
  }
}
