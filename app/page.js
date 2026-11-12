
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "../lib/firebase";

export default function Home() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleLogin(event) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      router.replace("/dashboard");
    } catch (err) {
      const messages = {
        "auth/invalid-credential":
          "Email or password is incorrect. Please check and try again.",
        "auth/user-not-found":
          "No account found for this email address.",
        "auth/wrong-password":
          "Incorrect password. Please try again.",
        "auth/invalid-email":
          "Please enter a valid email address.",
        "auth/too-many-requests":
          "Too many attempts. Please wait and try again.",
        "auth/network-request-failed":
          "Network error. Check your internet connection.",
        "auth/operation-not-allowed":
          "Email/password sign-in is not enabled in Firebase.",
      };

      setError(
        messages[err.code] ||
          "Unable to sign in. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-950 px-4 py-10 font-sans text-slate-900 sm:px-6">
      <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-blue-600/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-20 h-96 w-96 rounded-full bg-cyan-500/15 blur-3xl" />

      <div className="relative grid w-full max-w-5xl overflow-hidden rounded-3xl bg-white shadow-2xl shadow-black/30 lg:grid-cols-2">

        {/* Branding Section */}
        <section className="relative hidden flex-col justify-between overflow-hidden bg-gradient-to-br from-blue-950 via-slate-900 to-slate-950 p-10 text-white lg:flex xl:p-12">
          <div className="absolute -right-20 top-28 h-64 w-64 rounded-full border border-white/10" />
          <div className="absolute -right-10 top-38 h-44 w-44 rounded-full border border-white/10" />

          <div className="relative flex items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-white/15 bg-white/10 text-lg font-bold tracking-wide">
              AIL
            </div>

            <div>
              <p className="text-sm font-semibold tracking-wide text-white">
                AMIN INTERNATIONAL LIMITED
              </p>
              <p className="mt-1 text-xs font-medium text-blue-200">
                Company Records &amp; Expiry Tracker
              </p>
            </div>
          </div>

          <div className="relative my-14">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-blue-300/20 bg-blue-400/10 px-3 py-1.5 text-xs font-medium text-blue-100">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              Centralized tracking
            </div>

            <h1 className="max-w-md text-4xl font-semibold leading-tight tracking-tight xl:text-5xl">
              Stay ahead of every expiry.
            </h1>

            <p className="mt-5 max-w-md text-base leading-7 text-slate-300">
              Manage AMC contracts, warranties, vehicle documents,
              software licenses and compliance records in one place.
            </p>

            <div className="mt-9 space-y-4">
              {[
                "Contract and expiry tracking",
                "Upcoming renewal reminders",
                "Centralized records and documents",
              ].map((item) => (
                <div key={item} className="flex items-center gap-3">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-400/15 text-sm text-emerald-300">
                    ✓
                  </span>
                  <span className="text-sm text-slate-200">{item}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="relative text-xs text-slate-400">
            Internal company system · Authorized access only
          </p>
        </section>

        {/* Login Section */}
        <section className="flex items-center justify-center px-6 py-10 sm:px-10 sm:py-12 lg:px-12 xl:px-16">
          <div className="w-full max-w-md">

            {/* Mobile Branding */}
            <div className="mb-9 flex items-center gap-3 lg:hidden">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-950 text-sm font-bold text-white">
                AIL
              </div>

              <div>
                <p className="text-sm font-bold tracking-wide text-slate-900">
                  AMIN INTERNATIONAL LIMITED
                </p>
                <p className="mt-1 text-xs font-medium text-slate-500">
                  Company Records &amp; Expiry Tracker
                </p>
              </div>
            </div>

            <div className="mb-8">
              <p className="text-sm font-semibold text-blue-700">
                WELCOME BACK
              </p>

              <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                Sign in to your account
              </h2>

              <p className="mt-3 text-sm leading-6 text-slate-500">
                Enter your company-authorized credentials to
                access the tracking system.
              </p>
            </div>

            <form onSubmit={handleLogin} className="space-y-5">
              <div>
                <label
                  htmlFor="email"
                  className="mb-2 block text-sm font-medium text-slate-700"
                >
                  Email address
                </label>

                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-500/10"
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label
                    htmlFor="password"
                    className="block text-sm font-medium text-slate-700"
                  >
                    Password
                  </label>
                </div>

                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Enter your password"
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5 pr-20 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-500/10"
                  />

                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-3 text-xs font-semibold text-slate-500 hover:text-blue-700"
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-5 text-red-700"
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-700 px-4 py-3.5 text-sm font-semibold text-white shadow-lg shadow-blue-700/20 transition hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? "Signing in..." : "Sign in"}
                {!loading && <span aria-hidden="true">→</span>}
              </button>
            </form>

            <div className="mt-7 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs leading-5 text-slate-600">
                <span className="font-semibold text-slate-800">
                  Secure access
                </span>
                {" "}Only accounts registered and authorized by your
                company should use this system. Public sign-up is not
                provided on this page.
              </p>
            </div>

            <p className="mt-8 text-center text-xs text-slate-400">
              AMC · Warranty · Insurance · Pollution · Compliance · Software License
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}