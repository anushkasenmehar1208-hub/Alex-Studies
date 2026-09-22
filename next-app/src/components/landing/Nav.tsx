import Link from "next/link";
import Image from "next/image";

export function Nav() {
  return (
    <header
      className="relative w-full flex items-center justify-between px-4 md:px-7 py-5 max-w-[1280px] mx-auto"
      style={{ zIndex: 5 }}
    >
      <Link href="/" className="flex items-center gap-2.5">
        <Image
          src="/a_logo.png"
          alt=""
          width={22}
          height={22}
          className="rounded-md"
        />
        <span
          style={{
            color: "rgba(255,255,255,0.94)",
            fontSize: "1.04rem",
            fontWeight: 700,
            fontFamily: "'Space Grotesk', 'Plus Jakarta Sans', sans-serif",
          }}
        >
          Alex AI
        </span>
      </Link>

      <nav className="flex items-center gap-2.5">
<Link href="/" className="landing-nav-cta">
          Home
</Link>
        <Link href="/login" className="landing-nav-cta">
          Login
        </Link>
      </nav>
    </header>
  );
}
