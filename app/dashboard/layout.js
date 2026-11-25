
"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
    collection,
    doc,
    onSnapshot,
} from "firebase/firestore";
import { auth, db } from "../../lib/firebase";

const DashboardShellContext = createContext(null);

export function useDashboardShell() {
    const context = useContext(DashboardShellContext);

    if (!context) {
        throw new Error(
            "useDashboardShell must be used inside DashboardLayout."
        );
    }

    return context;
}

// SIDEBAR NAVIGATION
const navGroups = [
    {
        label: "",
        items: [
            { name: "Dashboard", path: "/dashboard", icon: "▦" },
            { name: "Profile", path: "/dashboard/profile", icon: "♙" },
        ],
    },
    {
        label: "ASSET TRACKING",
        items: [
            {
                name: "IT Devices",
                icon: "▣",
                children: [
                    { name: "AMC", path: "/dashboard/amc" },
                    { name: "Warranty", path: "/dashboard/warranty" },
                    {
                        name: "Software License",
                        path: "/dashboard/software-license",
                    },
                ],
            },
            {
                name: "Vehicles",
                icon: "🚘",
                children: [
                    { name: "Insurance", path: "/dashboard/insurance" },
                    { name: "Pollution", path: "/dashboard/pollution" },
                    { name: "Service", path: "/dashboard/service" },
                ],
            },
            {
                name: "Machinery",
                path: "/dashboard/machinery",
                icon: "⚙",
            },
            {
                name: "Compliance",
                path: "/dashboard/compliance",
                icon: "✓",
            },
        ],
    },
    {
        label: "MANAGEMENT",
        items: [
            { name: "Reports", path: "/dashboard/reports", icon: "▥" },
            { name: "Users", path: "/dashboard/users", icon: "♟" },
        ],
    },
];

function normalizeRole(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[_-]/g, " ")
        .replace(/\s+/g, " ");
}

function cleanReminderDays(value) {
    if (!Array.isArray(value)) return [];

    return [...new Set(
        value
            .map(Number)
            .filter(
                (day) =>
                    Number.isInteger(day) &&
                    day >= 0 &&
                    day <= 365
            )
    )].sort((a, b) => b - a);
}
function toDate(value) {
    if (!value) return null;

    if (typeof value?.toDate === "function") {
        return value.toDate();
    }

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value === "string") {
        const match = value.match(/^(\d{4}-\d{2}-\d{2})/);

        if (match) {
            const [year, month, day] = match[1]
                .split("-")
                .map(Number);

            return new Date(year, month - 1, day);
        }

        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    if (typeof value === "number") {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    if (
        typeof value === "object" &&
        Number.isFinite(value.seconds)
    ) {
        return new Date(value.seconds * 1000);
    }

    return null;
}

// MODULE IDENTIFICATION
function getModule(record, source) {
    const type = normalizeRole(record.type);
    const category = normalizeRole(record.category);
    const values = `${type} ${category}`;

    if (source === "vehicles") {
        if (values.includes("pollution")) return "Pollution";
        if (values.includes("service")) return "Service";
        return "Insurance";
    }

    if (source === "machinery_records") {
        return "Machinery";
    }

    if (source === "compliance_records") {
        return "Compliance";
    }

    if (values.includes("warranty")) return "Warranty";
    if (values.includes("software")) return "Software License";
    if (values.includes("amc")) return "AMC";

    return "IT Devices";
}

// NOTIFICATION DATE IDENTIFICATION
// A record can have multiple reminder dates.
function getNotificationDates(record, source) {
    const module = getModule(record, source);

    if (module === "Insurance") {
        return [
            {
                date: toDate(record.expiryDate),
                event: "Insurance Expiry",
            },
        ];
    }

    if (module === "Pollution") {
        return [
            {
                date: toDate(
                    record.expiryDate ||
                    record.pollutionExpiryDate
                ),
                event: "Pollution Certificate Expiry",
            },
        ];
    }

    if (module === "Service") {
        return [
            {
                date: toDate(record.nextServiceDueDate),
                event: "Service Due",
            },
        ];
    }

    if (module === "Machinery") {
        const entries = [];

        const serviceDueDate =
            record.nextDueDate || record.nextServiceDueDate;

        if (serviceDueDate) {
            entries.push({
                date: toDate(serviceDueDate),
                event: "Machinery Service Due",
            });
        }

        if (
            String(record.amcApplicable || "").trim().toLowerCase() === "yes" &&
            record.amcEndDate
        ) {
            entries.push({
                date: toDate(record.amcEndDate),
                event: "Machinery AMC Expiry",
            });
        }

        return entries;
    }
    if (module === "Compliance") {
        const fields = [
            "validTill",
            "validUntil",
            "validTillDate",
            "expiryDate",
            "endDate",
        ];

        const dateField = fields.find(
            (field) => toDate(record[field])
        );

        return [
            {
                date: dateField ? toDate(record[dateField]) : null,
                event: "Compliance Expiry",
            },
        ];
    }

    if (module === "AMC") {
        return [
            {
                date: toDate(record.endDate || record.expiryDate),
                event: "AMC Expiry",
            },
        ];
    }

    if (module === "Warranty") {
        const fields = [
            "endDate",
            "expiryDate",
            "warrantyExpiry",
            "warrantyExpired",
        ];

        const dateField = fields.find(
            (field) => toDate(record[field])
        );

        return [
            {
                date: dateField ? toDate(record[dateField]) : null,
                event: "Warranty Expiry",
            },
        ];
    }

    if (module === "Software License") {
        return [
            {
                date: toDate(record.expiryDate || record.endDate),
                event: "Software License Expiry",
            },
        ];
    }
    return [
        {
            date: toDate(record.endDate || record.expiryDate),
            event: "Record Expiry",
        },
    ];
}

function getDaysRemaining(date) {
    if (!date) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const expiry = new Date(date);
    expiry.setHours(0, 0, 0, 0);

    return Math.round(
        (expiry.getTime() - today.getTime()) / 86400000
    );
}

function getProductName(record, source) {
    const module = getModule(record, source);

    if (module === "Machinery") {
        return (
            record.machineName ||
            record.machineNo ||
            record.machineNumber ||
            "Unnamed Machinery"
        );
    }

    if (module === "Service") {
        return (
            record.vehicleName ||
            record.vehicleNo ||
            record.vehicleNumber ||
            "Unnamed Vehicle"
        );
    }

    if (module === "Software License") {
        return (
            record.licenseName ||
            record.softwareName ||
            record.productName ||
            record.name ||
            "Unnamed Software License"
        );
    }

    if (module === "Compliance") {
        return (
            record.examinationType ||
            record.typeOfExamination ||
            record.name ||
            "Unnamed Compliance Record"
        );
    }

    if (module === "Pollution") {
        return (
            record.vehicleNo ||
            record.vehicleNumber ||
            record.productName ||
            "Unnamed Vehicle"
        );
    }

    if (module === "Insurance") {
        return (
            record.productName ||
            record.vehicleNo ||
            record.vehicleNumber ||
            record.productId ||
            record.policyNo ||
            "Unnamed Insurance Record"
        );
    }

    return (
        record.productName ||
        record.product ||
        record.item ||
        record.vehicleNo ||
        record.vehicleNumber ||
        record.policyNo ||
        record.certificateNo ||
        record.name ||
        "Unnamed Record"
    );
}
function getNotificationTitle(daysRemaining, event) {
    if (daysRemaining < 0) {
        return `${event} - Overdue`;
    }

    if (daysRemaining === 0) {
        return `${event} - Due Today`;
    }

    if (daysRemaining === 1) {
        return `${event} - Due Tomorrow`;
    }

    return `Upcoming ${event}`;
}

export default function DashboardLayout({ children }) {
    const router = useRouter();
    const pathname = usePathname();

    const [user, setUser] = useState(null);
    const [userRole, setUserRole] = useState("");
    const [checkingAuth, setCheckingAuth] = useState(true);
    const [signingOut, setSigningOut] = useState(false);
    const [notice, setNotice] = useState("");
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const [showNotifications, setShowNotifications] = useState(false);
    const [search, setSearch] = useState("");
    const [records, setRecords] = useState([]);
    const [loadingData, setLoadingData] = useState(true);
    const [dataError, setDataError] = useState("");
    const [readNotificationIds, setReadNotificationIds] = useState([]);

    const [reminderDays, setReminderDays] = useState([]);

    const [todayKey, setTodayKey] = useState(() =>
        new Date().toDateString()
    );

    const [openMenus, setOpenMenus] = useState({
        "IT Devices": true,
        Vehicles: true,
    });

    // AUTHENTICATION AND ACTIVE USER VERIFICATION
    useEffect(() => {
        let cancelled = false;
        let authCheckId = 0;
        let unsubscribeProfile;

        const unsubscribeAuth = onAuthStateChanged(
            auth,
            (currentUser) => {
                const checkId = ++authCheckId;

                if (unsubscribeProfile) {
                    unsubscribeProfile();
                    unsubscribeProfile = undefined;
                }

                if (cancelled) return;

                setUser(currentUser);
                setCheckingAuth(true);

                if (!currentUser) {
                    setUserRole("");
                    setUser(null);
                    setCheckingAuth(false);
                    router.replace("/");
                    return;
                }

                unsubscribeProfile = onSnapshot(
                    doc(db, "users", currentUser.uid),

                    async (snapshot) => {
                        if (
                            cancelled ||
                            checkId !== authCheckId
                        ) {
                            return;
                        }

                        const profile = snapshot.exists()
                            ? snapshot.data()
                            : null;

                        const profileRole = normalizeRole(
                            profile?.role
                        );

                        const allowedRoles = [
                            "super admin",
                            "superadmin",
                            "admin",
                            "editor",
                            "viewer",
                        ];

                        const validProfile =
                            profile !== null &&
                            profile.active === true &&
                            allowedRoles.includes(profileRole);

                        if (!validProfile) {
                            setUserRole("");
                            setUser(null);
                            setCheckingAuth(false);

                            if (unsubscribeProfile) {
                                unsubscribeProfile();
                                unsubscribeProfile = undefined;
                            }

                            try {
                                await signOut(auth);
                            } catch (signOutError) {
                                console.error(
                                    "Unable to sign out invalid user:",
                                    signOutError
                                );
                            }

                            if (
                                !cancelled &&
                                checkId === authCheckId
                            ) {
                                router.replace("/");
                            }

                            return;
                        }

                        setUserRole(
                            String(profile.role).trim()
                        );

                        setCheckingAuth(false);
                    },

                    (error) => {
                        console.error(
                            "Unable to verify user access:",
                            error
                        );

                        if (
                            cancelled ||
                            checkId !== authCheckId
                        ) {
                            return;
                        }

                        setCheckingAuth(false);
                    }
                );
            }
        );

        return () => {
            cancelled = true;
            authCheckId++;

            unsubscribeAuth();

            if (unsubscribeProfile) {
                unsubscribeProfile();
            }
        };
    }, [router]);

    // LOAD READ NOTIFICATION IDS
    useEffect(() => {
        if (!user?.uid) {
            setReadNotificationIds([]);
            return;
        }

        setReadNotificationIds([]);

        try {
            const saved = localStorage.getItem(
                `ail_read_notifications_${user.uid}`
            );

            if (saved) {
                const parsed = JSON.parse(saved);

                if (Array.isArray(parsed)) {
                    setReadNotificationIds(parsed);
                }
            }
        } catch (error) {
            console.error(
                "Unable to load notification read status:",
                error
            );
        }
    }, [user?.uid]);


    // DYNAMIC REMINDER SETTINGS - COMMON FOR ALL ROLES
    useEffect(() => {
        if (checkingAuth || !user) return;

        const unsubscribe = onSnapshot(
            doc(db, "app_settings", "expiryReminders"),

            (snapshot) => {
                const settings = snapshot.exists()
                    ? snapshot.data()
                    : {};

                setReminderDays(
                    cleanReminderDays(settings.reminderDays)
                );
            },

            (error) => {
                console.error(
                    "Unable to load dynamic reminder settings:",
                    error
                );

                setReminderDays([]);
            }
        );

        return () => unsubscribe();
    }, [user, checkingAuth]);

    // LOAD ALL MODULE RECORDS
    // Machinery has its own collection.
    // Service uses the existing vehicles collection.
    useEffect(() => {
        if (checkingAuth || !user) {
            setRecords([]);
            setLoadingData(true);
            return;
        }

        setLoadingData(true);
        setDataError("");

        const sources = [
            "it_devices",
            "vehicles",
            "compliance_records",
            "machinery_records",
        ];

        const snapshots = {};
        const receivedSources = new Set();

        const unsubscribers = sources.map((source) =>
            onSnapshot(
                collection(db, source),

                (snapshot) => {
                    snapshots[source] = snapshot.docs.map(
                        (item) => ({
                            ...item.data(),
                            id: item.id,
                            _source: source,
                        })
                    );

                    receivedSources.add(source);

                    const combined = sources.flatMap(
                        (name) => snapshots[name] || []
                    );

                    setRecords(combined);

                    if (
                        receivedSources.size === sources.length
                    ) {
                        setLoadingData(false);
                    }
                },

                (error) => {
                    console.error(
                        `Unable to load ${source}:`,
                        error
                    );

                    setDataError(
                        "Some records could not be loaded. Please check your access or connection."
                    );

                    receivedSources.add(source);

                    if (
                        receivedSources.size === sources.length
                    ) {
                        setLoadingData(false);
                    }
                }
            )
        );

        return () => {
            unsubscribers.forEach(
                (unsubscribe) => unsubscribe()
            );
        };
    }, [user, checkingAuth]);

    // CLOSE MOBILE MENU ON NAVIGATION
    useEffect(() => {
        setMobileMenuOpen(false);
        setShowNotifications(false);
        setNotice("");
    }, [pathname]);

    // REFRESH DATE CALCULATIONS AT MIDNIGHT
    useEffect(() => {
        const now = new Date();
        const nextMidnight = new Date(now);

        nextMidnight.setHours(24, 0, 1, 0);

        const timeout = window.setTimeout(() => {
            setTodayKey(new Date().toDateString());
        }, nextMidnight.getTime() - now.getTime());

        return () => window.clearTimeout(timeout);
    }, [todayKey]);

    // NOTIFICATIONS
    // Upcoming reminders follow configured days.
    // Overdue records always remain visible.
    const notifications = useMemo(() => {
        return records
            .flatMap((record) => {
                const source = record._source;
                const module = getModule(record, source);

                const dateEntries = getNotificationDates(
                    record,
                    source
                );

                return dateEntries.map((entry, index) => {
                    const date = entry.date;

                    const daysRemaining = getDaysRemaining(date);

                    if (daysRemaining === null) return null;

                    const shouldNotify =
                        daysRemaining <= 0 ||
                        reminderDays.includes(daysRemaining);

                    if (!shouldNotify) return null;

                    const event = entry.event;

                    return {
                        id: `${source}-${record.id}-${index}-${event}-${daysRemaining}`,
                        title: getNotificationTitle(
                            daysRemaining,
                            event
                        ),
                        productName: getProductName(
                            record,
                            source
                        ),
                        module,
                        event,
                        daysRemaining,
                        expiryDate: date,
                    };
                });
            })
            .filter(Boolean)
            .sort(
                (a, b) =>
                    a.daysRemaining - b.daysRemaining
            );
    }, [records, reminderDays, todayKey]);

    const unreadNotifications = notifications.filter(
        (item) => !readNotificationIds.includes(item.id)
    );

    const unreadNotificationCount = unreadNotifications.length;

    // SAVE READ NOTIFICATION IDS
    const saveReadIds = useCallback(
        (ids) => {
            if (!user?.uid) return;

            setReadNotificationIds(ids);

            try {
                localStorage.setItem(
                    `ail_read_notifications_${user.uid}`,
                    JSON.stringify(ids)
                );
            } catch (error) {
                console.error(
                    "Unable to save notification status:",
                    error
                );
            }
        },
        [user?.uid]
    );

    const markNotificationRead = useCallback(
        (id) => {
            if (!readNotificationIds.includes(id)) {
                saveReadIds([
                    ...readNotificationIds,
                    id,
                ]);
            }
        },
        [readNotificationIds, saveReadIds]
    );

    const markAllNotificationsRead = useCallback(() => {
        saveReadIds([
            ...new Set([
                ...readNotificationIds,
                ...notifications.map((item) => item.id),
            ]),
        ]);
    }, [
        readNotificationIds,
        notifications,
        saveReadIds,
    ]);

    // LOGOUT
    async function handleLogout() {
        setSigningOut(true);

        try {
            await signOut(auth);
            router.replace("/");
        } catch (error) {
            console.error("Sign-out error:", error);
            setNotice(
                "Unable to sign out. Please try again."
            );
            setSigningOut(false);
        }
    }

    if (checkingAuth || !user) {
        return (
            <main className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-600">
                Checking your access...
            </main>
        );
    }

    const role = normalizeRole(userRole);

    const isSuperAdmin =
        ["super admin", "superadmin"].includes(role);

    const canManageUsers =
        isSuperAdmin || role === "admin";

    const shellValue = {
        search,
        setSearch,
        records,
        loadingData,
        dataError,
        reminderDays,
        notifications,
        unreadNotificationCount,
        markNotificationRead,
        markAllNotificationsRead,
    };

    return (
        <DashboardShellContext.Provider value={shellValue}>
            <main className="min-h-screen bg-slate-100 text-slate-900">

                {/* TITLE BAR */}
                <header className="sticky top-0 z-40 border-b border-white/10 bg-gradient-to-br from-blue-950 via-slate-900 to-slate-950 text-white shadow-xl">
                    <div className="flex min-h-[76px] items-center justify-between gap-3 px-4 py-3 sm:px-6">

                        <div className="flex min-w-0 items-center gap-3">
                            <button
                                type="button"
                                onClick={() =>
                                    setMobileMenuOpen(
                                        (value) => !value
                                    )
                                }
                                className="rounded-xl border border-white/15 bg-white/10 p-2.5 text-lg transition hover:bg-white/20 lg:hidden"
                                aria-label="Toggle navigation"
                                aria-expanded={mobileMenuOpen}
                            >
                                {mobileMenuOpen ? "✕" : "☰"}
                            </button>

                            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/15 bg-white/10 text-sm font-bold tracking-wide">
                                AIL
                            </div>

                            <div className="min-w-0">
                                <h1 className="truncate text-sm font-semibold tracking-wide sm:text-base">
                                    AMIN INTERNATIONAL LIMITED
                                </h1>

                                <p className="mt-1 truncate text-xs font-medium text-blue-200">
                                    Company Records &amp; Expiry Tracker
                                </p>
                            </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-2 sm:gap-3">

                            {/* SEARCH */}
                            <div className="hidden items-center gap-2 rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 md:flex">
                                <span className="text-lg text-blue-200">
                                    ⌕
                                </span>

                                <input
                                    aria-label="Search records"
                                    placeholder="Search records..."
                                    value={search}
                                    onChange={(event) =>
                                        setSearch(event.target.value)
                                    }
                                    className="w-32 bg-transparent text-sm text-white outline-none placeholder:text-slate-400 lg:w-44"
                                />

                                {search && (
                                    <button
                                        type="button"
                                        onClick={() => setSearch("")}
                                        aria-label="Clear search"
                                        className="text-slate-300 hover:text-white"
                                    >
                                        ×
                                    </button>
                                )}
                            </div>

                            {/* NOTIFICATIONS */}
                            <div className="relative">
                                <button
                                    type="button"
                                    onClick={() =>
                                        setShowNotifications(
                                            (value) => !value
                                        )
                                    }
                                    className="relative rounded-xl border border-white/15 bg-white/10 p-2.5 text-lg transition hover:bg-white/20"
                                    aria-label="Notifications"
                                    title="Notifications"
                                >
                                    🔔

                                    {unreadNotificationCount > 0 && (
                                        <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
                                            {unreadNotificationCount > 99
                                                ? "99+"
                                                : unreadNotificationCount}
                                        </span>
                                    )}
                                </button>

                                {showNotifications && (
                                    <div className="absolute right-0 top-12 z-50 w-[min(90vw,360px)] overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-900 shadow-2xl">

                                        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
                                            <div>
                                                <p className="text-sm font-semibold">
                                                    Expiry &amp; Due Notifications
                                                </p>

                                                <p className="text-xs text-slate-500">
                                                    {unreadNotificationCount} unread
                                                </p>
                                            </div>

                                            <button
                                                type="button"
                                                onClick={
                                                    markAllNotificationsRead
                                                }
                                                className="text-xs font-semibold text-blue-700 hover:text-blue-800 hover:underline"
                                            >
                                                Mark all read
                                            </button>
                                        </div>

                                        <div className="max-h-[360px] overflow-y-auto">
                                            {unreadNotifications.length === 0 ? (
                                                <p className="px-4 py-8 text-center text-sm text-slate-500">
                                                    No expiry or service alerts at the moment.
                                                </p>
                                            ) : (
                                                unreadNotifications.map((item) => (
                                                    <button
                                                        type="button"
                                                        key={item.id}
                                                        onClick={() => markNotificationRead(item.id)}
                                                        className="block w-full border-b border-slate-100 bg-blue-50/70 px-4 py-3 text-left transition hover:bg-slate-50"
                                                    >
                                                        <div className="flex items-start justify-between gap-3">
                                                            <p className="text-sm font-semibold text-slate-800">
                                                                {item.title}
                                                            </p>

                                                            <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-blue-700" />
                                                        </div>

                                                        <p className="mt-1 text-sm text-slate-700">
                                                            {item.productName}
                                                        </p>

                                                        <p className="mt-1 text-xs text-slate-500">
                                                            {item.module}
                                                            {" · "}
                                                            {item.daysRemaining < 0
                                                                ? `${Math.abs(item.daysRemaining)} day(s) overdue`
                                                                : item.daysRemaining === 0
                                                                    ? "Due today"
                                                                    : `${item.daysRemaining} day(s) remaining`}
                                                        </p>
                                                    </button>
                                                ))
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* USER DETAILS */}
                            <div className="hidden max-w-48 text-right sm:block">
                                <p className="truncate text-sm font-semibold text-white">
                                    {userRole || "User"}
                                </p>

                                <p className="truncate text-xs text-blue-200">
                                    {user.email}
                                </p>
                            </div>

                            {/* SIGN OUT */}
                            <button
                                type="button"
                                onClick={handleLogout}
                                disabled={signingOut}
                                className="rounded-xl bg-[#1d4ed8] px-3 py-2.5 text-xs font-semibold text-white shadow-lg shadow-blue-950/20 transition hover:bg-[#083b7d] disabled:cursor-not-allowed disabled:opacity-60 sm:px-4"
                            >
                                {signingOut
                                    ? "Signing out..."
                                    : "Sign out"}
                            </button>
                        </div>
                    </div>
                </header>

                {/* NOTICE */}
                {notice && (
                    <div className="fixed right-4 top-20 z-[60] flex max-w-md items-start justify-between gap-3 rounded-xl border border-blue-200 bg-white px-4 py-3 text-sm text-blue-900 shadow-lg">
                        <p>{notice}</p>

                        <button
                            type="button"
                            onClick={() => setNotice("")}
                            aria-label="Dismiss message"
                            className="font-bold"
                        >
                            ×
                        </button>
                    </div>
                )}

                <div className="flex min-h-[calc(100vh-76px)]">

                    {/* MOBILE SIDEBAR OVERLAY */}
                    {mobileMenuOpen && (
                        <button
                            type="button"
                            aria-label="Close navigation"
                            onClick={() =>
                                setMobileMenuOpen(false)
                            }
                            className="fixed inset-0 top-[76px] z-30 bg-slate-950/40 lg:hidden"
                        />
                    )}

                    {/* SIDEBAR */}
                    <aside
                        className={`fixed bottom-0 left-0 top-[76px] z-30 flex w-[250px] flex-col border-r border-slate-200 bg-white transition-transform duration-300 lg:sticky lg:top-[76px] lg:z-10 lg:h-[calc(100vh-76px)] lg:translate-x-0 ${mobileMenuOpen
                            ? "translate-x-0"
                            : "-translate-x-full"
                            }`}
                    >
                        <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-6">
                            {navGroups.map((group, index) => {
                                const items = group.items.filter(
                                    (item) =>
                                        item.name !== "Users" ||
                                        canManageUsers
                                );

                                return (
                                    <div key={group.label || index}>
                                        {group.label && (
                                            <p className="mb-2 px-3 text-[10px] font-bold tracking-[0.16em] text-slate-400">
                                                {group.label}
                                            </p>
                                        )}

                                        <div className="space-y-1">
                                            {items.map((item) => {
                                                const active = item.path
                                                    ? pathname === item.path ||
                                                    (
                                                        item.path !== "/dashboard" &&
                                                        pathname.startsWith(
                                                            item.path + "/"
                                                        )
                                                    )
                                                    : item.children?.some(
                                                        (child) =>
                                                            pathname === child.path ||
                                                            pathname.startsWith(
                                                                child.path + "/"
                                                            )
                                                    );

                                                return (
                                                    <div key={item.name}>
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                if (item.children) {
                                                                    setOpenMenus(
                                                                        (previous) => ({
                                                                            ...previous,
                                                                            [item.name]:
                                                                                !previous[item.name],
                                                                        })
                                                                    );
                                                                } else if (item.path) {
                                                                    router.push(
                                                                        item.path
                                                                    );
                                                                }
                                                            }}
                                                            className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium transition ${active
                                                                ? "bg-blue-50 text-blue-700"
                                                                : "text-slate-600 hover:bg-slate-50 hover:text-blue-700"
                                                                }`}
                                                        >
                                                            <span className="flex h-7 w-7 shrink-0 items-center justify-center text-lg">
                                                                {item.icon}
                                                            </span>

                                                            <span className="flex-1">
                                                                {item.name}
                                                            </span>

                                                            {item.children && (
                                                                <span
                                                                    className={`text-xs transition-transform ${openMenus[item.name]
                                                                        ? "rotate-180"
                                                                        : ""
                                                                        }`}
                                                                >
                                                                    ⌄
                                                                </span>
                                                            )}
                                                        </button>

                                                        {item.children &&
                                                            openMenus[item.name] && (
                                                                <div className="ml-9 mt-1 space-y-1 border-l border-slate-200 pl-3">
                                                                    {item.children.map(
                                                                        (child) => {
                                                                            const childActive =
                                                                                pathname === child.path ||
                                                                                pathname.startsWith(
                                                                                    child.path + "/"
                                                                                );

                                                                            return (
                                                                                <button
                                                                                    key={child.path}
                                                                                    type="button"
                                                                                    onClick={() =>
                                                                                        router.push(
                                                                                            child.path
                                                                                        )
                                                                                    }
                                                                                    className={`block w-full rounded-lg px-2 py-2 text-left text-xs leading-5 transition ${childActive
                                                                                        ? "bg-blue-50 font-semibold text-blue-700"
                                                                                        : "text-slate-500 hover:bg-slate-50 hover:text-blue-700"
                                                                                        }`}
                                                                                >
                                                                                    {child.name}
                                                                                </button>
                                                                            );
                                                                        }
                                                                    )}
                                                                </div>
                                                            )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            })}
                        </nav>

                        {/* SIDEBAR FOOTER */}
                        <div className="border-t border-slate-200 p-4">
                            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                                <p className="text-xs font-semibold text-slate-800">
                                    Company Records &amp; Expiry Tracker
                                </p>

                                <p className="mt-1 text-[11px] text-slate-500">
                                    Version 2.1.0
                                </p>
                            </div>
                        </div>
                    </aside>

                    {/* PAGE CONTENT */}
                    <section className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
                        <div className="w-full max-w-[1600px]">
                            {children}
                        </div>
                    </section>
                </div>
            </main>
        </DashboardShellContext.Provider>
    );
}
