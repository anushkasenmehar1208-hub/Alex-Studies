import Image from "next/image";
import Link from "next/link";

type FeatureLandingPageProps = {
  eyebrow: string;
  title: string;
  description: string;
  imageAlt: string;
  imageSrc: string;
  points: string[];
};

export function FeatureLandingPage({
  eyebrow,
  title,
  description,
  imageAlt,
  imageSrc,
  points,
}: FeatureLandingPageProps) {
  return (
    <main
      className="min-h-screen"
      style={{
        background:
          "radial-gradient(circle at 80% 10%, rgba(255,255,255,0.11), transparent 32%), #000",
      }}
    >
      <nav className="mx-auto flex max-w-[1120px] items-center justify-between px-5 py-6">
<a
           href="/"
           className="text-[1rem] font-bold text-white/90 no-underline"
         >
           Alex Studies
</a>
        <div className="flex items-center gap-2.5">
          <Link href="/login" className="landing-nav-cta">
            Login
          </Link>
<a href="/app" className="landing-nav-cta">
            Start
</a>
        </div>
      </nav>

      <section className="mx-auto grid max-w-[1120px] items-center gap-10 px-5 pb-20 pt-10 md:grid-cols-[1.02fr_0.98fr] md:pt-20">
        <div>
          <p className="landing-eyebrow mb-5">{eyebrow}</p>
          <h1 className="landing-heading mb-6 text-[clamp(2.4rem,5vw,4.7rem)]">
            {title}
          </h1>
          <p className="landing-sub mb-8 max-w-[640px] text-[1.05rem]">
            {description}
          </p>
<a href="/app" className="landing-main-cta--solid">
            Start Your Study Plan
</a>
          <div className="mt-7 flex flex-wrap gap-2.5">
            {points.map((point) => (
              <span key={point} className="proof-chip">
                {point}
              </span>
            ))}
          </div>
        </div>

        <div
          className="relative min-h-[300px] overflow-hidden rounded-[24px] border border-white/[0.08] md:min-h-[430px]"
          style={{
            background: "rgba(255,255,255,0.03)",
            boxShadow: "0 32px 88px rgba(0,0,0,0.42)",
          }}
        >
          <Image
            src={imageSrc}
            alt={imageAlt}
            fill
            sizes="(max-width: 768px) 100vw, 520px"
            style={{
              objectFit: "cover",
              filter: "brightness(1.16) contrast(1.06)",
            }}
          />
        </div>
      </section>
    </main>
  );
}
