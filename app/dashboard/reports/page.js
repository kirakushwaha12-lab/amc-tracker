
"use client";

import { useEffect, useMemo, useState } from "react";
import { useDashboardShell } from "../layout";

const MODULES = [
    "AMC",
    "Warranty",
    "Insurance",
    "Pollution",
    "Software License",
    "Compliance",
    "Machinery",
    "Service",
];

const REPORTS = [
    { value: "summary", label: "All Modules Summary", group: "Summary Reports" },
    { value: "expiring", label: "Expiring Soon Report", group: "Summary Reports" },
    { value: "expired", label: "Expired Records Report", group: "Summary Reports" },
    { value: "active", label: "Active Records Report", group: "Summary Reports" },
    ...MODULES.map((module) => ({
        value: module,
        label: `${module} Report`,
        group: "Module-wise Reports",
    })),
];

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
            return new Date(
                Number(year),
                Number(month) - 1,
                Number(day)
            );
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
    const source = record._source;
    const type = String(record.type || "").trim().toLowerCase();
    const category = String(record.category || "").trim().toLowerCase();
    const values = `${type} ${category}`;

    if (source === "compliance_records") {
        return "Compliance";
    }

    if (source === "machinery_records") {
        return "Machinery";
    }

    if (source === "vehicles") {
        if (values.includes("pollution")) return "Pollution";
        if (values.includes("service")) return "Service";
        return "Insurance";
    }

    if (values.includes("warranty")) return "Warranty";
    if (values.includes("software")) return "Software License";
    if (values.includes("amc")) return "AMC";
    return "IT Devices";
}

function getExpiryDate(record, module, eventType) {
    let fields = [];

    if (module === "Insurance") {
        fields = ["expiryDate"];
    } else if (module === "Pollution") {
        fields = ["expiryDate", "pollutionExpiryDate"];
    } else if (module === "Compliance") {
        fields = [
            "validTill",
            "validUntil",
            "validTillDate",
            "expiryDate",
            "endDate",
        ];
    } else if (module === "AMC") {
        fields = ["endDate", "expiryDate"];
    } else if (module === "Warranty") {
        fields = [
            "warrantyExpiry",
            "warrantyExpired",
            "endDate",
            "expiryDate",
        ];
    } else if (module === "Software License") {
        fields = ["expiryDate", "endDate"];
    } else if (module === "Machinery") {
        fields = eventType === "AMC Expiry"
            ? ["amcEndDate"]
            : ["nextDueDate", "nextServiceDueDate"];
    } else if (module === "Service") {
        fields = ["nextServiceDueDate"];
    } else {
        fields = ["endDate", "expiryDate"];
    }

    for (const field of fields) {
        const date = toDate(record[field]);
        if (date) return date;
    }

    return null;
}
function getStartDate(record, module, eventType) {
    let fields = [];

    if (module === "Pollution") {
        fields = ["certificateDate", "startDate"]
    } else if (module === "Compliance") {
        fields = ["examinationDate", "startDate", "periodDate"]
    } else if (module === "Warranty") {
        fields = ["startDate", "periodDate", "purchaseDate"]
    } else if (module === "Machinery") {
        fields = eventType === "AMC Expiry"
            ? ["amcStartDate"]
            : ["lastServiceDate"];
    } else if (module === "Service") {
        fields = ["lastServiceDate"];
    } else {
        fields = ["startDate", "periodDate", "purchaseDate"];
    }

    for (const field of fields) {
        const date = toDate(record[field]);
        if (date) return date;
    }

    return null;
}

function getProductName(record, module) {
    if (module === "Software License") {
        return (
            record.licenseName ||
            record.softwareName ||
            record.productName ||
            record.name ||
            "Unnamed License"
        );
    }

    if (module === "Compliance") {
        return (
            record.examinationType ||
            record.typeOfExamination ||
            record.name ||
            "Unnamed Compliance"
        );
    }

    if (module === "Machinery") {
        return (
            record.machineName ||
            record.machineNo ||
            record.machineNumber ||
            "Unnamed Machinery"
        );
    }

    if (module === "Service") {
        return record.vehicleName || record.vehicleNo || "Unnamed Vehicle";
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
            "Unnamed Insurance"
        );
    }

    return (
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
function getCompany(record, module, eventType) {
    if (module === "Machinery") {
        return eventType === "AMC Expiry"
            ? record.amcVendor || "—"
            : record.serviceProvider || "—";
    }

    if (module === "Service") {
        return record.serviceCentre || "—";
    }

    if (module === "Software License") {
        return record.vendor || record.provider || "—";
    }

    if (module === "Pollution") {
        return record.pucCentre || record.pucCenter || "—";
    }

    if (module === "Insurance") {
        return (
            record.company ||
            record.companyVendor ||
            record.vendor ||
            record.insurerCompany ||
            record.insuranceCompany ||
            record.companyName ||
            "—"
        );
    }

    return (
        record.companyVendor ||
        record.company ||
        record.vendor ||
        record.supplier ||
        record.serviceProvider ||
        record.partnerCompany ||
        record.companyName ||
        "—"
    );
}

function getAmount(record, module, eventType) {
    let value;

    if (module === "Machinery") {
        value = eventType === "AMC Expiry"
            ? record.amcCharges
            : record.serviceCharges;
    } else if (module === "Service") {
        value = record.serviceCharges;
    } else if (module === "Software License") {
        value = record.cost;
    } else if (module === "Pollution" || module === "Insurance") {
        value = record.amount;
    } else if (module === "Warranty") {
        value =
            record.priceWithoutGST ??
            record.cost ??
            record.amount ??
            record.charges;
    } else if (module === "AMC") {
        value =
            record.amcCharges ??
            record.cost ??
            record.charges ??
            record.amount;
    } else {
        value =
            record.cost ??
            record.charges ??
            record.amount ??
            record.price;
    }

    if (value === undefined || value === null || value === "") {
        return "—";
    }

    const amount = Number(value);

    return Number.isFinite(amount)
        ? `₹${amount.toLocaleString("en-IN", {
            maximumFractionDigits: 2,
        })}`
        : String(value);
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

function getStatus(days) {
    if (days === null) return "Unknown";
    if (days < 0) return "Expired";
    if (days <= 10) return "Expiring Soon";
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

function formatDateInput(date) {
    if (!date) return "";

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

function createReportEvents(record) {
    const module = getModule(record);

    if (module === "Machinery") {
        const events = [];

        const serviceExpiry = toDate(
            record.nextDueDate || record.nextServiceDueDate
        );

        if (serviceExpiry) {
            events.push({
                id: `${record._source}-${record.id}-service-due`,
                raw: record,
                module,
                moduleLabel: "Machinery Service",
                eventType: "Service Due",
                productName: getProductName(record, module),
                companyName: getCompany(record, module, "Service Due"),
                startDate: getStartDate(record, module, "Service Due"),
                expiryDate: serviceExpiry,
                amount: getAmount(record, module, "Service Due"),
            });
        }

        const isAmcApplicable =
            String(record.amcApplicable || "").trim().toLowerCase() === "yes";

        const amcExpiry = toDate(record.amcEndDate);

        if (isAmcApplicable && amcExpiry) {
            events.push({
                id: `${record._source}-${record.id}-amc-expiry`,
                raw: record,
                module,
                moduleLabel: "Machinery AMC",
                eventType: "AMC Expiry",
                productName: getProductName(record, module),
                companyName: getCompany(record, module, "AMC Expiry"),
                startDate: getStartDate(record, module, "AMC Expiry"),
                expiryDate: amcExpiry,
                amount: getAmount(record, module, "AMC Expiry"),
            });
        }

        return events;
    }

    const expiryDate = getExpiryDate(record, module);
    const startDate = getStartDate(record, module);

    return [{
        id: `${record._source}-${record.id}`,
        raw: record,
        module,
        moduleLabel: module,
        eventType: module === "Service" ? "Service Due" : module,
        productName: getProductName(record, module),
        companyName: getCompany(record, module),
        startDate,
        expiryDate,
        amount: getAmount(record, module),
    }];
}

function getRecordKey(record) {
    return `${record?._source || ""}-${record?.id || ""}`;
}

function matchesMachineryRecordSearch(record, query) {
    if (!query) return true;

    const searchableValues = [
        getProductName(record, "Machinery"),
        "Machinery",
        record.serviceProvider,
        record.amcVendor,
    ];

    return searchableValues.some((value) =>
        String(value || "").toLowerCase().includes(query)
    );
}
export default function ReportsPage() {
    const { records = [], loadingData, dataError } = useDashboardShell();

    const [reportMode, setReportMode] = useState("");
    const [selectedReport, setSelectedReport] = useState("");
    const [moduleFilter, setModuleFilter] = useState("All");
    const [statusFilter, setStatusFilter] = useState("All");
    const [search, setSearch] = useState("");
    const [fromDate, setFromDate] = useState("");
    const [toDate, setToDate] = useState("");
    const [showAll, setShowAll] = useState(false);

    const [todayKey, setTodayKey] = useState(
        () => new Date().toDateString()
    );
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const requestedReport = params.get("report");

        const validReports = [
            "summary",
            "expiring",
            "expired",
            "active",
        ];

        if (!validReports.includes(requestedReport)) return;

        setReportMode("summary");
        setSelectedReport(requestedReport);
        setShowAll(false);
        setModuleFilter("All");
        setStatusFilter("All");
        setSearch("");
        setFromDate("");
        setToDate("");
    }, []);
    useEffect(() => {
        const now = new Date();
        const nextMidnight = new Date(now);

        nextMidnight.setHours(24, 0, 0, 0);

        const timer = window.setTimeout(() => {
            setTodayKey(new Date().toDateString());
        }, nextMidnight.getTime() - now.getTime());

        return () => window.clearTimeout(timer);
    }, [todayKey]);

    const normalizedRecords = useMemo(() => {
        return records.flatMap((record) =>
            createReportEvents(record).map((event) => {
                const daysRemaining = getDaysRemaining(event.expiryDate);

                return {
                    ...event,
                    daysRemaining,
                    status: getStatus(daysRemaining),
                };
            })
        );
    }, [records, todayKey]);

    const filteredRecords = useMemo(() => {
        const query = search.trim().toLowerCase();

        return normalizedRecords.filter((record) => {
            if (
                selectedReport === "expiring" &&
                !(
                    record.daysRemaining !== null &&
                    record.daysRemaining >= 0 &&
                    record.daysRemaining <= 10
                )
            ) {
                return false;
            }

            if (
                selectedReport === "expired" &&
                !(record.daysRemaining !== null && record.daysRemaining < 0)
            ) {
                return false;
            }
            if (
                selectedReport === "active" &&
                !(record.daysRemaining !== null && record.daysRemaining > 10)
            ) {
                return false;
            }
            if (
                MODULES.includes(selectedReport) &&
                record.module !== selectedReport
            ) {
                return false;
            }

            if (
                !MODULES.includes(selectedReport) &&
                moduleFilter !== "All" &&
                record.module !== moduleFilter
            ) {
                return false;
            }

            if (
                reportMode === "module" &&
                statusFilter !== "All" &&
                record.status !== statusFilter
            ) {
                return false;
            }

            if (
                fromDate &&
                (!record.expiryDate ||
                    formatDateInput(record.expiryDate) < fromDate)
            ) {
                return false;
            }

            if (
                toDate &&
                (!record.expiryDate ||
                    formatDateInput(record.expiryDate) > toDate)
            ) {
                return false;
            }

            if (query) {
                const matchesSearch = [
                    record.productName,
                    record.companyName,
                    record.module,
                    record.moduleLabel,
                    record.eventType,
                    record.status,
                ].some((value) =>
                    String(value || "").toLowerCase().includes(query)
                );

                if (!matchesSearch) return false;
            }

            return true;
        });
    }, [
        normalizedRecords,
        selectedReport,
        moduleFilter,
        statusFilter,
        reportMode,
        search,
        fromDate,
        toDate,
    ]);
    const noEventMachineryRecords = useMemo(() => {
        if (
            selectedReport !== "summary" ||
            fromDate ||
            toDate ||
            (moduleFilter !== "All" && moduleFilter !== "Machinery")
        ) {
            return [];
        }

        const eventRecordKeys = new Set(
            normalizedRecords.map((record) =>
                getRecordKey(record.raw)
            )
        );

        const query = search.trim().toLowerCase();

        return records.filter((record) => {
            if (getModule(record) !== "Machinery") {
                return false;
            }

            if (eventRecordKeys.has(getRecordKey(record))) {
                return false;
            }

            if (!matchesMachineryRecordSearch(record, query)) {
                return false;
            }

            return true;
        });
    }, [
        records,
        normalizedRecords,
        selectedReport,
        statusFilter,
        fromDate,
        toDate,
        moduleFilter,
        search,
    ]);
    const clearFilters = () => {
        setModuleFilter("All");
        setStatusFilter("All");
        setSearch("");
        setFromDate("");
        setToDate("");
    };

    const chooseReport = (value) => {
        setSelectedReport(value);
        setShowAll(false);
        clearFilters();
    };

    const visibleRecords = showAll
        ? filteredRecords
        : filteredRecords.slice(0, 10);

    const reportTitle =
        REPORTS.find((report) => report.value === selectedReport)?.label ||
        "Report";

    const reportSubtitle =
        selectedReport === "summary"
            ? "Summary of records by module and expiry status"
            : selectedReport === "expiring"
                ? "Records expiring within the next 10 days"
                : selectedReport === "expired"
                    ? "Records past their expiry date"
                    : selectedReport === "active"
                        ? "Records with more than 10 days remaining"
                        : `Detailed ${selectedReport} records`;
    const summaryCounts = useMemo(() => {
        const uniqueRecords = new Set(
            filteredRecords.map((record) =>
                getRecordKey(record.raw)
            )
        );

        noEventMachineryRecords.forEach((record) => {
            uniqueRecords.add(getRecordKey(record));
        });

        return {
            total: uniqueRecords.size,

            active: filteredRecords.filter(
                (r) => r.status === "Active"
            ).length,

            expiring: filteredRecords.filter(
                (r) => r.status === "Expiring Soon"
            ).length,

            expired: filteredRecords.filter(
                (r) => r.status === "Expired"
            ).length,

            unknown: filteredRecords.filter(
                (r) => r.status === "Unknown"
            ).length,
        };
    }, [
        filteredRecords,
        selectedReport,
        noEventMachineryRecords,
    ]);

    const getModuleCounts = (module) => {
        const moduleRecords = filteredRecords.filter(
            (record) => record.module === module
        );

        const uniqueRecords = new Set(
            moduleRecords.map((record) =>
                getRecordKey(record.raw)
            )
        );

        if (module === "Machinery") {
            noEventMachineryRecords.forEach((record) => {
                uniqueRecords.add(getRecordKey(record));
            });
        }

        return {
            total: uniqueRecords.size,

            active: moduleRecords.filter(
                (r) => r.status === "Active"
            ).length,

            expiring: moduleRecords.filter(
                (r) => r.status === "Expiring Soon"
            ).length,

            expired: moduleRecords.filter(
                (r) => r.status === "Expired"
            ).length,

            unknown: moduleRecords.filter(
                (r) => r.status === "Unknown"
            ).length,
        };
    };
    const handlePrint = () => {
        if (loadingData) {
            window.alert("Please wait until records finish loading.");
            return;
        }

        if (
            filteredRecords.length === 0 &&
            !(selectedReport === "summary" && noEventMachineryRecords.length > 0)
        ) {
            window.alert("No records found for this report and filters.");
            return;
        }

        window.print();
    };

    return (
        <main className="min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8">
            <div className="mx-auto max-w-[1600px] space-y-6">
                <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <h1 className="mt-1 text-3xl font-bold text-slate-900">
                            Report Management
                        </h1>
                        <p className="mt-2 text-sm text-slate-500">
                            View, filter and download company expiry reports.
                        </p>
                    </div>

                    <span className="text-xs text-slate-500">
                        {loadingData
                            ? "Loading records..."
                            : `${records.length} database records`}
                    </span>
                </div>

                {dataError && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {dataError}
                    </div>
                )}

                {!reportMode ? (
                    <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <button
                            type="button"
                            onClick={() => setReportMode("module")}
                            className="rounded-2xl border border-slate-200 bg-white p-6 text-left shadow-sm transition hover:border-blue-400 hover:bg-blue-50/40"
                        >
                            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-100 text-xl text-blue-700">
                                ▦
                            </span>
                            <span className="mt-4 block text-lg font-bold text-slate-900">
                                Module-wise
                            </span>
                            <span className="mt-2 block text-sm text-slate-500">
                                Choose a module to view its detailed records and expiry information.
                            </span>
                        </button>

                        <button
                            type="button"
                            onClick={() => setReportMode("summary")}
                            className="rounded-2xl border border-slate-200 bg-white p-6 text-left shadow-sm transition hover:border-blue-400 hover:bg-blue-50/40"
                        >
                            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-100 text-xl text-indigo-700">
                                ▤
                            </span>
                            <span className="mt-4 block text-lg font-bold text-slate-900">
                                Summary-wise
                            </span>
                            <span className="mt-2 block text-sm text-slate-500">
                                View all-module counts, upcoming expiries or expired records.
                            </span>
                        </button>
                    </section>
                ) : !selectedReport ? (
                    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <h3 className="text-base font-bold text-slate-900">
                                    {reportMode === "module"
                                        ? "Module-wise Reports"
                                        : "Summary-wise Reports"}
                                </h3>
                                <p className="mt-1 text-sm text-slate-500">
                                    Select the report you want to view.
                                </p>
                            </div>

                            <button
                                type="button"
                                onClick={() => {
                                    setReportMode("");
                                    setSelectedReport("");
                                    setShowAll(false);
                                    clearFilters();
                                }}
                                className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                            >
                                ← Back
                            </button>
                        </div>

                        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                            {REPORTS.filter(
                                (report) =>
                                    report.group ===
                                    (reportMode === "module"
                                        ? "Module-wise Reports"
                                        : "Summary Reports")
                            ).map((report) => (
                                <button
                                    key={report.value}
                                    type="button"
                                    onClick={() => chooseReport(report.value)}
                                    className="rounded-xl border border-slate-200 p-4 text-left transition hover:border-blue-400 hover:bg-blue-50/50"
                                >
                                    <span className="block text-sm font-semibold text-slate-900">
                                        {report.label}
                                    </span>
                                    <span className="mt-2 block text-xs text-slate-500">
                                        {report.value === "summary"
                                            ? "Record counts and status by module"
                                            : report.value === "expiring"
                                                ? "Upcoming expiries in the next 10 days"
                                                : report.value === "expired"
                                                    ? "Records with past expiry dates"
                                                    : report.value === "active"
                                                        ? "Records with more than 10 days remaining"
                                                        : "View module records and print / save as PDF"}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </section>
                ) : (
                    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                        <div className="border-b border-slate-100 px-5 py-4">
                            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                                <div>
                                    <h3 className="text-base font-bold text-slate-900">
                                        {reportTitle}
                                    </h3>
                                    <p className="mt-1 text-sm text-slate-500">
                                        {reportSubtitle}
                                    </p>
                                </div>

                                <div className="flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setSelectedReport("");
                                            setShowAll(false);
                                            clearFilters();
                                        }}
                                        className="inline-flex items-center justify-center rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                                    >
                                        ← Choose Another Report
                                    </button>

                                    <button
                                        type="button"
                                        onClick={handlePrint}
                                        disabled={
                                            loadingData ||
                                            (
                                                filteredRecords.length === 0 &&
                                                !(selectedReport === "summary" && noEventMachineryRecords.length > 0)
                                            )
                                        }
                                        className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                                        style={{ backgroundColor: "#0b4da2" }}
                                    >
                                        <span aria-hidden="true">▤</span>
                                        Print / Save as PDF
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div className="border-b border-slate-100 bg-slate-50/60 p-4">
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                <input
                                    type="text"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    placeholder="Search product or company..."
                                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                                />
                                {!MODULES.includes(selectedReport) && (
                                    <select
                                        value={moduleFilter}
                                        onChange={(e) => setModuleFilter(e.target.value)}
                                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                                    >
                                        <option value="All">All Modules</option>
                                        {MODULES.map((module) => (
                                            <option key={module} value={module}>
                                                {module}
                                            </option>
                                        ))}
                                    </select>
                                )}

                                {reportMode === "module" && (
                                    <select
                                        value={statusFilter}
                                        onChange={(e) => setStatusFilter(e.target.value)}
                                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                                    >
                                        <option value="All">All Statuses</option>
                                        <option value="Active">Active</option>
                                        <option value="Expiring Soon">Expiring Soon</option>
                                        <option value="Expired">Expired</option>
                                        <option value="Unknown">Unknown</option>
                                    </select>
                                )}

                                <div>
                                    <label className="mb-1 block text-xs font-medium text-slate-600">
                                        Expiry From
                                    </label>
                                    <input
                                        type="date"
                                        value={fromDate}
                                        max={toDate || undefined}
                                        onChange={(e) => setFromDate(e.target.value)}
                                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                                    />
                                </div>

                                <div>
                                    <label className="mb-1 block text-xs font-medium text-slate-600">
                                        Expiry To
                                    </label>
                                    <input
                                        type="date"
                                        value={toDate}
                                        min={fromDate || undefined}
                                        onChange={(e) => setToDate(e.target.value)}
                                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                                    />
                                </div>
                            </div>

                            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                                <p className="text-xs text-slate-500">
                                    Showing {filteredRecords.length} matching report entries
                                </p>

                                <button
                                    type="button"
                                    onClick={clearFilters}
                                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
                                >
                                    Clear Filters
                                </button>
                            </div>
                        </div>

                        <div className="border-b border-slate-100 p-4">
                            <div className="max-w-xs rounded-xl border border-slate-200 bg-white p-4">
                                <p className="text-xs text-slate-500">Total Records</p>
                                <p className="mt-1 text-2xl font-bold text-slate-900">
                                    {summaryCounts.total}
                                </p>
                            </div>
                        </div>

                        {selectedReport === "summary" ? (
                            <div className="overflow-x-auto">
                                <table className="min-w-[700px] w-full text-left text-sm">
                                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                        <tr>
                                            {[
                                                "Module",
                                                "Total Records",
                                                "Active",
                                                "Expiring Soon",
                                                "Expired",
                                                "Unknown",
                                            ].map((heading) => (
                                                <th
                                                    key={heading}
                                                    className="px-5 py-3 font-semibold"
                                                >
                                                    {heading}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>

                                    <tbody className="divide-y divide-slate-100">
                                        {MODULES.map((module) => {
                                            const counts = getModuleCounts(module);

                                            return (
                                                <tr
                                                    key={module}
                                                    className="transition hover:bg-slate-50"
                                                >
                                                    <td className="px-5 py-4 font-semibold text-slate-800">
                                                        {module}
                                                    </td>
                                                    <td className="px-5 py-4">{counts.total}</td>
                                                    <td className="px-5 py-4">{counts.active}</td>
                                                    <td className="px-5 py-4">{counts.expiring}</td>
                                                    <td className="px-5 py-4">{counts.expired}</td>
                                                    <td className="px-5 py-4">{counts.unknown}</td>
                                                </tr>
                                            );
                                        })}

                                        <tr className="bg-slate-50 font-bold">
                                            <td className="px-5 py-4">TOTAL</td>
                                            <td className="px-5 py-4">{summaryCounts.total}</td>
                                            <td className="px-5 py-4">{summaryCounts.active}</td>
                                            <td className="px-5 py-4">{summaryCounts.expiring}</td>
                                            <td className="px-5 py-4">{summaryCounts.expired}</td>
                                            <td className="px-5 py-4">{summaryCounts.unknown}</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="min-w-[1050px] w-full text-left text-sm">
                                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                        <tr>
                                            <th className="px-5 py-3 font-semibold">S. No.</th>
                                            <th className="px-5 py-3 font-semibold">Product / Record</th>
                                            <th className="px-5 py-3 font-semibold">Module</th>
                                            <th className="px-5 py-3 font-semibold">Company / Vendor</th>
                                            <th className="px-5 py-3 font-semibold">Start Date</th>
                                            <th className="px-5 py-3 font-semibold">Expiry Date</th>
                                            <th className="px-5 py-3 font-semibold">Amount</th>
                                            <th className="px-5 py-3 font-semibold">Status</th>
                                        </tr>
                                    </thead>

                                    <tbody className="divide-y divide-slate-100">
                                        {loadingData ? (
                                            <tr>
                                                <td colSpan={8} className="px-5 py-12 text-center text-slate-500">
                                                    Loading records...
                                                </td>
                                            </tr>
                                        ) : filteredRecords.length === 0 ? (
                                            <tr>
                                                <td colSpan={8} className="px-5 py-12 text-center text-slate-500">
                                                    No records found for the selected report and filters.
                                                </td>
                                            </tr>
                                        ) : (
                                            visibleRecords.map((record, index) => (
                                                <tr
                                                    key={`${record.raw?._source}-${record.id}`}
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
                                                            {record.moduleLabel}
                                                        </span>
                                                    </td>
                                                    <td className="px-5 py-4 text-slate-600">
                                                        {record.companyName}
                                                    </td>
                                                    <td className="whitespace-nowrap px-5 py-4 text-slate-600">
                                                        {formatDate(record.startDate)}
                                                    </td>
                                                    <td className="whitespace-nowrap px-5 py-4 text-slate-700">
                                                        {formatDate(record.expiryDate)}
                                                    </td>
                                                    <td className="whitespace-nowrap px-5 py-4 text-slate-700">
                                                        {record.amount}
                                                    </td>
                                                    <td className="px-5 py-4">
                                                        <span
                                                            className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${record.status === "Active"
                                                                ? "bg-emerald-50 text-emerald-700"
                                                                : record.status === "Expiring Soon"
                                                                    ? "bg-amber-50 text-amber-700"
                                                                    : record.status === "Expired"
                                                                        ? "bg-red-50 text-red-700"
                                                                        : "bg-slate-100 text-slate-600"
                                                                }`}
                                                        >
                                                            {record.status}
                                                        </span>
                                                    </td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        {selectedReport !== "summary" &&
                            !loadingData &&
                            filteredRecords.length > 10 && (
                                <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-4">
                                    <p className="text-xs text-slate-500">
                                        Showing {visibleRecords.length} of {filteredRecords.length} report entries
                                    </p>

                                    <button
                                        type="button"
                                        onClick={() => setShowAll((previous) => !previous)}
                                        className="rounded-lg border border-blue-200 bg-white px-4 py-2 text-sm font-semibold text-blue-700 transition hover:bg-blue-50"
                                    >
                                        {showAll ? "Show Less" : "View All"}
                                    </button>
                                </div>
                            )}

                        <div className="border-t border-slate-100 px-5 py-3">
                            <p className="text-xs text-slate-500">
                                Machinery Service Due and AMC Expiry are shown as separate report entries. Amounts are shown only where the module has a corresponding cost field.
                            </p>
                        </div>

                        <div className="reports-print-area">
                            <h1 className="text-xl font-bold text-black">
                                AMIN INTERNATIONAL LIMITED
                            </h1>

                            <h2 className="mt-2 text-lg font-semibold text-black">
                                {reportTitle}
                            </h2>

                            <p className="mt-1 text-sm text-black">
                                {reportSubtitle}
                            </p>

                            <p className="mb-4 mt-1 text-xs text-black">
                                Generated: {new Date().toLocaleString("en-IN")}
                                {" | "}
                                Total matching records: {
                                    summaryCounts.total
                                }
                            </p>

                            {selectedReport === "summary" ? (
                                <table className="print-table">
                                    <thead>
                                        <tr>
                                            <th>Module</th>
                                            <th>Total Records</th>
                                            <th>Active</th>
                                            <th>Expiring Soon</th>
                                            <th>Expired</th>
                                            <th>Unknown</th>
                                        </tr>
                                    </thead>

                                    <tbody>
                                        {MODULES.map((module) => {
                                            const counts = getModuleCounts(module);

                                            return (
                                                <tr key={module}>
                                                    <td>{module}</td>
                                                    <td>{counts.total}</td>
                                                    <td>{counts.active}</td>
                                                    <td>{counts.expiring}</td>
                                                    <td>{counts.expired}</td>
                                                    <td>{counts.unknown}</td>
                                                </tr>
                                            );
                                        })}

                                        <tr>
                                            <th>TOTAL</th>
                                            <th>{summaryCounts.total}</th>
                                            <th>{summaryCounts.active}</th>
                                            <th>{summaryCounts.expiring}</th>
                                            <th>{summaryCounts.expired}</th>
                                            <th>{summaryCounts.unknown}</th>
                                        </tr>
                                    </tbody>
                                </table>
                            ) : (
                                <table className="print-table">
                                    <thead>
                                        <tr>
                                            <th>S. No.</th>
                                            <th>Product / Record</th>
                                            <th>Module</th>
                                            <th>Company / Vendor</th>
                                            <th>Start Date</th>
                                            <th>Expiry Date</th>
                                            <th>Amount</th>
                                            <th>Status</th>
                                        </tr>
                                    </thead>

                                    <tbody>
                                        {filteredRecords.map((record, index) => (
                                            <tr key={`${record.raw?._source}-${record.id}`}>
                                                <td>{index + 1}</td>
                                                <td>{record.productName}</td>
                                                <td>{record.moduleLabel}</td>
                                                <td>{record.companyName}</td>
                                                <td>{formatDate(record.startDate)}</td>
                                                <td>{formatDate(record.expiryDate)}</td>
                                                <td>{record.amount}</td>
                                                <td>{record.status}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>

                        <style jsx global>{`
                        .reports-print-area {
                            display: none;
                        }

                        @page {
                            size: landscape;
                            margin: 10mm;
                        }

                        @media print {
                            body * {
                                visibility: hidden !important;
                            }

                            .reports-print-area,
                            .reports-print-area * {
                                visibility: visible !important;
                            }

                            .reports-print-area {
                                display: block !important;
                                position: absolute;
                                top: 0;
                                left: 0;
                                width: 100%;
                                padding: 8px;
                                background: white;
                                color: black;
                            }

                            .print-table {
                                width: 100%;
                                border-collapse: collapse;
                                font-size: 10px;
                            }

                            .print-table th,
                            .print-table td {
                                border: 1px solid #999;
                                padding: 6px;
                                text-align: left;
                                overflow-wrap: anywhere;
                            }

                            .print-table thead {
                                display: table-header-group;
                            }

                            .print-table tr {
                                break-inside: avoid;
                            }
                        }
                    `}</style>
                    </section>
                )}
            </div>
        </main>
    );
}
