import type { Metadata } from "next";
import { FeatureLandingPage } from "@/components/seo/FeatureLandingPage";

export const metadata: Metadata = {
  title: {
    absolute: "Exam Paper Predictor - Alex Studies",
  },
  description:
    "Upload past papers and generate a smart predicted exam paper to guide your preparation.",
  alternates: {
    canonical: "https://alexstudies.com/exam-forecast",
  },
  openGraph: {
    title: "Exam Paper Predictor - Alex Studies",
    description:
      "Upload past papers and generate a smart predicted exam paper to guide your preparation.",
    url: "https://alexstudies.com/exam-forecast",
    siteName: "Alex Studies",
    type: "website",
  },
};

export default function ExamForecastPage() {
  return (
    <FeatureLandingPage
      eyebrow="Exam paper predictor"
      title="Exam Paper Predictor"
      description="Upload past papers and generate a smart predicted exam paper to guide your preparation."
      imageAlt="Alex Studies quiz and exam preparation preview"
      imageSrc="/landing-quiz-demo.png"
      points={[
        "Past paper guidance",
        "Predicted exam practice",
        "Smarter preparation",
      ]}
    />
  );
}
