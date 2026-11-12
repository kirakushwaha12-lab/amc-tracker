
"use client";
import { useEffect, useMemo, useState } from "react";
import { useDashboardShell } from "./layout";

function toDate(value) {
    if (!value) return null;

    if (typeof value?.toDate === "function") {
        return value.toDate();
    }

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value === "string") {
        const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);

        if (match) {
            const [, year, month, day] = match;
            return new Date(Number(year), Number(month) - 1, Number(day));
        }

        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    if (typeof value === "number") {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    if (typeof value === "object" && Number.isFinite(value.seconds)) {
        return new Date(value.seconds * 1000);
    }

    return null;
}

function getModule(record) {
    if (record._source === "compliance_records") {
        return "Compliance";
    }

    if (record._source === "vehicles") {
        const type = String(record.type || record.category || "").toLowerCase();
        return type.includes("pollution") ? "Pollution" : "Insurance";
    }

    const type = String(record.type || record.category || "").toLowerCase();

    if (type.includes("warranty")) return "Warranty";
    if (type.includes("software")) return "Software License";
    if (type.includes("amc")) return "AMC";

    return "IT Devices";
}

function getExpiryDate(record) {
    const module = getModule(record);

    let fields;

    if (module === "Insurance") {
        fields = ["expiryDate"];
    } else if (module === "Pollution") {
        fields = ["expiryDate", "pollutionExpiryDate"];
    } else if (module === "Compliance") {
        fields = ["validTill", "validUntil", "validTillDate", "expiryDate", "endDate"];
    } else if (module === "AMC") {
        fields = ["endDate"];
    } else if (module === "Warranty") {
        fields = ["warrantyExpiry", "warrantyExpired", "endDate", "expiryDate"];
    } else if (module === "Software License") {
        fields = ["expiryDate"];
    } else {
        fields = ["endDate", "expiryDate"];
    }

    for (const field of fields) {
        const parsed = toDate(record[field]);
        if (parsed) return parsed;
    }

    return null;
}

function getStartDate(record) {
    const module = getModule(record);

    const fields =
        module === "Pollution"
            ? ["certificateDate", "startDate"]
            : module === "Compliance"
                ? ["examinationDate", "startDate", "periodDate"]
                : ["startDate", "periodDate", "purchaseDate"];

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
        record.vehicleNumber ||
        record.name ||
        record.policyNo ||
        record.certificateNo ||
        "Unnamed Record"
    );
}

function getCompany(record) {
    return (
        record.companyVendor ||
        record.company ||
        record.vendor ||
        record.supplier ||
        record.serviceProvider ||
        record.pucCentre ||
        record.pucCenter ||
        record.insurerCompany ||
        record.insuranceCompany ||
        record.partnerCompany ||
        record.companyName ||
        "—"
    );
}

function getStatus(daysRemaining) {
    if (daysRemaining === null) return "Unknown";
    if (daysRemaining < 0) return "Expired";
    if (daysRemaining <= 10) return "Expiring Soon";
    return "Active";
}

function formatDate(date) {
    if (!date) return "—";

    return date.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    });
}

function StatusBadge({ status }) {
    const styles = {
        Active: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
        "Expiring Soon": "bg-amber-50 text-amber-700 ring-amber-600/20",
        Expired: "bg-red-50 text-red-700 ring-red-600/20",
        Unknown: "bg-slate-100 text-slate-600 ring-slate-500/20",
    };

    return (
        <span
            className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${styles[status] || styles.Unknown
                }`}
        >
            {status}
        </span>
    );
}

function SummaryCard({ title, value, description, icon, accent }) {
    return (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <p className="text-sm font-medium text-slate-500">
                        {title}
                    </p>
                    <p className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
                        {value}
                    </p>
                    <p className="mt-2 text-xs text-slate-500">
                        {description}
                    </p>
                </div>

                <div
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl ${accent}`}
                >
                    {icon}
                </div>
            </div>
        </div>
    );
}

export default function Dashboard() {
    const { search, records, loadingData, dataError } = useDashboardShell();

    const [expiryTypeFilter, setExpiryTypeFilter] = useState("All");
    const [expirySearch, setExpirySearch] = useState("");
    const [todayKey, setTodayKey] = useState(
        () => new Date().toDateString()
    );

    useEffect(() => {
        const now = new Date();
        const nextMidnight = new Date(now);

        nextMidnight.setHours(24, 0, 0, 0);

        const timer = setTimeout(() => {
            setTodayKey(new Date().toDateString());
        }, nextMidnight.getTime() - now.getTime());

        return () => clearTimeout(timer);
    }, [todayKey]);

    const allRecords = useMemo(() => {
        return records.map((record) => {
            const expiryDate = getExpiryDate(record);
            const startDate = getStartDate(record);
            const daysRemaining = getDaysRemaining(expiryDate);

            return {
                id: record.id,
                productName: getProductName(record),
                companyName: getCompany(record),
                module: getModule(record),
                startDate,
                expiryDate,
                daysRemaining,
                status: getStatus(daysRemaining),
            };
        });
    }, [records, todayKey]);

    const summary = useMemo(() => ({
        total: allRecords.length,

        expiringSoon: allRecords.filter(
            (record) =>
                record.daysRemaining !== null &&
                record.daysRemaining >= 0 &&
                record.daysRemaining <= 10
        ).length,

        expired: allRecords.filter(
            (record) =>
                record.daysRemaining !== null &&
                record.daysRemaining < 0
        ).length,

        active: allRecords.filter(
            (record) =>
                record.daysRemaining !== null &&
                record.daysRemaining > 10
        ).length,
    }), [allRecords]);

    const upcomingRecords = useMemo(() => {
        const globalQuery = search.trim().toLowerCase();
        const localQuery = expirySearch.trim().toLowerCase();

        return allRecords
            .filter(
                (record) =>
                    record.daysRemaining !== null &&
                    record.daysRemaining >= 0 &&
                    record.daysRemaining <= 30
            )
            .filter((record) => {
                if (expiryTypeFilter !== "All" &&
                    record.module !== expiryTypeFilter) {
                    return false;
                }

                const searchableValues = [
                    record.productName,
                    record.module,
                    record.companyName,
                    record.status,
                ];

                if (
                    globalQuery &&
                    !searchableValues.some((value) =>
                        String(value || "").toLowerCase().includes(globalQuery)
                    )
                ) {
                    return false;
                }

                if (
                    localQuery &&
                    !searchableValues.some((value) =>
                        String(value || "").toLowerCase().includes(localQuery)
                    )
                ) {
                    return false;
                }

                return true;
            })
            .sort((a, b) => a.daysRemaining - b.daysRemaining);
    }, [allRecords, search, expirySearch, expiryTypeFilter]);

    const visibleUpcomingRecords = upcomingRecords.slice(0, 10);

    const clearExpiryFilters = () => {
        setExpiryTypeFilter("All");
        setExpirySearch("");
    };

    return (
        <div className="w-full min-w-0 space-y-6">
            <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                <div>
                    <h2 className="text-2xl font-bold tracking-tight text-slate-900">
                        Dashboard
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                        Overview of company records and upcoming expiries.
                    </p>
                </div>

                <p className="text-xs text-slate-500">
                    Expiry overview · Next 30 days
                </p>
            </div>

            {dataError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {dataError}
                </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <SummaryCard
                    title="Total Records"
                    value={loadingData ? "—" : summary.total}
                    description="Across all tracked modules"
                    icon="▦"
                    accent="bg-blue-50 text-blue-700"
                />

                <SummaryCard
                    title="Expiring Soon"
                    value={loadingData ? "—" : summary.expiringSoon}
                    description="Expiry within the next 10 days"
                    icon="◷"
                    accent="bg-amber-50 text-amber-700"
                />

                <SummaryCard
                    title="Expired"
                    value={loadingData ? "—" : summary.expired}
                    description="Records past their expiry date"
                    icon="!"
                    accent="bg-red-50 text-red-700"
                />

                <SummaryCard
                    title="Active"
                    value={loadingData ? "—" : summary.active}
                    description="More than 10 days remaining"
                    icon="✓"
                    accent="bg-emerald-50 text-emerald-700"
                />
            </div>

            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-col gap-2 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <h3 className="text-base font-bold text-slate-900">
                            Upcoming Expiries
                        </h3>
                        <p className="mt-1 text-sm text-slate-500">
                            Records expiring within the next 30 days, nearest
                            expiry first.
                        </p>
                    </div>

                    <span className="inline-flex w-fit items-center rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
                        {loadingData ? "Loading..." : `${visibleUpcomingRecords.length} of ${upcomingRecords.length} records`}
                    </span>
                </div>

                <div className="border-b border-slate-100 bg-slate-50/60 p-4">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-2">
                        <input
                            type="text"
                            value={expirySearch}
                            onChange={(e) => setExpirySearch(e.target.value)}
                            placeholder="Search product or company..."
                            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                        />

                        <select
                            value={expiryTypeFilter}
                            onChange={(e) => setExpiryTypeFilter(e.target.value)}
                            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                        >
                            <option value="All">All Types</option>
                            <option value="AMC">AMC</option>
                            <option value="Warranty">Warranty</option>
                            <option value="Insurance">Insurance</option>
                            <option value="Pollution">Pollution</option>
                            <option value="Software License">Software License</option>
                            <option value="Compliance">Compliance</option>
                        </select>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs text-slate-500">
                            Showing {visibleUpcomingRecords.length} of {upcomingRecords.length} matching records
                        </p>

                        <button
                            type="button"
                            onClick={clearExpiryFilters}
                            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
                        >
                            Clear Filters
                        </button>
                    </div>
                </div>

                <div className="overflow-x-auto">
                    <table className="min-w-[900px] w-full text-left text-sm">
                        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                            <tr>
                                <th className="px-5 py-3 font-semibold">S. No.</th>
                                <th className="px-5 py-3 font-semibold">Product / Record</th>
                                <th className="px-5 py-3 font-semibold">Module</th>
                                <th className="px-5 py-3 font-semibold">Company / Vendor</th>
                                <th className="px-5 py-3 font-semibold">Start Date</th>
                                <th className="px-5 py-3 font-semibold">Expiry Date</th>
                                <th className="px-5 py-3 font-semibold">Status</th>
                            </tr>
                        </thead>

                        <tbody className="divide-y divide-slate-100">
                            {loadingData ? (
                                <tr>
                                    <td colSpan={7} className="px-5 py-12 text-center text-sm text-slate-500">
                                        Loading records...
                                    </td>
                                </tr>
                            ) : visibleUpcomingRecords.length === 0 ? (
                                <tr>
                                    <td colSpan={7} className="px-5 py-12 text-center">
                                        <div className="text-2xl text-slate-300">✓</div>
                                        <p className="mt-2 font-semibold text-slate-700">
                                            No upcoming expiries found
                                        </p>
                                        <p className="mt-1 text-sm text-slate-500">
                                            Records expiring in the next 30 days will appear here.
                                        </p>
                                    </td>
                                </tr>
                            ) : (
                                visibleUpcomingRecords.map((record, index) => (
                                    <tr
                                        key={`${record.module}-${record.id}`}
                                        className="transition hover:bg-slate-50"
                                    >
                                        <td className="px-5 py-4 text-slate-500">
                                            {index + 1}
                                        </td>

                                        <td className="px-5 py-4 font-semibold text-slate-800">
                                            {record.productName}
                                        </td>

                                        <td className="px-5 py-4">
                                            <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                                                {record.module}
                                            </span>
                                        </td>

                                        <td className="px-5 py-4 text-slate-600">
                                            {record.companyName}
                                        </td>

                                        <td className="whitespace-nowrap px-5 py-4 text-slate-600">
                                            {formatDate(record.startDate)}
                                        </td>

                                        <td className="whitespace-nowrap px-5 py-4 font-medium text-slate-700">
                                            {formatDate(record.expiryDate)}
                                        </td>

                                        <td className="px-5 py-4">
                                            <StatusBadge status={record.status} />
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                <div className="border-t border-slate-100 px-5 py-3">
                    <p className="text-xs text-slate-500">
                        Showing up to 10 upcoming records. Use the search and module filters to narrow the results.
                    </p>
                </div>
            </section>
        </div>
    );
}
