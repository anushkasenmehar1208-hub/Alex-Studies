import type { Metadata } from "next";
import OnboardingPage from "../onboarding/page";

export const metadata: Metadata = {
  title: {
    absolute: "Start Your Study Plan - Alex Studies",
  },
  description:
    "Choose your degree and build a clear day-by-day study plan with Alex Studies.",
  alternates: {
    canonical: "https://alexstudies.com/select",
  },
  openGraph: {
    title: "Start Your Study Plan - Alex Studies",
    description:
      "Choose your degree and build a clear day-by-day study plan with Alex Studies.",
    url: "https://alexstudies.com/select",
    siteName: "Alex Studies",
    type: "website",
  },
};

export default function SelectPage() {
  return <OnboardingPage />;
}
