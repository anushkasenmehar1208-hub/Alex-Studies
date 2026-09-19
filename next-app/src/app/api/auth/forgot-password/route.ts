export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const email = String(body?.email ?? "").trim().toLowerCase();

    if (!email) {
      return NextResponse.json(
        { error: "Email is required." },
        { status: 400 }
      );
    }

    // Check if user exists with this email
    const rows = await sql<{ user_id: number }[]>`
      SELECT user_id FROM userprofile WHERE LOWER(email) = ${email} LIMIT 1
    `;

    // Always return success to prevent email enumeration
    // but only actually send email if user exists
    if (rows.length > 0) {
      const userId = rows[0].user_id;

      // Generate a reset token (in production, you'd send this via email)
      // For now, we'll just log it and return success
      console.log(`[forgot-password] Password reset requested for user ${userId} (${email})`);
      
      // TODO: Implement actual email sending with a reset token
      // For now, we just acknowledge the request
    }

    return NextResponse.json({
      ok: true,
      message: "If an account exists for that email, a password reset link has been sent."
    });
  } catch (err) {
    console.error("[forgot-password] error:", err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}