import type { Metadata } from "next";
import { FeatureLandingPage } from "@/components/seo/FeatureLandingPage";

export const metadata: Metadata = {
  title: {
    absolute: "Learn With YouTube Video - Alex Studies",
  },
  description:
    "Learn faster by turning YouTube videos into structured study help inside Alex Studies.",
  alternates: {
    canonical: "https://alexstudies.com/learn-with-youtube",
  },
  openGraph: {
    title: "Learn With YouTube Video - Alex Studies",
    description:
      "Learn faster by turning YouTube videos into structured study help inside Alex Studies.",
    url: "https://alexstudies.com/learn-with-youtube",
    siteName: "Alex Studies",
    type: "website",
  },
};

export default function LearnWithYoutubePage() {
  return (
    <FeatureLandingPage
      eyebrow="Learn with YouTube video"
      title="Learn With YouTube Video"
      description="Learn faster by turning YouTube videos into structured study help inside Alex Studies."
      imageAlt="Alex Studies video learning and notes preview"
      imageSrc="/landing-notes-demo.png"
      points={[
        "Structured video notes",
        "Study help from lessons",
        "Faster review",
      ]}
    />
  );
}
