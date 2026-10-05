import Link from "next/link";
import { AuthCard } from "./AuthCard";

export function ForgotPasswordForm() {
  return (
    <AuthCard title="Account recovery">
      <div className="space-y-5 text-sm text-white/70">
        <p>Email password reset is not available yet. Contact support for help recovering your account.</p>
        <a className="block break-words text-white underline" href="mailto:support.alexstudies@gmail.com?subject=Account%20recovery">
          support.alexstudies@gmail.com
        </a>
        <p>If you registered with Google, use Continue with Google on the login page.</p>
        <Link href="/login" className="block text-white underline">Back to login</Link>
      </div>
    </AuthCard>
  );
}
