"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, ChevronDown } from "lucide-react";
import { readBrowserToken } from "@/lib/browser-storage";

type Country = {
  code: string;
  name: string;
  flag: string;
};

type Degree = {
  code: string;
  name: string;
  countries: string[];
};

type Semester = {
  code: string;
  name: string;
};

const countries: Country[] = [
  { code: "uk", name: "United Kingdom", flag: "🇬🇧" },
  { code: "us", name: "United States", flag: "🇺🇸" },
  { code: "in", name: "India", flag: "🇮🇳" },
  { code: "lk", name: "Sri Lanka", flag: "🇱🇰" },
];

const degrees: Degree[] = [
  {
    code: "cs",
    name: "Computer Science",
    countries: ["uk", "us"],
  },
  {
    code: "se",
    name: "Software Engineering",
    countries: ["uk", "us", "lk"],
  },
  {
    code: "elcs",
    name: "Electronics & Computer Science",
    countries: ["lk"],
  },
  {
    code: "ps",
    name: "Physical Science",
    countries: ["lk"],
  },
  {
    code: "bs",
    name: "Biological Science",
    countries: ["lk"],
  },
  {
    code: "btech-cs",
    name: "B.Tech Computer Science",
    countries: ["in"],
  },
  {
    code: "btech-it",
    name: "B.Tech Information Technology",
    countries: ["in"],
  },
];

type Pathway = { code: string; label: string };

const PS_PATHWAYS: Pathway[] = [
  { code: "Applied Mathematics / Physics / Pure Mathematics", label: "Applied Mathematics / Physics / Pure Mathematics" },
  { code: "Computer Science / Physics / Pure Mathematics", label: "Computer Science / Physics / Pure Mathematics" },
  { code: "Electronics / Physics / Pure Mathematics", label: "Electronics / Physics / Pure Mathematics" },
  { code: "Applied Mathematics / Computer Science / Pure Mathematics", label: "Applied Mathematics / Computer Science / Pure Mathematics" },
  { code: "Computer Science / Pure Mathematics / Statistics", label: "Computer Science / Pure Mathematics / Statistics" },
  { code: "Chemistry / Computer Science / Pure Mathematics", label: "Chemistry / Computer Science / Pure Mathematics" },
  { code: "Applied Mathematics / Chemistry / Pure Mathematics", label: "Applied Mathematics / Chemistry / Pure Mathematics" },
  { code: "Computer Studies / Electronics / Physics", label: "Computer Studies / Electronics / Physics" },
  { code: "Applied Mathematics / Pure Mathematics / Statistics", label: "Applied Mathematics / Pure Mathematics / Statistics" },
  { code: "Chemistry / Computer Studies / Pure Mathematics", label: "Chemistry / Computer Studies / Pure Mathematics" },
];

const BS_PATHWAYS: Pathway[] = [
  { code: "Plant Biology-Chemistry-Zoology", label: "Plant Biology-Chemistry-Zoology" },
  { code: "Computer Studies-Chemistry-Plant Biology", label: "Computer Studies-Chemistry-Plant Biology" },
  { code: "Computer Studies-Chemistry-Zoology", label: "Computer Studies-Chemistry-Zoology" },
  { code: "Microbiology-Chemistry-Plant Biology", label: "Microbiology-Chemistry-Plant Biology" },
  { code: "Microbiology-Chemistry-Zoology", label: "Microbiology-Chemistry-Zoology" },
  { code: "Biochemistry-Chemistry-Microbiology", label: "Biochemistry-Chemistry-Microbiology" },
  { code: "Biochemistry-Plant Biology-Chemistry", label: "Biochemistry-Plant Biology-Chemistry" },
  { code: "Biochemistry-Zoology-Chemistry", label: "Biochemistry-Zoology-Chemistry" },
];

const PATHWAYS_BY_DEGREE: Record<string, Pathway[]> = {
  ps: PS_PATHWAYS,
  bs: BS_PATHWAYS,
};

const semesters: Semester[] = [
  { code: "y1s1", name: "Year 1, Semester 1" },
  { code: "y1s2", name: "Year 1, Semester 2" },
  { code: "y2s3", name: "Year 2, Semester 3" },
  { code: "y2s4", name: "Year 2, Semester 4" },
];

const reveal = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
  transition: { duration: 0.25, ease: "easeOut" as const },
};

function OptionCard({
  title,
  prefix,
  selected,
  onClick,
}: {
  title: string;
  prefix?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className="relative min-h-[42px] w-full rounded-[11px] border px-3 py-2 text-left transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/55"
      style={{
        borderColor: selected
          ? "rgba(255,255,255,0.38)"
          : "rgba(255,255,255,0.07)",
        background: selected
          ? "linear-gradient(180deg, rgba(255,255,255,0.075) 0%, rgba(255,255,255,0.04) 100%)"
          : "rgba(255,255,255,0.025)",
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors"
          style={{
            background: selected ? "rgba(255,255,255,0.92)" : "transparent",
            border: selected ? "0" : "1.5px solid rgba(255,255,255,0.2)",
          }}
        >
          {selected && <Check className="h-3 w-3 text-black" />}
        </span>
        <span
          className="min-w-0 text-[0.84rem] leading-tight"
          style={{
            color: selected ? "#fff" : "rgba(220,230,240,0.82)",
            fontWeight: selected ? 700 : 500,
          }}
        >
          {prefix && <span className="mr-1.5">{prefix}</span>}
          {title}
        </span>
      </div>
    </button>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <motion.section {...reveal} className="border-t border-white/[0.06] pt-3.5 first:border-t-0 first:pt-0">
      <h2
        className="mb-2.5 text-[0.98rem] font-extrabold leading-tight text-white"
        style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
      >
        {title}
      </h2>
      {children}
    </motion.section>
  );
}

function SemesterDropdown({
  selected,
  open,
  onOpenChange,
  onSelect,
}: {
  selected: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (semester: string) => void;
}) {
  const selectedLabel = semesters.find((item) => item.code === selected)?.name;

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onOpenChange(false);
        }
      }}
    >
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex h-11 w-full items-center justify-between rounded-[12px] border border-white/[0.08] bg-white/[0.035] px-3 text-left transition-all hover:border-white/20 hover:bg-white/[0.055] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/55"
      >
        <span
          className="text-[0.86rem] font-medium"
          style={{ color: selectedLabel ? "white" : "rgba(226,232,240,0.5)" }}
        >
          {selectedLabel ?? "Select semester"}
        </span>
        <ChevronDown
          className={`h-4 w-4 text-white/48 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            {...reveal}
            role="listbox"
            className="mt-2 overflow-hidden rounded-[12px] border border-white/[0.09] bg-[#050505] p-1 shadow-[0_22px_50px_rgba(0,0,0,0.5)]"
          >
            {semesters.map((item) => {
              const isSelected = selected === item.code;
              return (
                <button
                  key={item.code}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onSelect(item.code);
                    onOpenChange(false);
                  }}
                  className="flex h-9 w-full items-center justify-between rounded-[9px] px-3 text-left text-[0.82rem] transition-colors hover:bg-white/[0.07] focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/45"
                  style={{
                    color: isSelected ? "white" : "rgba(220,230,240,0.76)",
                    background: isSelected ? "rgba(255,255,255,0.075)" : "transparent",
                    fontWeight: isSelected ? 700 : 500,
                  }}
                >
                  {item.name}
                  {isSelected && <Check className="h-3.5 w-3.5 text-white/85" />}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PathwayDropdown({
  options,
  selected,
  open,
  onOpenChange,
  onSelect,
}: {
  options: Pathway[];
  selected: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (pathway: string) => void;
}) {
  const selectedLabel = options.find((item) => item.code === selected)?.label;

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onOpenChange(false);
        }
      }}
    >
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex h-11 w-full items-center justify-between gap-2 rounded-[12px] border border-white/[0.08] bg-white/[0.035] px-3 text-left transition-all hover:border-white/20 hover:bg-white/[0.055] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/55"
      >
        <span
          className="truncate text-[0.84rem] font-medium"
          style={{ color: selectedLabel ? "white" : "rgba(226,232,240,0.5)" }}
        >
          {selectedLabel ?? "Select pathway"}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-white/48 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            {...reveal}
            role="listbox"
            className="mt-2 max-h-[260px] overflow-y-auto overflow-x-hidden rounded-[12px] border border-white/[0.09] bg-[#050505] p-1 shadow-[0_22px_50px_rgba(0,0,0,0.5)]"
            style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.18) transparent" }}
          >
            {options.map((item) => {
              const isSelected = selected === item.code;
              return (
                <button
                  key={item.code}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onSelect(item.code);
                    onOpenChange(false);
                  }}
                  className="flex min-h-9 w-full items-center justify-between gap-2 rounded-[9px] px-3 py-1.5 text-left text-[0.8rem] transition-colors hover:bg-white/[0.07] focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/45"
                  style={{
                    color: isSelected ? "white" : "rgba(220,230,240,0.78)",
                    background: isSelected ? "rgba(255,255,255,0.075)" : "transparent",
                    fontWeight: isSelected ? 700 : 500,
                  }}
                >
                  <span className="leading-tight">{item.label}</span>
                  {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-white/85" />}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function OnboardingPage() {
  const [country, setCountry] = useState("");
  const [degree, setDegree] = useState("");
  const [pathway, setPathway] = useState("");
  const [pathwayOpen, setPathwayOpen] = useState(false);
  const [semester, setSemester] = useState("");
  const [semesterOpen, setSemesterOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // True until the status check confirms the user still needs to
  // onboard — keeps the form hidden so already-onboarded users don't
  // see a flash before the /app redirect kicks in.
  const [checkingStatus, setCheckingStatus] = useState(true);

  useEffect(() => {
    const token = readBrowserToken("_auth_token");
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    fetch("/api/onboarding/status", { headers })
      .then((r) => {
        if (r.status === 401) {
          window.location.href = "/login";
          return null;
        }
        if (!r.ok) throw new Error("Could not load your study plan.");
        return r.json();
      })
      .then((data) => {
        const m = data?.memory;
        if (m && m.is_started && m.degree && m.selected_year && m.selected_semester) {
          window.location.href = "/app";
          return;
        }
        setCheckingStatus(false);
      })
      .catch(() => setCheckingStatus(false));
  }, []);

  const visibleDegrees = useMemo(
    () => degrees.filter((item) => item.countries.includes(country)),
    [country],
  );
  const pathwayOptions = PATHWAYS_BY_DEGREE[degree];
  const needsPathway = Boolean(pathwayOptions);
  const pathwayReady = !needsPathway || Boolean(pathway);
  const canFinish = Boolean(country && degree && pathwayReady && semester && !loading);

  function chooseCountry(nextCountry: string) {
    setCountry(nextCountry);
    setDegree("");
    setPathway("");
    setSemester("");
    setSemesterOpen(false);
    setPathwayOpen(false);
  }

  function chooseDegree(nextDegree: string) {
    setDegree(nextDegree);
    setPathway("");
    setSemester("");
    setSemesterOpen(false);
    setPathwayOpen(false);
  }

  function choosePathway(nextPathway: string) {
    setPathway(nextPathway);
    setSemester("");
    setSemesterOpen(false);
  }

  async function handleFinish() {
    if (!canFinish) return;
    setLoading(true);
    setError("");
    try {
      // Google OAuth users only have the token in localStorage (no
      // cookie), so forward it explicitly. Reflex stores the token
      // as a JSON-quoted string, so strip the quotes if present.
      const token = readBrowserToken("_auth_token");
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const response = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers,
        body: JSON.stringify({ country, degree, pathway: pathway || null, semester }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || "Could not save your study plan. Please try again.");
      }
      // The ?onboarded=1&scope=y1s1 flag tells the middleware to 302
      // directly to /s/y{N}s{M}, skipping Reflex's hydration race
      // (which otherwise lands the user on /select or shows the
      // onboarding form on /app). We include the scope in the URL
      // because Safari Private doesn't reliably set our auth cookie,
      // so the middleware can't look it up via the status endpoint.
      window.location.href = `/app?onboarded=1&scope=${encodeURIComponent(semester)}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your study plan. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (checkingStatus) {
    return (
      <div
        className="relative flex h-dvh min-h-screen items-center justify-center"
        style={{ background: "#000000" }}
      />
    );
  }

  return (
    <div
      className="relative flex h-dvh min-h-screen items-center justify-center overflow-hidden px-4 py-5"
      style={{ background: "#000000" }}
    >
      <div
        aria-hidden
        className="fixed pointer-events-none"
        style={{
          top: 0,
          right: "-20vw",
          width: "55vw",
          height: "100vh",
          background:
            "radial-gradient(ellipse at center, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.06) 45%, transparent 75%)",
          filter: "blur(60px)",
          zIndex: 0,
        }}
      />
      <div
        aria-hidden
        className="fixed inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(255,255,255,0.055) 0.75px, transparent 0.95px) 0 0 / 18px 18px",
          opacity: 0.22,
          zIndex: 1,
        }}
      />
      <div
        aria-hidden
        className="fixed inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(255,255,255,0.09) 1px, transparent 1.8px) 0 0 / 22px 22px",
          opacity: 0.55,
          WebkitMaskImage:
            "radial-gradient(circle at 84% 52%, rgba(0,0,0,1) 0%, rgba(0,0,0,0.55) 38%, transparent 70%)",
          maskImage:
            "radial-gradient(circle at 84% 52%, rgba(0,0,0,1) 0%, rgba(0,0,0,0.55) 38%, transparent 70%)",
          zIndex: 2,
        }}
      />

      <main className="relative z-[4] w-full max-w-[400px]">
        <div
          className="max-h-[calc(100dvh-40px)] overflow-y-auto overflow-x-hidden rounded-3xl px-5 py-5 sm:px-6"
          style={{
            background: "#020202",
            border: "1px solid rgba(255,255,255,0.04)",
            boxShadow:
              "0 40px 100px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.02)",
            scrollbarWidth: "thin",
            scrollbarColor: "rgba(255,255,255,0.18) transparent",
          }}
        >
          <div className="mb-4">
            <p className="mb-1 text-[0.64rem] font-bold uppercase tracking-[0.22em] text-white/55">
              Welcome
            </p>
            <h1
              className="text-[1.45rem] font-extrabold leading-tight text-white"
              style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
            >
              Set Up Alex
            </h1>
          </div>

          <div className="space-y-3.5">
            <Section
              title="Where do you study?"
            >
              <div className="grid grid-cols-2 gap-3">
                {countries.map((item) => (
                  <OptionCard
                    key={item.code}
                    title={item.name}
                    prefix={item.flag}
                    selected={country === item.code}
                    onClick={() => chooseCountry(item.code)}
                  />
                ))}
              </div>
            </Section>

            {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
            <AnimatePresence initial={false}>
              {country && (
                <Section
                  key="degree"
                  title="What are you studying?"
                >
                  <div className="grid gap-2">
                    {visibleDegrees.map((item) => (
                      <OptionCard
                        key={item.code}
                        title={item.name}
                        selected={degree === item.code}
                        onClick={() => chooseDegree(item.code)}
                      />
                    ))}
                  </div>
                </Section>
              )}

              {degree && needsPathway && (
                <Section
                  key="pathway"
                  title="Choose your pathway"
                >
                  <PathwayDropdown
                    options={pathwayOptions!}
                    selected={pathway}
                    open={pathwayOpen}
                    onOpenChange={setPathwayOpen}
                    onSelect={choosePathway}
                  />
                </Section>
              )}

              {degree && pathwayReady && (
                <Section
                  key="semester"
                  title="Which semester are you in?"
                >
                  <SemesterDropdown
                    selected={semester}
                    open={semesterOpen}
                    onOpenChange={setSemesterOpen}
                    onSelect={setSemester}
                  />
                </Section>
              )}

              {(canFinish || loading) && (
                <motion.div
                  key="cta"
                  {...reveal}
                  className="border-t border-white/[0.06] pt-4"
                >
                  <button
                    type="button"
                    onClick={handleFinish}
                    disabled={!canFinish}
                    className="inline-flex h-11 w-full items-center justify-center rounded-[14px] bg-white font-bold text-black transition-all hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {loading ? "Opening Alex..." : "See Alex →"}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>
    </div>
  );
}
