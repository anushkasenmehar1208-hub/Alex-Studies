"use client";

import Link from "next/link";
import Image from "next/image";

export function Hero() {
  return (
    <section
      id="landing-hero-content"
      className="relative w-full flex flex-col items-center text-center mx-auto"
      style={{
        zIndex: 4,
        maxWidth: "min(1080px, calc(100vw - 32px))",
        padding: "16px 16px 48px",
      }}
    >
      <div className="hidden md:block" style={{ height: "8px" }} />

      <div
        style={{
          padding: "10px 16px",
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(255,255,255,0.03)",
          borderRadius: 999,
          boxShadow: "0 18px 44px rgba(0,0,0,0.24)",
          color: "rgba(255,255,255,0.74)",
          fontSize: "0.82rem",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: 32,
        }}
      >
        ALEX AI, YOUR ACADEMIC MENTOR
      </div>

      <h1
        style={{
          fontFamily: "'Plus Jakarta Sans', 'Space Grotesk', sans-serif",
          fontWeight: 500,
          lineHeight: 1.04,
          color: "rgba(255,255,255,0.96)",
          fontSize: "clamp(2.55rem, 4.1vw, 3.6rem)",
          margin: 0,
        }}
        className="mb-6 max-md:!text-[clamp(1.92rem,6.8vw,3rem)]"
      >
        AI that teaches your full
        <br />
        university semester day by day
      </h1>

      <p
        style={{
          color: "rgba(255,255,255,0.48)",
          fontSize: "1.06rem",
          lineHeight: 1.7,
          maxWidth: 720,
          margin: "0 auto 36px",
        }}
        className="max-md:!text-[0.98rem]"
      >
        Choose your degree, get a real semester plan, and let Alex teach, quiz,
        track tasks, and help you study every day.
      </p>

      <Link
        href="/select"
        className="landing-main-cta--solid mb-7"
      >
        Start My Study Plan
      </Link>

      <div className="proof-chip">
        <span className="relative flex h-2 w-2">
          <span
            className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
            style={{ background: "rgba(94,211,132,0.95)" }}
          />
          <span
            className="relative inline-flex rounded-full h-2 w-2"
            style={{ background: "rgba(94,211,132,0.95)" }}
          />
        </span>
        Now in early access — be one of our first 500 students
      </div>

      <LogoVideoCard />
    </section>
  );
}

function LogoVideoCard() {
  return (
    <div
      className="w-full mt-24"
      style={{
        maxWidth: 1240,
        padding: 26,
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 32,
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)",
        boxShadow: "0 32px 90px rgba(0,0,0,0.36)",
      }}
    >
      <div className="flex flex-col md:flex-row gap-8 items-center text-left">
        <div className="flex-1 max-w-[360px] flex flex-col gap-4">
          <h3
            style={{
              color: "rgba(255,255,255,0.94)",
              fontSize: "1.6rem",
              fontWeight: 600,
              lineHeight: 1.15,
              margin: 0,
            }}
          >
            See how Alex teaches your semester
          </h3>
          <p
            style={{
              color: "rgba(255,255,255,0.56)",
              fontSize: "0.98rem",
              lineHeight: 1.7,
              margin: 0,
            }}
          >
            Alex builds your semester plan, teaches each day&apos;s topic, and
            helps you continue without getting lost.
          </p>
          <div className="flex flex-col gap-2.5 mt-2">
            {[
              "Choose degree → get full semester plan",
              "Learn daily with AI teaching",
              "Notes, tasks, quizzes, and voice in one place",
            ].map((text) => (
              <span key={text} className="proof-chip w-fit">
                {text}
              </span>
            ))}
          </div>
        </div>
        <div
          className="relative flex-1 w-full max-w-[760px]"
          style={{
            height: 430,
            borderRadius: 24,
            border: "1px solid rgba(255,255,255,0.08)",
            overflow: "hidden",
            boxShadow: "0 32px 80px rgba(0,0,0,0.42)",
          }}
        >
          <Image
            src="/landing-hero-demo.png"
            alt="Alex AI study plan preview"
            fill
            sizes="(max-width: 768px) 100vw, 760px"
            style={{
              objectFit: "cover",
              filter: "brightness(1.38) contrast(1.08) saturate(1.05)",
              opacity: 0.98,
            }}
          />
        </div>
      </div>
    </div>
  );
}
