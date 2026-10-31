
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import {
    collection,
    doc,
    getDoc,
    getDocs,
    serverTimestamp,
    setDoc,
} from "firebase/firestore";
import { auth, db } from "../../../lib/firebase";

const SUPER_ADMIN_UID = "gm7L9ZxaqOUIm9qBP9Lf2sxDLh92";
const SETTINGS_REF = doc(db, "app_settings", "expiryReminders");

const DEFAULT_DAYS = [10, 3, 1, 0];
const DEFAULT_EMAIL_TIME = "09:30";

const MODULES = [
    "AMC",
    "Warranty",
    "Insurance",
    "Pollution",
    "Compliance",
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 06:00 AM to 10:00 PM, every 15 minutes.
const EMAIL_TIME_OPTIONS = Array.from(
    { length: 65 },
    (_, index) => {
        const totalMinutes = 360 + index * 15;
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        return `${String(hours).padStart(2, "0")}:${String(
            minutes
        ).padStart(2, "0")}`;
    }
);

function formatTimeLabel(value) {
    const [hours, minutes] = value.split(":").map(Number);
    const suffix = hours >= 12 ? "PM" : "AM";
    const displayHour = hours % 12 || 12;

    return `${String(displayHour).padStart(2, "0")}:${String(
        minutes
    ).padStart(2, "0")} ${suffix}`;
}

function normalizeRole(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[_-]/g, " ")
        .replace(/\s+/g, " ");
}

function isSuperAdminUser(user, profile) {
    const role = normalizeRole(profile?.role);

    return user.uid === SUPER_ADMIN_UID || (
        profile?.active !== false &&
        ["super admin", "superadmin"].includes(role)
    );
}

function cleanReminderDays(value) {
    if (!Array.isArray(value)) return DEFAULT_DAYS;

    const numbers = value
        .map(Number)
        .filter(
            (day) =>
                Number.isInteger(day) &&
                day >= 0 &&
                day <= 365
        );

    return [...new Set([...numbers, 0])]
        .sort((a, b) => b - a);
}

function cleanEmailTime(value) {
    return EMAIL_TIME_OPTIONS.includes(value)
        ? value
        : DEFAULT_EMAIL_TIME;
}

export default function ReminderSettingsPage() {
    const router = useRouter();

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [allowed, setAllowed] = useState(false);

    const [daysText, setDaysText] = useState("10, 3, 1, 0");
    const [emailTime, setEmailTime] = useState(DEFAULT_EMAIL_TIME);

    const [users, setUsers] = useState([]);

    const [moduleOperators, setModuleOperators] = useState({
        AMC: [],
        Warranty: [],
        Insurance: [],
        Pollution: [],
        Compliance: [],
    });

    const [message, setMessage] = useState("");
    const [error, setError] = useState("");

    useEffect(() => {
        let cancelled = false;

        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            if (!user) {
                router.replace("/");
                return;
            }

            setLoading(true);

            try {
                const profileSnapshot = await getDoc(
                    doc(db, "users", user.uid)
                );

                const profile = profileSnapshot.exists()
                    ? profileSnapshot.data()
                    : {};

                const permitted = isSuperAdminUser(user, profile);

                if (cancelled) return;

                setAllowed(permitted);

                if (!permitted) {
                    setError(
                        "Only Super Admin can change expiry reminder settings."
                    );
                    setLoading(false);
                    return;
                }

                const [settingsSnapshot, usersSnapshot] =
                    await Promise.all([
                        getDoc(SETTINGS_REF),
                        getDocs(collection(db, "users")),
                    ]);

                const settings = settingsSnapshot.exists()
                    ? settingsSnapshot.data()
                    : {};

                const activeUsers = usersSnapshot.docs
                    .map((item) => {
                        const data = item.data();

                        return {
                            uid: item.id,
                            name: String(
                                data.name ||
                                data.displayName ||
                                data.email ||
                                "User"
                            ).trim(),
                            email: String(data.email || "")
                                .trim()
                                .toLowerCase(),
                            role: String(data.role || "Viewer"),
                            active: data.active !== false,
                        };
                    })
                    .filter(
                        (item) =>
                            item.active && EMAIL_RE.test(item.email)
                    )
                    .sort((a, b) =>
                        a.name.localeCompare(b.name)
                    );

                const savedOperators =
                    settings.moduleOperators &&
                    typeof settings.moduleOperators === "object"
                        ? settings.moduleOperators
                        : {};

                const normalizedOperators = {};

                for (const moduleName of MODULES) {
                    normalizedOperators[moduleName] =
                        Array.isArray(savedOperators[moduleName])
                            ? [
                                ...new Set(
                                    savedOperators[moduleName].map(String)
                                ),
                            ]
                            : [];
                }

                if (!cancelled) {
                    setUsers(activeUsers);
                    setModuleOperators(normalizedOperators);

                    setDaysText(
                        cleanReminderDays(
                            settings.reminderDays
                        ).join(", ")
                    );

                    setEmailTime(
                        cleanEmailTime(settings.emailTime)
                    );

                    setLoading(false);
                }
            } catch (err) {
                console.error(
                    "Reminder settings load error:",
                    err
                );

                if (!cancelled) {
                    setError(
                        "Settings or users could not be loaded. Check Firestore permissions."
                    );
                    setLoading(false);
                }
            }
        });

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [router]);

    const selectedCount = useMemo(
        () =>
            MODULES.reduce(
                (total, moduleName) =>
                    total +
                    (moduleOperators[moduleName]?.length || 0),
                0
            ),
        [moduleOperators]
    );

    function toggleOperator(moduleName, uid, checked) {
        setModuleOperators((current) => {
            const selected = new Set(
                current[moduleName] || []
            );

            if (checked) {
                selected.add(uid);
            } else {
                selected.delete(uid);
            }

            return {
                ...current,
                [moduleName]: [...selected],
            };
        });
    }

    async function handleSave(event) {
        event.preventDefault();

        setError("");
        setMessage("");

        const rawDays = daysText
            .split(/[,\s]+/)
            .filter(Boolean);

        const parsedDays = rawDays.map(Number);

        if (
            !parsedDays.length ||
            parsedDays.some(
                (day) =>
                    !Number.isInteger(day) ||
                    day < 0 ||
                    day > 365
            )
        ) {
            setError(
                "Enter whole numbers from 0 to 365, separated by commas. Example: 15, 7, 3, 1, 0."
            );
            return;
        }

        if (!EMAIL_TIME_OPTIONS.includes(emailTime)) {
            setError("Please select a valid email sending time.");
            return;
        }

        const reminderDays = cleanReminderDays(parsedDays);

        const validUids = new Set(
            users.map((user) => user.uid)
        );

        const safeOperators = {};

        for (const moduleName of MODULES) {
            safeOperators[moduleName] = [
                ...new Set(moduleOperators[moduleName] || []),
            ].filter((uid) => validUids.has(uid));
        }

        try {
            setSaving(true);

            await setDoc(
                SETTINGS_REF,
                {
                    reminderDays,
                    emailTime,
                    timeZone: "Asia/Kolkata",
                    moduleOperators: safeOperators,
                    updatedAt: serverTimestamp(),
                    updatedBy: auth.currentUser?.uid || "",
                },
                { merge: true }
            );

            setDaysText(reminderDays.join(", "));
            setEmailTime(emailTime);
            setModuleOperators(safeOperators);

            setMessage(
                "Reminder days, email time and module operators saved successfully."
            );
        } catch (err) {
            console.error(
                "Reminder settings save error:",
                err
            );

            setError(
                "Could not save settings. Check Firestore permissions."
            );
        } finally {
            setSaving(false);
        }
    }

    if (loading) {
        return (
            <main className="min-h-screen bg-slate-100 p-8 text-center text-slate-600">
                Loading reminder settings…
            </main>
        );
    }

    return (
        <main className="min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8">
            <div className="mx-auto max-w-5xl">
                <button
                    type="button"
                    onClick={() =>
                        router.push("/dashboard/users")
                    }
                    className="text-sm font-semibold text-blue-700"
                >
                    ← Back to User Management
                </button>

                <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                    <h1 className="text-2xl font-bold text-slate-900">
                        Expiry Reminder Settings
                    </h1>

                    <p className="mt-2 text-sm text-slate-600">
                        Configure reminder dates, email delivery time
                        and operators for each submodule.
                        No assignment is added to individual records.
                    </p>

                    {!allowed ? (
                        <p className="mt-5 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                            {error}
                        </p>
                    ) : (
                        <form
                            onSubmit={handleSave}
                            className="mt-6 space-y-7"
                        >
                            {/* Reminder Schedule */}
                            <div>
                                <h2 className="text-base font-bold text-slate-900">
                                    Reminder Schedule
                                </h2>

                                <label className="mt-3 block text-sm font-semibold text-slate-700">
                                    Days before expiry

                                    <input
                                        value={daysText}
                                        onChange={(event) =>
                                            setDaysText(
                                                event.target.value
                                            )
                                        }
                                        placeholder="15, 7, 3, 1, 0"
                                        className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-3 text-base font-normal outline-none focus:border-blue-500"
                                    />
                                </label>

                                <p className="mt-2 text-xs text-slate-500">
                                    Example: 15, 7, 3, 1, 0.
                                    Calendar days in Asia/Kolkata.
                                    Day 0 (expiry date) is always included.
                                    Maximum 365 days.
                                </p>
                            </div>

                            {/* Email Delivery Time */}
                            <div className="rounded-xl border border-slate-200 p-4">
                                <h2 className="text-base font-bold text-slate-900">
                                    Email Delivery Time
                                </h2>

                                <p className="mt-1 text-sm text-slate-600">
                                    Choose when the daily expiry reminder
                                    emails should be processed.
                                </p>

                                <label className="mt-4 block text-sm font-semibold text-slate-700">
                                    Send reminder emails at

                                    <select
                                        value={emailTime}
                                        onChange={(event) =>
                                            setEmailTime(event.target.value)
                                        }
                                        className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-base font-normal outline-none focus:border-blue-500"
                                    >
                                        {EMAIL_TIME_OPTIONS.map((time) => (
                                            <option
                                                key={time}
                                                value={time}
                                            >
                                                {formatTimeLabel(time)}
                                            </option>
                                        ))}
                                    </select>
                                </label>

                                <p className="mt-2 text-xs text-slate-500">
                                    Available from 06:00 AM to 10:00 PM
                                    in 15-minute intervals.
                                </p>

                                <div className="mt-3 rounded-lg bg-blue-50 p-3 text-sm text-blue-900">
                                    <strong>Time Zone:</strong> India
                                    Standard Time (Asia/Kolkata, UTC+05:30).

                                    <br />

                                    <strong>Selected Time:</strong>{" "}
                                    {formatTimeLabel(emailTime)} IST
                                </div>
                            </div>

                            {/* Module Operators */}
                            <div>
                                <div className="flex flex-wrap items-end justify-between gap-2">
                                    <div>
                                        <h2 className="text-base font-bold text-slate-900">
                                            Submodule Operators
                                        </h2>

                                        <p className="mt-1 text-sm text-slate-600">
                                            Select one or more active users
                                            who handle each submodule.
                                        </p>
                                    </div>

                                    <span className="text-xs text-slate-500">
                                        {selectedCount} module assignment(s)
                                    </span>
                                </div>

                                {users.length === 0 ? (
                                    <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
                                        No active users with valid email
                                        addresses were found in User Management.
                                    </p>
                                ) : (
                                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                                        {MODULES.map((moduleName) => (
                                            <section
                                                key={moduleName}
                                                className="rounded-xl border border-slate-200 p-4"
                                            >
                                                <div className="flex items-center justify-between gap-2">
                                                    <h3 className="font-bold text-slate-900">
                                                        {moduleName}
                                                    </h3>

                                                    <span className="text-xs text-slate-500">
                                                        {moduleOperators[moduleName]?.length || 0} selected
                                                    </span>
                                                </div>

                                                <div className="mt-3 max-h-52 space-y-2 overflow-y-auto">
                                                    {users.map((user) => (
                                                        <label
                                                            key={user.uid}
                                                            className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-slate-50"
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                checked={(
                                                                    moduleOperators[moduleName] || []
                                                                ).includes(user.uid)}
                                                                onChange={(event) =>
                                                                    toggleOperator(
                                                                        moduleName,
                                                                        user.uid,
                                                                        event.target.checked
                                                                    )
                                                                }
                                                                className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                                                            />

                                                            <span className="min-w-0">
                                                                <span className="block text-sm font-medium text-slate-800">
                                                                    {user.name}
                                                                </span>

                                                                <span className="block break-all text-xs text-slate-500">
                                                                    {user.email} · {user.role}
                                                                </span>
                                                            </span>
                                                        </label>
                                                    ))}
                                                </div>

                                                {!moduleOperators[moduleName]?.length && (
                                                    <p className="mt-2 text-xs text-amber-700">
                                                        No operator selected.
                                                        Reminders for this module
                                                        will be skipped and logged.
                                                    </p>
                                                )}
                                            </section>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Routing Information */}
                            <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-900">
                                Upcoming and expiry-day reminders go to
                                selected operators of that module.

                                <br />

                                Overdue reminders go to those same active
                                module operators plus active Super Admin accounts.

                                <br />

                                All reminder dates and delivery times use
                                Asia/Kolkata.
                            </div>

                            {error && (
                                <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
                                    {error}
                                </p>
                            )}

                            {message && (
                                <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">
                                    {message}
                                </p>
                            )}

                            <button
                                type="submit"
                                disabled={saving}
                                className="rounded-xl bg-blue-700 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                            >
                                {saving
                                    ? "Saving…"
                                    : "Save Reminder Settings"}
                            </button>
                        </form>
                    )}
                </section>
            </div>
        </main>
    );
}
