
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

const SETTINGS_REF = doc(db, "app_settings", "expiryReminders");
const DEFAULT_DAYS = [10, 3, 1, 0];
const DEFAULT_EMAIL_TIME = "09:30";

const MODULES = [
    "AMC",
    "Warranty",
    "Software License",
    "Insurance",
    "Pollution",
    "Compliance",
    "Machinery",
    "Service",
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMAIL_TIME_OPTIONS = Array.from({ length: 65 }, (_, index) => {
    const totalMinutes = 360 + index * 15;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
});

function formatTimeLabel(value) {
    const [hours, minutes] = value.split(":").map(Number);
    const suffix = hours >= 12 ? "PM" : "AM";
    const displayHour = hours % 12 || 12;

    return `${String(displayHour).padStart(2, "0")}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function normalizeRole(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[_-]/g, " ")
        .replace(/\s+/g, " ");
}

function isSuperAdminUser(profile) {
    const role = normalizeRole(profile?.role);

    return (
        profile?.active === true &&
        ["super admin", "superadmin"].includes(role)
    );
}

function cleanReminderDays(value) {
    if (!Array.isArray(value)) return DEFAULT_DAYS;

    const numbers = value
        .map(Number)
        .filter((day) => Number.isInteger(day) && day >= 0 && day <= 365);

    return [...new Set([...numbers, 0])].sort((a, b) => b - a);
}

function cleanEmailTime(value) {
    return EMAIL_TIME_OPTIONS.includes(value)
        ? value
        : DEFAULT_EMAIL_TIME;
}

function createEmptySchedules() {
    return Object.fromEntries(
        MODULES.map((moduleName) => [moduleName, []])
    );
}

function normalizeScheduleEntries(entries, validUids) {
    if (!Array.isArray(entries)) return [];

    const cleaned = entries
        .map((entry) => {
            const daysBefore = Number(entry?.daysBefore);

            if (
                !Number.isInteger(daysBefore) ||
                daysBefore < 0 ||
                daysBefore > 365
            ) {
                return null;
            }

            const recipients = Array.isArray(entry?.recipients)
                ? [...new Set(entry.recipients.map(String))]
                    .filter((uid) => validUids.has(uid))
                : [];

            return {
                daysBefore,
                recipients,
            };
        })
        .filter(Boolean);

    const uniqueDays = new Map();

    for (const entry of cleaned) {
        uniqueDays.set(entry.daysBefore, entry);
    }

    return [...uniqueDays.values()].sort(
        (a, b) => b.daysBefore - a.daysBefore
    );
}

function createLegacySchedules(settings, validUids) {
    const schedules = createEmptySchedules();

    const legacyDays = cleanReminderDays(settings.reminderDays);

    const legacyOperators =
        settings.moduleOperators &&
        typeof settings.moduleOperators === "object"
            ? settings.moduleOperators
            : {};

    for (const moduleName of MODULES) {
        const oldRecipients = Array.isArray(legacyOperators[moduleName])
            ? [...new Set(legacyOperators[moduleName].map(String))]
                .filter((uid) => validUids.has(uid))
            : [];

        schedules[moduleName] = legacyDays.map((daysBefore) => ({
            daysBefore,
            recipients: [...oldRecipients],
        }));
    }

    return schedules;
}

export default function ReminderSettingsPage() {
    const router = useRouter();

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [allowed, setAllowed] = useState(false);

    const [emailTime, setEmailTime] = useState(DEFAULT_EMAIL_TIME);
    const [users, setUsers] = useState([]);

    const [moduleSchedules, setModuleSchedules] = useState(
        createEmptySchedules()
    );

    const [selectedModule, setSelectedModule] = useState("AMC");
    const [newReminderDay, setNewReminderDay] = useState("");

    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    useEffect(() => {
        let cancelled = false;

        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            setAllowed(false);
            setError("");
            setSuccess("");

            if (!user) {
                router.replace("/");
                return;
            }

            setLoading(true);

            try {
                const profileSnapshot = await getDoc(
                    doc(db, "users", user.uid)
                );

                if (cancelled) return;

                const profile = profileSnapshot.exists()
                    ? profileSnapshot.data()
                    : {};

                const permitted = isSuperAdminUser(profile);

                setAllowed(permitted);

                if (!permitted) {
                    setError(
                        "Only an active Super Admin can change expiry reminder settings."
                    );
                    setLoading(false);
                    return;
                }

                const [settingsSnapshot, usersSnapshot] = await Promise.all([
                    getDoc(SETTINGS_REF),
                    getDocs(collection(db, "users")),
                ]);

                if (cancelled) return;

                const settings = settingsSnapshot.exists()
                    ? settingsSnapshot.data()
                    : {};

                // All active users with valid email addresses can be selected.
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
                            active: data.active === true,
                        };
                    })
                    .filter(
                        (item) =>
                            item.active &&
                            EMAIL_RE.test(item.email)
                    )
                    .sort((a, b) => a.name.localeCompare(b.name));

                const validUids = new Set(
                    activeUsers.map((item) => item.uid)
                );

                let loadedSchedules;

                // Prefer the new module-wise schedule configuration.
                if (
                    settings.moduleSchedules &&
                    typeof settings.moduleSchedules === "object"
                ) {
                    loadedSchedules = createEmptySchedules();

                    for (const moduleName of MODULES) {
                        loadedSchedules[moduleName] =
                            normalizeScheduleEntries(
                                settings.moduleSchedules[moduleName],
                                validUids
                            );
                    }
                } else {
                    // Migrate old global reminderDays/moduleOperators
                    // into the new page's initial schedule.
                    loadedSchedules = createLegacySchedules(
                        settings,
                        validUids
                    );
                }

                setUsers(activeUsers);
                setModuleSchedules(loadedSchedules);
                setEmailTime(cleanEmailTime(settings.emailTime));
                setLoading(false);
            } catch (err) {
                console.error("Reminder settings load error:", err);

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

    const currentSchedule = moduleSchedules[selectedModule] || [];

    const totalAssignments = useMemo(() => {
        return MODULES.reduce((total, moduleName) => {
            const entries = moduleSchedules[moduleName] || [];

            return (
                total +
                entries.reduce(
                    (count, entry) =>
                        count + (entry.recipients?.length || 0),
                    0
                )
            );
        }, 0);
    }, [moduleSchedules]);

    function addReminderDay() {
        setError("");
        setSuccess("");

        const value = newReminderDay.trim();

        if (value === "") {
            setError("Enter reminder days before adding.");
            return;
        }

        const day = Number(value);

        if (
            !Number.isInteger(day) ||
            day < 0 ||
            day > 365
        ) {
            setError("Reminder days must be a whole number between 0 and 365.");
            return;
        }

        if (currentSchedule.some((item) => item.daysBefore === day)) {
            setError(`A ${day}-day reminder already exists for ${selectedModule}.`);
            return;
        }

        setModuleSchedules((current) => {
            const existing = current[selectedModule] || [];

            return {
                ...current,
                [selectedModule]: [
                    ...existing,
                    {
                        daysBefore: day,
                        recipients: [],
                    },
                ].sort((a, b) => b.daysBefore - a.daysBefore),
            };
        });

        setNewReminderDay("");
    }

    function removeReminderDay(moduleName, daysBefore) {
        setModuleSchedules((current) => ({
            ...current,
            [moduleName]: (current[moduleName] || []).filter(
                (item) => item.daysBefore !== daysBefore
            ),
        }));
    }

    function toggleRecipient(moduleName, daysBefore, uid, checked) {
        setModuleSchedules((current) => {
            const existing = current[moduleName] || [];

            return {
                ...current,
                [moduleName]: existing.map((entry) => {
                    if (entry.daysBefore !== daysBefore) {
                        return entry;
                    }

                    const selected = new Set(entry.recipients || []);

                    if (checked) {
                        selected.add(uid);
                    } else {
                        selected.delete(uid);
                    }

                    return {
                        ...entry,
                        recipients: [...selected],
                    };
                }),
            };
        });
    }

    async function handleSave(event) {
        event.preventDefault();

        setError("");
        setSuccess("");

        if (!EMAIL_TIME_OPTIONS.includes(emailTime)) {
            setError("Please select a valid email sending time.");
            return;
        }

        const validUids = new Set(users.map((user) => user.uid));
        const safeSchedules = createEmptySchedules();

        for (const moduleName of MODULES) {
            safeSchedules[moduleName] = normalizeScheduleEntries(
                moduleSchedules[moduleName],
                validUids
            );
        }

        try {
            setSaving(true);

            await setDoc(
                SETTINGS_REF,
                {
                    moduleSchedules: safeSchedules,
                    emailTime,
                    timeZone: "Asia/Kolkata",
                    updatedAt: serverTimestamp(),
                    updatedBy: auth.currentUser?.uid || "",
                },
                { merge: true }
            );

            setModuleSchedules(safeSchedules);
            setSuccess("Reminder settings saved successfully.");
        } catch (err) {
            console.error("Reminder settings save error:", err);

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
                <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                    <h1 className="text-2xl font-bold text-slate-900">
                        Expiry Reminder Settings
                    </h1>

                    {!allowed ? (
                        <p className="mt-5 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                            {error}
                        </p>
                    ) : (
                        <form
                            onSubmit={handleSave}
                            className="mt-6 space-y-7"
                        >
                            {/* Module selection */}
                            <div>
                                <h2 className="text-base font-bold text-slate-900">
                                    Select Module
                                </h2>

                                <select
                                    value={selectedModule}
                                    onChange={(event) => {
                                        setSelectedModule(event.target.value);
                                        setNewReminderDay("");
                                        setError("");
                                        setSuccess("");
                                    }}
                                    className="mt-3 w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-base outline-none focus:border-blue-600"
                                >
                                    {MODULES.map((moduleName) => (
                                        <option
                                            key={moduleName}
                                            value={moduleName}
                                        >
                                            {moduleName}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {/* Reminder schedule */}
                            <div className="rounded-xl border border-slate-200 p-4">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div>
                                        <h2 className="text-base font-bold text-slate-900">
                                            {selectedModule} Reminder Schedule
                                        </h2>

                                        <p className="mt-1 text-sm text-slate-600">
                                            Set reminder days and select
                                            recipients for each reminder.
                                        </p>
                                    </div>

                                    <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-800">
                                        {currentSchedule.length} reminder(s)
                                    </span>
                                </div>

                                {/* Add reminder day */}
                                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                                    <input
                                        type="number"
                                        min="0"
                                        max="365"
                                        step="1"
                                        value={newReminderDay}
                                        onChange={(event) =>
                                            setNewReminderDay(event.target.value)
                                        }
                                        placeholder="Days before expiry (e.g. 15)"
                                        className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-3 outline-none focus:border-blue-600"
                                    />

                                    <button
                                        type="button"
                                        onClick={addReminderDay}
                                        className="rounded-xl bg-[#0b4da2] px-5 py-3 text-sm font-semibold text-white hover:bg-blue-800"
                                    >
                                        + Add Reminder
                                    </button>
                                </div>

                                <p className="mt-2 text-xs text-slate-500">
                                    0 = expiry date itself. You can add
                                    reminders from 0 to 365 days before expiry.
                                </p>

                                {/* Schedule entries */}
                                {currentSchedule.length === 0 ? (
                                    <div className="mt-5 rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
                                        No reminder days configured for this
                                        module. Add a reminder day above.
                                    </div>
                                ) : (
                                    <div className="mt-5 space-y-4">
                                        {currentSchedule.map((entry) => (
                                            <div
                                                key={entry.daysBefore}
                                                className="rounded-xl border border-slate-200 p-4"
                                            >
                                                <div className="flex flex-wrap items-center justify-between gap-3">
                                                    <div>
                                                        <h3 className="font-bold text-slate-900">
                                                            {entry.daysBefore === 0
                                                                ? "Expiry Day (0)"
                                                                : `${entry.daysBefore} Days Before`}
                                                        </h3>

                                                        <p className="mt-1 text-xs text-slate-500">
                                                            {entry.recipients?.length || 0} user(s) selected
                                                        </p>
                                                    </div>

                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            removeReminderDay(
                                                                selectedModule,
                                                                entry.daysBefore
                                                            )
                                                        }
                                                        className="rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50"
                                                    >
                                                        Remove Day
                                                    </button>
                                                </div>

                                                {users.length === 0 ? (
                                                    <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
                                                        No active users with
                                                        valid email addresses
                                                        available.
                                                    </p>
                                                ) : (
                                                    <div className="mt-4">
                                                        <p className="mb-2 text-sm font-semibold text-slate-700">
                                                            Select Recipients
                                                        </p>

                                                        <div className="grid gap-2 sm:grid-cols-2">
                                                            {users.map((user) => (
                                                                <label
                                                                    key={user.uid}
                                                                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-100 px-3 py-3 hover:bg-slate-50"
                                                                >
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={
                                                                            (
                                                                                entry.recipients ||
                                                                                []
                                                                            ).includes(
                                                                                user.uid
                                                                            )
                                                                        }
                                                                        onChange={(event) =>
                                                                            toggleRecipient(
                                                                                selectedModule,
                                                                                entry.daysBefore,
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
                                                                            {user.email}
                                                                        </span>

                                                                        <span className="mt-1 inline-block rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                                                                            {user.role}
                                                                        </span>
                                                                    </span>
                                                                </label>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}

                                                {(!entry.recipients ||
                                                    entry.recipients.length === 0) && (
                                                    <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
                                                        No recipients selected
                                                        for this reminder day.
                                                    </p>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Email time */}
                            <div className="rounded-xl border border-slate-200 p-4">
                                <h2 className="text-base font-bold text-slate-900">
                                    Email Delivery Time
                                </h2>

                                <label className="mt-4 block text-sm font-semibold text-slate-700">
                                    Send reminder emails at
                                    <select
                                        value={emailTime}
                                        onChange={(event) =>
                                            setEmailTime(event.target.value)
                                        }
                                        className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-base font-normal outline-none focus:border-blue-600"
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

                                <div className="mt-3 rounded-lg bg-blue-50 p-3 text-sm text-blue-900">
                                    <strong>Time Zone:</strong> India Standard
                                    Time (Asia/Kolkata)
                                    <br />
                                    <strong>Selected Time:</strong>{" "}
                                    {formatTimeLabel(emailTime)} IST
                                </div>
                            </div>

                            {/* Summary */}
                            <div className="rounded-xl border border-slate-200 p-4">
                                <h2 className="text-base font-bold text-slate-900">
                                    Configuration Summary
                                </h2>

                                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                                    <div className="rounded-lg bg-slate-50 p-3">
                                        <p className="text-xs text-slate-500">
                                            Modules
                                        </p>
                                        <p className="mt-1 text-xl font-bold text-slate-900">
                                            {MODULES.length}
                                        </p>
                                    </div>

                                    <div className="rounded-lg bg-slate-50 p-3">
                                        <p className="text-xs text-slate-500">
                                            Active Users Available
                                        </p>
                                        <p className="mt-1 text-xl font-bold text-slate-900">
                                            {users.length}
                                        </p>
                                    </div>

                                    <div className="col-span-2 rounded-lg bg-slate-50 p-3 sm:col-span-1">
                                        <p className="text-xs text-slate-500">
                                            User Assignments
                                        </p>
                                        <p className="mt-1 text-xl font-bold text-slate-900">
                                            {totalAssignments}
                                        </p>
                                    </div>
                                </div>
                            </div>

                            {/* Current stage warning */}
                            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                                <p className="font-bold">
                                    Configuration Only
                                </p>

                                <p className="mt-1">
                                    These settings will be saved in Firestore.
                                    The email reminder function is not being
                                    changed in this stage, so the new
                                    module-wise recipient configuration will
                                    not affect email delivery until routing
                                    implementation is done separately.
                                </p>
                            </div>

                            {error && (
                                <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
                                    {error}
                                </p>
                            )}

                            {success && (
                                <p className="rounded-lg bg-green-50 p-3 text-sm text-green-700">
                                    {success}
                                </p>
                            )}

                            {/* Actions */}
                            <div className="flex flex-wrap gap-3">
                                <button
                                    type="button"
                                    onClick={() =>
                                        router.push("/dashboard/users")
                                    }
                                    disabled={saving}
                                    className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                                >
                                    Cancel
                                </button>

                                <button
                                    type="submit"
                                    disabled={saving}
                                    className="rounded-xl bg-[#0b4da2] px-5 py-3 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                                >
                                    {saving
                                        ? "Saving…"
                                        : "Save Reminder Settings"}
                                </button>
                            </div>
                        </form>
                    )}
                </section>
            </div>
        </main>
    );
}
