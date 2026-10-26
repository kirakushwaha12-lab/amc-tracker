
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
    getDoc,
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

const navGroups = [
    {
        label: "",
        items: [
            { name: "Dashboard", path: "/dashboard", icon: "▦" },
            { name: "Profile", path: "/dashboard/profile", icon: "⚙" },
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
                ],
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
            { name: "Users", path: "/dashboard/users", icon: "♙" },
        ],
    },
];

function toDate(value) {
    if (!value) return null;

    if (typeof value?.toDate === "function") {
        return value.toDate();
    }

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value === "string" || typeof value === "number") {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    return null;
}

function getExpiryDate(record, source) {
    const fields =
        source === "vehicles"
            ? [
                "expiryDate",
                "renewalDate",
                "endDate",
                "date",
                "pollutionExpiryDate",
            ]
            : source === "compliance_records"
                ? [
                    "expiryDate",
                    "endDate",
                    "validTill",
                    "validUntil",
                    "validTillDate",
                    "renewalDate",
                    "date",
                ]
                : [
                    "endDate",
                    "expiryDate",
                    "warrantyExpiry",
                    "warrantyExpired",
                    "renewalDate",
                    "date",
                ];

    for (const field of fields) {
        const parsed = toDate(record[field]);
        if (parsed) return parsed;
    }

    return null;
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

function getProductName(record) {
    return (
        record.examinationType ||
        record.productName ||
        record.product ||
        record.item ||
        record.vehicleNo ||
        record.name ||
        record.policyNo ||
        "Unnamed Record"
    );
}

function getModule(record, source) {
    if (source === "vehicles") {
        return String(record.type || "").toLowerCase() === "pollution"
            ? "Pollution"
            : "Insurance";
    }

    if (source === "compliance_records") {
        return "Compliance";
    }

    const type = String(
        record.type || record.category || ""
    ).toLowerCase();

    if (type.includes("warranty")) return "Warranty";
    if (type.includes("software")) return "Software License";
    if (type.includes("amc")) return "AMC";

    return "IT Devices";
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
    const [openMenus, setOpenMenus] = useState({
        "IT Devices": true,
        Vehicles: true,
    });

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
            setUser(currentUser);

            if (!currentUser) {
                setUserRole("");
                setCheckingAuth(false);
                router.replace("/");
                return;
            }

            try {
                const snapshot = await getDoc(
                    doc(db, "users", currentUser.uid)
                );

                setUserRole(
                    snapshot.exists()
                        ? String(snapshot.data().role ?? "").trim()
                        : ""
                );
            } catch (error) {
                console.error("Unable to load user role:", error);
                setUserRole("");
            } finally {
                setCheckingAuth(false);
            }
        });

        return unsubscribe;
    }, [router]);

    useEffect(() => {
        try {
            const saved = localStorage.getItem("ail_read_notifications");

            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed)) {
                    setReadNotificationIds(parsed);
                }
            }
        } catch (error) {
            console.error("Unable to load notification read status:", error);
        }
    }, []);

    useEffect(() => {
        if (!user) {
            setRecords([]);
            setLoadingData(false);
            return;
        }

        setLoadingData(true);
        setDataError("");

        const sources = [
            "it_devices",
            "vehicles",
            "compliance_records",
        ];

        const snapshots = {};
        const receivedSources = new Set();

        const unsubscribers = sources.map((source) =>
            onSnapshot(
                collection(db, source),
                (snapshot) => {
                    snapshots[source] = snapshot.docs.map((item) => ({
                        ...item.data(),
                        id: item.id,
                        _source: source,
                    }));

                    const counts = {};

                    snapshots[source].forEach((record) => {
                        const category = record.category || "(no category)";
                        const type = record.type || "(no type)";
                        const key = `${category} | ${type}`;

                        counts[key] = (counts[key] || 0) + 1;
                    });

                    console.group(`Firestore audit: ${source}`);
                    console.log("Total documents:", snapshot.size);
                    console.table(
                        snapshot.docs.map((doc) => ({
                            id: doc.id,
                            ...doc.data(),
                        }))
                    );
                    console.groupEnd();
                    receivedSources.add(source);

                    const combined = sources.flatMap(
                        (name) => snapshots[name] || []
                    );

                    setRecords(combined);

                    if (receivedSources.size === sources.length) {
                        setLoadingData(false);
                    }
                },
                (error) => {
                    console.error(`Unable to load ${source}:`, error);
                    setDataError(
                        "Some records could not be loaded. Please check your access or connection."
                    );
                    receivedSources.add(source);

                    if (receivedSources.size === sources.length) {
                        setLoadingData(false);
                    }
                }
            )
        );

        return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    }, [user]);

    useEffect(() => {
        setMobileMenuOpen(false);
        setShowNotifications(false);
        setNotice("");
    }, [pathname]);

    const notifications = useMemo(() => {
        return records
            .map((record) => {
                const source = record._source;
                const expiryDate = getExpiryDate(record, source);
                const daysRemaining = getDaysRemaining(expiryDate);

                if (daysRemaining === null || daysRemaining > 10) {
                    return null;
                }

                let type;
                let title;

                if (daysRemaining < 0) {
                    type = "expired";
                    title = "Record Expired";
                } else if (daysRemaining === 0) {
                    type = "today";
                    title = "Expires Today";
                } else if (daysRemaining === 1) {
                    type = "1day";
                    title = "Expires Tomorrow";
                } else if (daysRemaining <= 3) {
                    type = "3day";
                    title = "Expiry Approaching";
                } else {
                    type = "10day";
                    title = "Upcoming Expiry";
                }

                return {
                    id: `${source}-${record.id}-${type}`,
                    title,
                    productName: getProductName(record),
                    module: getModule(record, source),
                    daysRemaining,
                    expiryDate,
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.daysRemaining - b.daysRemaining);
    }, [records]);

    const unreadNotificationCount = notifications.filter(
        (item) => !readNotificationIds.includes(item.id)
    ).length;

    const saveReadIds = useCallback((ids) => {
        setReadNotificationIds(ids);

        try {
            localStorage.setItem(
                "ail_read_notifications",
                JSON.stringify(ids)
            );
        } catch (error) {
            console.error("Unable to save notification status:", error);
        }
    }, []);

    const markNotificationRead = useCallback(
        (id) => {
            if (!readNotificationIds.includes(id)) {
                saveReadIds([...readNotificationIds, id]);
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
    }, [readNotificationIds, notifications, saveReadIds]);

    async function handleLogout() {
        setSigningOut(true);

        try {
            await signOut(auth);
            router.replace("/");
        } catch (error) {
            console.error("Sign-out error:", error);
            setNotice("Unable to sign out. Please try again.");
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

    const role = userRole.toLowerCase();
    const canManageUsers = [
        "super admin",
        "superadmin",
        "admin",
    ].includes(role);

    const shellValue = {
        search,
        setSearch,
        records,
        loadingData,
        dataError,
        notifications,
        unreadNotificationCount,
        markNotificationRead,
        markAllNotificationsRead,
    };

    return (
        <DashboardShellContext.Provider value={shellValue}>
            <main className="min-h-screen bg-slate-100 text-slate-800">
                <header className="sticky top-0 z-40 flex min-h-[72px] items-center justify-between gap-3 border-b border-blue-900 bg-[#0b4da2] px-4 py-3 text-white shadow-sm sm:px-6">
                    <div className="flex min-w-0 items-center gap-3">
                        <button
                            type="button"
                            onClick={() => setMobileMenuOpen((value) => !value)}
                            className="rounded-lg p-2 hover:bg-white/10 lg:hidden"
                            aria-label="Toggle navigation"
                        >
                            ☰
                        </button>

                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/20 bg-white/10 font-bold">
                            AIL
                        </div>

                        <div className="min-w-0">
                            <h1 className="truncate text-sm font-bold tracking-wide sm:text-base">
                                AMIN INTERNATIONAL LIMITED
                            </h1>
                            <p className="mt-0.5 text-xs text-blue-100">
                                Expiry &amp; Renewal Tracker
                            </p>
                        </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2 sm:gap-4">
                        <div className="hidden items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-3 py-2 md:flex">
                            <span aria-hidden="true">⌕</span>
                            <input
                                aria-label="Search records"
                                placeholder="Search records..."
                                value={search}
                                onChange={(event) =>
                                    setSearch(event.target.value)
                                }
                                className="w-36 bg-transparent text-sm text-white outline-none placeholder:text-blue-100 lg:w-48"
                            />
                            {search && (
                                <button
                                    type="button"
                                    onClick={() => setSearch("")}
                                    aria-label="Clear search"
                                    className="text-white/80"
                                >
                                    ×
                                </button>
                            )}
                        </div>

                        <div className="relative">
                            <button
                                type="button"
                                onClick={() =>
                                    setShowNotifications((value) => !value)
                                }
                                className="relative rounded-lg p-2 text-lg hover:bg-white/10"
                                aria-label="Notifications"
                                title="Notifications"
                            >
                                🔔
                                {unreadNotificationCount > 0 && (
                                    <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                                        {unreadNotificationCount > 99
                                            ? "99+"
                                            : unreadNotificationCount}
                                    </span>
                                )}
                            </button>

                            {showNotifications && (
                                <div className="absolute right-0 top-12 z-50 w-[min(90vw,360px)] overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-800 shadow-xl">
                                    <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                                        <div>
                                            <p className="text-sm font-bold">
                                                Expiry Notifications
                                            </p>
                                            <p className="text-xs text-slate-500">
                                                {unreadNotificationCount} unread
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={markAllNotificationsRead}
                                            className="text-xs font-semibold text-blue-700 hover:underline"
                                        >
                                            Mark all read
                                        </button>
                                    </div>

                                    <div className="max-h-[360px] overflow-y-auto">
                                        {notifications.length === 0 ? (
                                            <p className="px-4 py-8 text-center text-sm text-slate-500">
                                                No expiry alerts at the moment.
                                            </p>
                                        ) : (
                                            notifications.map((item) => {
                                                const isRead =
                                                    readNotificationIds.includes(
                                                        item.id
                                                    );

                                                return (
                                                    <button
                                                        type="button"
                                                        key={item.id}
                                                        onClick={() =>
                                                            markNotificationRead(
                                                                item.id
                                                            )
                                                        }
                                                        className={`block w-full border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50 ${isRead
                                                            ? "bg-white"
                                                            : "bg-blue-50/70"
                                                            }`}
                                                    >
                                                        <div className="flex items-start justify-between gap-3">
                                                            <p className="text-sm font-semibold">
                                                                {item.title}
                                                            </p>
                                                            {!isRead && (
                                                                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-blue-600" />
                                                            )}
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
                                                );
                                            })
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="hidden max-w-48 text-right sm:block">
                            <p className="truncate text-sm font-semibold">
                                {userRole || "User"}
                            </p>
                            <p className="truncate text-xs text-blue-100">
                                {user.email}
                            </p>
                        </div>

                        <button
                            type="button"
                            onClick={handleLogout}
                            disabled={signingOut}
                            className="rounded-lg border border-white/30 px-3 py-2 text-xs font-semibold hover:bg-white/10 disabled:opacity-60"
                        >
                            {signingOut ? "Signing out..." : "Sign out"}
                        </button>
                    </div>
                </header>

                {notice && (
                    <div className="fixed right-4 top-20 z-[60] flex max-w-md items-start justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 shadow-lg">
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

                <div className="flex min-h-[calc(100vh-72px)]">
                    {mobileMenuOpen && (
                        <button
                            type="button"
                            aria-label="Close navigation"
                            onClick={() => setMobileMenuOpen(false)}
                            className="fixed inset-0 top-[72px] z-30 bg-slate-950/30 lg:hidden"
                        />
                    )}

                    <aside
                        className={`fixed bottom-0 left-0 top-[72px] z-30 flex w-[250px] flex-col border-r border-slate-200 bg-white transition-transform lg:sticky lg:top-[72px] lg:z-10 lg:h-[calc(100vh-72px)] lg:translate-x-0 ${mobileMenuOpen
                            ? "translate-x-0"
                            : "-translate-x-full"
                            }`}
                    >
                        <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-6">
                            {navGroups.map((group, index) => {
                                const items = group.items.filter(
                                    (item) =>
                                        item.name !== "Users" || canManageUsers
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
                                                    (item.path !== "/dashboard" &&
                                                        pathname.startsWith(
                                                            item.path + "/"
                                                        ))
                                                    : item.children?.some(
                                                        (child) =>
                                                            pathname ===
                                                            child.path ||
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
                                                                                !previous[
                                                                                item.name
                                                                                ],
                                                                        })
                                                                    );
                                                                } else if (item.path) {
                                                                    router.push(
                                                                        item.path
                                                                    );
                                                                }
                                                            }}
                                                            className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium transition ${active
                                                                ? "bg-blue-50 text-blue-800"
                                                                : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                                                                }`}
                                                        >
                                                            <span className="flex h-6 w-6 items-center justify-center text-lg">
                                                                {item.icon}
                                                            </span>
                                                            <span className="flex-1">
                                                                {item.name}
                                                            </span>
                                                            {item.children && (
                                                                <span className="text-xs">
                                                                    {openMenus[
                                                                        item.name
                                                                    ]
                                                                        ? "⌄"
                                                                        : "›"}
                                                                </span>
                                                            )}
                                                        </button>

                                                        {item.children &&
                                                            openMenus[
                                                            item.name
                                                            ] && (
                                                                <div className="ml-9 mt-1 space-y-1 border-l border-slate-200 pl-3">
                                                                    {item.children.map(
                                                                        (child) => {
                                                                            const childActive =
                                                                                pathname ===
                                                                                child.path;

                                                                            return (
                                                                                <button
                                                                                    key={child.path}
                                                                                    type="button"
                                                                                    onClick={() =>
                                                                                        router.push(
                                                                                            child.path
                                                                                        )
                                                                                    }
                                                                                    className={`block w-full rounded-lg px-2 py-2 text-left text-xs leading-5 ${childActive
                                                                                        ? "bg-blue-50 font-semibold text-blue-700"
                                                                                        : "text-slate-500 hover:bg-slate-50 hover:text-blue-700"
                                                                                        }`}
                                                                                >
                                                                                    {
                                                                                        child.name
                                                                                    }
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

                        <div className="border-t border-slate-100 p-4">
                            <div className="rounded-xl bg-slate-50 p-3">
                                <p className="text-xs font-semibold text-slate-700">
                                    Expiry &amp; Renewal Tracker
                                </p>
                                <p className="mt-1 text-[11px] text-slate-500">
                                    Version 2.1.0
                                </p>
                            </div>
                        </div>
                    </aside>


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
