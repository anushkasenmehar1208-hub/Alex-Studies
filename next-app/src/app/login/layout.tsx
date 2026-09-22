import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    absolute: "Login - Alex Studies",
  },
  description:
    "Log in or create your Alex Studies account to continue your study plan.",
  alternates: {
    canonical: "https://alexstudies.com/login",
  },
  openGraph: {
    title: "Login - Alex Studies",
    description:
      "Log in or create your Alex Studies account to continue your study plan.",
    url: "https://alexstudies.com/login",
    siteName: "Alex Studies",
    type: "website",
  },
};

export default function LoginLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
