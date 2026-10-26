
"use client";

import { useMemo, useState } from "react";

const BLUE = "#0b4da2";

function getDaysRemaining(dateValue) {
    if (!dateValue) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const expiry = new Date(dateValue);
    if (Number.isNaN(expiry.getTime())) return null;
    expiry.setHours(0, 0, 0, 0);

    return Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
}

function getDateStatus(dateValue) {
    const days = getDaysRemaining(dateValue);

    if (days === null) return "Unknown";
    if (days < 0) return "Expired";
    if (days <= 10) return "Expiring Soon";
    return "Active";
}

function formatDate(value) {
    if (!value) return "—";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";

    return date.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    });
}

function money(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "—";

    return amount.toLocaleString("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 2,
    });
}

function FilterSelect({ label, value, onChange, options }) {
    return (
        <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs font-medium text-slate-500">{label}</span>
            <select
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            >
                {options.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </label>
    );
}

function TypeBadge({ children, vehicle = false }) {
    const colors = vehicle
        ? "bg-sky-50 text-sky-700 ring-sky-200"
        : children === "AMC"
            ? "bg-blue-50 text-blue-700 ring-blue-200"
            : children === "Warranty"
                ? "bg-amber-50 text-amber-700 ring-amber-200"
                : "bg-emerald-50 text-emerald-700 ring-emerald-200";

    return (
        <span className={`inline-flex whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${colors}`}>
            {children || "Other"}
        </span>
    );
}

function StatusBadge({ status }) {
    const styles = {
        Expired: "bg-red-50 text-red-700 ring-red-200",
        "Expiring Soon": "bg-amber-50 text-amber-700 ring-amber-200",
        Active: "bg-emerald-50 text-emerald-700 ring-emerald-200",
        Unknown: "bg-slate-100 text-slate-600 ring-slate-200",
    };

    return (
        <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${styles[status] || styles.Unknown}`}>
            {status}
        </span>
    );
}

export default function RecordsTable({
    title,
    icon,
    records = [],
    loading = false,
    error = "",
    vehicle = false,
    onAdd,
    onViewAll,
    limit,
    showHeader = true,
    showAddButton = true,
    showFooter = true,
}) {
    const [search, setSearch] = useState("");
    const [recordType, setRecordType] = useState("All");
    const [period, setPeriod] = useState("All");
    const [statusFilter, setStatusFilter] = useState("All");

    const filtered = useMemo(() => {
        return records.filter((record) => {
            const expiry = vehicle ? record.expiryDate : record.endDate;
            const status = getDateStatus(expiry);
            const type = vehicle ? record.type : record.category;

            const searchable = vehicle
                ? [
                    record.policyNo,
                    record.vehicleNo,
                    record.type,
                    record.personName,
                    record.insurerCompany,
                    record.noc,
                ]
                : [
                    record.productName,
                    record.assetId,
                    record.category,
                    record.vendor,
                ];

            const matchesSearch = searchable.some((item) =>
                String(item || "").toLowerCase().includes(search.toLowerCase())
            );

            const matchesType = recordType === "All" || type === recordType;
            const days = getDaysRemaining(expiry);

            const matchesPeriod =
                period === "All" ||
                (days !== null &&
                    (period === "Expired"
                        ? days < 0
                        : period === "10"
                            ? days >= 0 && days <= 10
                            : period === "30"
                                ? days >= 0 && days <= 30
                                : period === "90"
                                    ? days >= 0 && days <= 90
                                    : false));

            const matchesStatus =
                statusFilter === "All" || status === statusFilter;

            return matchesSearch && matchesType && matchesPeriod && matchesStatus;
        });
    }, [records, search, recordType, period, statusFilter, vehicle]);

    const typeOptions = vehicle
        ? ["Insurance", "Pollution"]
        : ["AMC", "Warranty", "Software License"];

    const headings = vehicle
        ? [
            "Policy No.",
            "Vehicle No.",
            "Type",
            "Person Name",
            "Insurer Company",
            "Start Date",
            "Expiry Date",
            "Amount",
            "NOC",
            "Status",
        ]
        : [
            "Product Name",
            "Asset ID",
            "Category",
            "Vendor",
            "Start Date",
            "Expiry Date",
            "Cost",
            "Status",
        ];

    const displayedRecords =
        limit ? filtered.slice(0, limit) : filtered;

    return (
        <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            {showHeader && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-xl">
                            {icon}
                        </div>
                        <div>
                            <h3 className="font-semibold text-slate-900">{title}</h3>
                            <p className="mt-0.5 text-xs text-slate-500">
                                Total: {records.length} {vehicle ? "Vehicles" : "Records"}
                            </p>
                        </div>
                    </div>

                    {showAddButton && onAdd && (
                        <button
                            type="button"
                            onClick={onAdd}
                            className="rounded-lg px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90"
                            style={{ backgroundColor: BLUE }}
                        >
                            + Add Record
                        </button>
                    )}
                </div>
            )}

            <div className="space-y-3 border-b border-slate-100 p-4">
                <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={`Search ${vehicle ? "vehicles" : "IT devices"}...`}
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-100"
                />

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <FilterSelect
                        label="Record Type"
                        value={recordType}
                        onChange={setRecordType}
                        options={[
                            { value: "All", label: "All types" },
                            ...typeOptions.map((type) => ({ value: type, label: type })),
                        ]}
                    />
                    <FilterSelect
                        label="Expiry Period"
                        value={period}
                        onChange={setPeriod}
                        options={[
                            { value: "All", label: "Any date" },
                            { value: "10", label: "Within 10 days" },
                            { value: "30", label: "Within 30 days" },
                            { value: "90", label: "Within 90 days" },
                            { value: "Expired", label: "Already expired" },
                        ]}
                    />
                    <FilterSelect
                        label="Status"
                        value={statusFilter}
                        onChange={setStatusFilter}
                        options={[
                            { value: "All", label: "All statuses" },
                            { value: "Active", label: "Active" },
                            { value: "Expiring Soon", label: "Expiring Soon" },
                            { value: "Expired", label: "Expired" },
                        ]}
                    />
                </div>
            </div>

            {error ? (
                <div className="m-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                    Records could not be loaded. Check your Firestore security rules and browser console.
                </div>
            ) : loading ? (
                <p className="p-8 text-center text-sm text-slate-500">
                    Loading records from Firestore...
                </p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[1100px] text-left text-sm">
                        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                            <tr>
                                {headings.map((heading) => (
                                    <th key={heading} className="whitespace-nowrap px-4 py-3 font-semibold">
                                        {heading}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {displayedRecords.map((record) => {
                                const expiry = vehicle ? record.expiryDate : record.endDate;
                                const status = getDateStatus(expiry);

                                return (
                                    <tr key={record.id} className="transition hover:bg-slate-50">
                                        {vehicle ? (
                                            <>
                                                <td className="whitespace-nowrap px-4 py-4">{record.policyNo || "—"}</td>
                                                <td className="whitespace-nowrap px-4 py-4 font-medium">{record.vehicleNo || "—"}</td>
                                                <td className="whitespace-nowrap px-4 py-4"><TypeBadge vehicle>{record.type}</TypeBadge></td>
                                                <td className="whitespace-nowrap px-4 py-4">{record.personName || "—"}</td>
                                                <td className="whitespace-nowrap px-4 py-4">{record.insurerCompany || "—"}</td>
                                                <td className="whitespace-nowrap px-4 py-4">{formatDate(record.startDate)}</td>
                                                <td className="whitespace-nowrap px-4 py-4">{formatDate(expiry)}</td>
                                                <td className="whitespace-nowrap px-4 py-4">{money(record.amount)}</td>
                                                <td className="whitespace-nowrap px-4 py-4">{record.noc || "—"}</td>
                                                <td className="whitespace-nowrap px-4 py-4"><StatusBadge status={status} /></td>
                                            </>
                                        ) : (
                                            <>
                                                <td className="whitespace-nowrap px-4 py-4 font-medium">{record.productName || "—"}</td>
                                                <td className="whitespace-nowrap px-4 py-4 font-mono text-xs">{record.assetId || "—"}</td>
                                                <td className="whitespace-nowrap px-4 py-4"><TypeBadge>{record.category}</TypeBadge></td>
                                                <td className="whitespace-nowrap px-4 py-4">{record.vendor || "—"}</td>
                                                <td className="whitespace-nowrap px-4 py-4">{formatDate(record.startDate)}</td>
                                                <td className="whitespace-nowrap px-4 py-4">{formatDate(expiry)}</td>
                                                <td className="whitespace-nowrap px-4 py-4">{money(record.cost)}</td>
                                                <td className="whitespace-nowrap px-4 py-4"><StatusBadge status={status} /></td>
                                            </>
                                        )}
                                    </tr>
                                );
                            })}

                            {displayedRecords.length === 0 && (
                                <tr>
                                    <td colSpan={headings.length} className="px-5 py-12 text-center">
                                        <p className="font-medium text-slate-700">No records found</p>
                                        <p className="mt-1 text-xs text-slate-500">
                                            {records.length === 0
                                                ? "Records will appear here once they are added to Firestore."
                                                : "Try changing your search or filters."}
                                        </p>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            {showFooter && (
                <div className="flex items-center justify-between border-t border-slate-100 px-5 py-4">
                    <p className="text-xs text-slate-500">
                        Showing {displayedRecords.length} of {filtered.length} filtered records
                    </p>
                    {onViewAll && (
                        <button
                            type="button"
                            onClick={onViewAll}
                            className="text-sm font-semibold text-blue-700 hover:text-blue-900"
                        >
                            View All →
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}
