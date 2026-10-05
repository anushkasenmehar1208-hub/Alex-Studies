import { NextResponse } from "next/server";

// Do not claim delivery until a token-based email recovery flow is configured.
export async function POST() {
  return NextResponse.json(
    { error: "Email password reset is not available yet. Contact support.alexstudies@gmail.com for account recovery." },
    { status: 503 },
  );
}
