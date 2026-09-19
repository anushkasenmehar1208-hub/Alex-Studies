import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

export const metadata: Metadata = {
  title: {
    absolute: "Forgot Password - Alex Studies",
  },
  description:
    "Reset your Alex Studies account password.",
  alternates: {
    canonical: "https://alexstudies.com/forgot-password",
  },
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}