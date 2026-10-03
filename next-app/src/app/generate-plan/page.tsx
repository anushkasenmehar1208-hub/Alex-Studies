import type { Metadata } from "next";
import { FeatureLandingPage } from "@/components/seo/FeatureLandingPage";

export const metadata: Metadata = {
  title: {
    absolute: "Generate My Study Plan - Alex Studies",
  },
  description:
    "Turn your degree into a clear semester study plan with daily tasks and guidance.",
  alternates: {
    canonical: "https://alexstudies.com/generate-plan",
  },
  openGraph: {
    title: "Generate My Study Plan - Alex Studies",
    description:
      "Turn your degree into a clear semester study plan with daily tasks and guidance.",
    url: "https://alexstudies.com/generate-plan",
    siteName: "Alex Studies",
    type: "website",
  },
};

export default function GeneratePlanPage() {
  return (
    <FeatureLandingPage
      eyebrow="Generate my plan"
      title="Generate My Study Plan"
      description="Turn your degree into a clear semester study plan with daily tasks and guidance."
      imageAlt="Alex Studies day-by-day study plan preview"
      imageSrc="/landing-hero-demo.png"
      points={[
        "Degree-based planning",
        "Daily study tasks",
        "Guided semester structure",
      ]}
    />
  );
}
