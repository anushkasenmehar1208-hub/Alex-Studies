"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthCard } from "@/components/auth/AuthCard";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { Eye, EyeOff } from "lucide-react";

export default function LoginPage() {
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  function readGuestToken() {
    const raw =
      typeof window !== "undefined"
        ? window.localStorage.getItem("alex_guest_token") ?? ""
        : "";
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : raw;
    } catch {
      return raw;
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          guestToken: readGuestToken(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.token) {
        // Sync Reflex auth: it reads this localStorage key on app load.
        try {
          localStorage.setItem(data.tokenKey, JSON.stringify(data.token));
        } catch {}
        // Reflex uses scope-based routing. The authenticated landing route
        // is /s/home (home scope) which handles onboarding for new users
        // and routes already-onboarded users to their semester.
        window.location.href = "/s/home";
      } else {
        setError(data.error || "Invalid username or password.");
      }
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard
      title="Welcome Back"
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link
            href="/register"
            className="text-white hover:text-white/80 font-medium underline-offset-4 hover:underline"
          >
            Register
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        <GoogleButton />

        <div className="flex items-center py-2 text-white/40 text-[0.8rem] font-medium">
          <div className="h-px flex-1 bg-white/[0.08]" />
          <span className="px-3">or</span>
          <div className="h-px flex-1 bg-white/[0.08]" />
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-white/[0.45] text-[0.78rem] mb-0.5 font-medium">
              Username
            </label>
            <input
              type="text"
              required
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="alex.doe"
              className="h-[38px] w-full rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3.5 text-[0.88rem] text-white placeholder:text-white/30 outline-none transition-colors focus:border-white/[0.2]"
            />
          </div>

          <div>
            <label className="block text-white/[0.45] text-[0.78rem] mb-0.5 font-medium">
              Password
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="h-[38px] w-full rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3.5 pr-10 text-[0.88rem] text-white placeholder:text-white/30 outline-none transition-colors focus:border-white/[0.2]"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-[10px] top-1/2 flex h-5 -translate-y-1/2 items-center border-none bg-transparent p-0 text-white/[0.35] transition-colors hover:text-white/70"
              >
                {showPassword ? (
                  <EyeOff size={15} />
                ) : (
                  <Eye size={15} />
                )}
              </button>
            </div>
          </div>

          {error && (
            <div className="text-red-400 text-[0.88rem] bg-red-500/[0.08] border border-red-500/20 rounded-xl px-3.5 py-2.5">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="h-[46px] w-full rounded-[10px] bg-white text-[14px] font-bold text-black transition-colors hover:bg-[#f0f0f0] disabled:cursor-not-allowed disabled:opacity-50"
            style={{ marginTop: 18 }}
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>

          <div className="text-center">
            <Link
              href="/forgot-password"
              className="text-white/40 hover:text-white/80 text-[0.82rem] transition-colors"
            >
              Forgot password?
            </Link>
          </div>
        </form>
      </div>
    </AuthCard>
  );
}
