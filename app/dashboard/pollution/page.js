
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import {
    addDoc,
    collection,
    onSnapshot,
    serverTimestamp,
    doc,
    getDoc,
    updateDoc,
    deleteDoc,
} from "firebase/firestore";
import { auth, db } from "../../../lib/firebase";

const BLUE = "#0b4da2";
const COLLECTION_NAME = "vehicles";
const SUPER_ADMIN_UID = "gm7L9ZxaqOUIm9qBP9Lf2sxDLh92";

const initialForm = {
    vehicleNo: "",
    certificateNo: "",
    pucCode: "",
    fuelType: "",
    registrationDate: "",
    certificateDate: "",
    expiryDate: "",
    pucCentre: "",
    amount: "",
    remarks: "",
};

function getDays(dateValue) {
    if (!dateValue) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const date = new Date(`${dateValue}T00:00:00`);
    if (Number.isNaN(date.getTime())) return null;

    return Math.ceil((date.getTime() - today.getTime()) / 86400000);
}

function getStatus(dateValue) {
    const days = getDays(dateValue);

    if (days === null) return "Unknown";
    if (days < 0) return "Expired";
    if (days <= 10) return "Expiring Soon";

    return "Active";
}

function formatDate(value) {
    if (!value) return "—";

    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return "—";

    return date.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    });
}

function money(value) {
    if (value === "" || value === null || value === undefined) {
        return "—";
    }

    const amount = Number(value);
    if (!Number.isFinite(amount)) return "—";

    return amount.toLocaleString("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 2,
    });
}

function StatusBadge({ status }) {
    const styles = {
        Active: "bg-emerald-50 text-emerald-700",
        "Expiring Soon": "bg-amber-50 text-amber-700",
        Expired: "bg-red-50 text-red-700",
        Unknown: "bg-slate-100 text-slate-600",
    };

    return (
        <span
            className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${
                styles[status] || styles.Unknown
            }`}
        >
            {status}
        </span>
    );
}

function SummaryCard({ title, count, detail, color }) {
    return (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium text-slate-500">{title}</p>
                <span className={`h-2.5 w-2.5 rounded-full ${color}`} />
            </div>

            <p className="mt-3 text-3xl font-bold text-slate-900">{count}</p>
            <p className="mt-2 text-xs text-slate-500">{detail}</p>
        </div>
    );
}

export default function PollutionPage() {
    const router = useRouter();

    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");

    const [showForm, setShowForm] = useState(false);
    const [saving, setSaving] = useState(false);
    const [formError, setFormError] = useState("");
    const [form, setForm] = useState(initialForm);

    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("All");
    const [periodFilter, setPeriodFilter] = useState("All");

    const [editingId, setEditingId] = useState(null);
    const [isSuperAdmin, setIsSuperAdmin] = useState(false);
    const [canEditRecords, setCanEditRecords] = useState(false);
    const [deletingId, setDeletingId] = useState(null);

    useEffect(() => {
        let unsubscribeRecords;
        let cancelled = false;

        const unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
            unsubscribeRecords?.();
            unsubscribeRecords = undefined;

            setLoading(true);
            setError("");
            setIsSuperAdmin(false);
            setCanEditRecords(false);

            if (!user) {
                setLoading(false);
                router.replace("/");
                return;
            }

            try {
                const isProtectedSuperAdmin =
                    user.uid === SUPER_ADMIN_UID;

                const userSnapshot = await getDoc(
                    doc(db, "users", user.uid)
                );

                if (cancelled) return;

                const userData = userSnapshot.exists()
                    ? userSnapshot.data()
                    : {};

                const role = String(userData.role ?? "")
                    .trim()
                    .toLowerCase();

                const roleIsSuperAdmin =
                    role === "super admin" ||
                    role === "superadmin";

                // Keep the existing test Super Admin protected.
                const active =
                    isProtectedSuperAdmin || userData.active !== false;

                if (!active) {
                    setIsSuperAdmin(false);
                    setCanEditRecords(false);
                    setError(
                        "Your account is inactive. Please contact the Super Admin."
                    );
                    setLoading(false);
                    return;
                }

                const superAdmin =
                    isProtectedSuperAdmin || roleIsSuperAdmin;

                const editable =
                    superAdmin ||
                    role === "admin" ||
                    role === "editor";

                setIsSuperAdmin(superAdmin);
                setCanEditRecords(editable);

                unsubscribeRecords = onSnapshot(
                    collection(db, COLLECTION_NAME),
                    (snapshot) => {
                        if (cancelled) return;

                        const allRecords = snapshot.docs.map((item) => ({
                            id: item.id,
                            ...item.data(),
                        }));

                        setRecords(
                            allRecords.filter(
                                (record) =>
                                    record.category === "Vehicles" &&
                                    record.type === "Pollution"
                            )
                        );

                        setError("");
                        setLoading(false);
                    },
                    (err) => {
                        console.error(
                            "Pollution records read error:",
                            err
                        );

                        if (cancelled) return;

                        setError(
                            "Pollution records could not be loaded. Check Firestore permissions."
                        );
                        setLoading(false);
                    }
                );
            } catch (err) {
                console.error("User role check error:", err);

                if (!cancelled) {
                    setIsSuperAdmin(false);
                    setCanEditRecords(false);
                    setError("User role could not be verified.");
                    setLoading(false);
                }
            }
        });

        return () => {
            cancelled = true;
            unsubscribeAuth();
            unsubscribeRecords?.();
        };
    }, [router]);

    const preparedRecords = useMemo(
        () =>
            records.map((record) => {
                const expiryDate =
                    record.expiryDate ?? record.endDate ?? "";

                return {
                    ...record,
                    vehicleNo: record.vehicleNo ?? "",
                    certificateNo: record.certificateNo ?? "",
                    pucCode: record.pucCode ?? "",
                    fuelType: record.fuelType ?? "",
                    registrationDate: record.registrationDate ?? "",
                    certificateDate: record.certificateDate ?? "",
                    expiryDate,
                    pucCentre: record.pucCentre ?? "",
                    amount: record.amount ?? "",
                    remarks: record.remarks ?? "",
                    status: getStatus(expiryDate),
                };
            }),
        [records]
    );

    const counts = useMemo(
        () => ({
            total: preparedRecords.length,
            active: preparedRecords.filter(
                (record) => record.status === "Active"
            ).length,
            expiring: preparedRecords.filter(
                (record) => record.status === "Expiring Soon"
            ).length,
            expired: preparedRecords.filter(
                (record) => record.status === "Expired"
            ).length,
        }),
        [preparedRecords]
    );

    const filteredRecords = useMemo(() => {
        const query = search.trim().toLowerCase();

        return preparedRecords.filter((record) => {
            const matchesSearch = [
                record.vehicleNo,
                record.certificateNo,
                record.pucCode,
                record.fuelType,
                record.pucCentre,
                record.remarks,
            ].some((value) =>
                String(value ?? "").toLowerCase().includes(query)
            );

            const matchesStatus =
                statusFilter === "All" ||
                record.status === statusFilter;

            const days = getDays(record.expiryDate);

            const matchesPeriod =
                periodFilter === "All" ||
                (days !== null &&
                    (periodFilter === "Expired"
                        ? days < 0
                        : periodFilter === "10"
                          ? days >= 0 && days <= 10
                          : periodFilter === "30"
                            ? days >= 0 && days <= 30
                            : periodFilter === "90"
                              ? days >= 0 && days <= 90
                              : false));

            return matchesSearch && matchesStatus && matchesPeriod;
        });
    }, [preparedRecords, search, statusFilter, periodFilter]);

    function updateForm(event) {
        const { name, value } = event.target;

        setForm((current) => ({
            ...current,
            [name]: value,
        }));
    }

    function openAddForm() {
        if (!canEditRecords) {
            setError("You do not have permission to add Pollution records.");
            return;
        }

        setEditingId(null);
        setForm({ ...initialForm });
        setFormError("");
        setError("");
        setNotice("");
        setShowForm(true);
    }

    function openEditForm(record) {
        if (!canEditRecords) {
            setError("You do not have permission to edit Pollution records.");
            return;
        }

        setEditingId(record.id);

        setForm({
            vehicleNo: record.vehicleNo ?? "",
            certificateNo: record.certificateNo ?? "",
            pucCode: record.pucCode ?? "",
            fuelType: record.fuelType ?? "",
            registrationDate: record.registrationDate ?? "",
            certificateDate: record.certificateDate ?? "",
            expiryDate: record.expiryDate ?? "",
            pucCentre: record.pucCentre ?? "",
            amount: String(record.amount ?? ""),
            remarks: record.remarks ?? "",
        });

        setFormError("");
        setError("");
        setNotice("");
        setShowForm(true);
    }

    async function handleSubmit(event) {
        event.preventDefault();
        setFormError("");
        setNotice("");

        if (!canEditRecords) {
            setShowForm(false);
            setFormError("You do not have permission to save changes.");
            return;
        }

        if (
            !form.vehicleNo.trim() ||
            !form.certificateNo.trim() ||
            !form.certificateDate ||
            !form.expiryDate
        ) {
            setFormError(
                "Please enter Vehicle No., Certificate No., Certificate Date and Expiry Date."
            );
            return;
        }

        if (form.expiryDate < form.certificateDate) {
            setFormError(
                "Expiry Date cannot be before Certificate Date."
            );
            return;
        }

        if (
            form.amount !== "" &&
            (!Number.isFinite(Number(form.amount)) ||
                Number(form.amount) < 0)
        ) {
            setFormError("Please enter a valid amount.");
            return;
        }

        setSaving(true);

        const recordData = {
            category: "Vehicles",
            type: "Pollution",
            vehicleNo: form.vehicleNo.trim().toUpperCase(),
            certificateNo: form.certificateNo.trim(),
            pucCode: form.pucCode.trim(),
            fuelType: form.fuelType,
            registrationDate: form.registrationDate,
            certificateDate: form.certificateDate,
            expiryDate: form.expiryDate,
            pucCentre: form.pucCentre.trim(),
            amount: form.amount === "" ? "" : Number(form.amount),
            remarks: form.remarks.trim(),
            updatedAt: serverTimestamp(),
        };

        try {
            if (editingId) {
                await updateDoc(
                    doc(db, COLLECTION_NAME, editingId),
                    recordData
                );

                setNotice("Pollution record updated successfully.");
            } else {
                await addDoc(collection(db, COLLECTION_NAME), {
                    ...recordData,
                    createdAt: serverTimestamp(),
                });

                setNotice("Pollution record saved successfully.");
            }

            setShowForm(false);
            setForm({ ...initialForm });
            setEditingId(null);
            setFormError("");

            window.setTimeout(() => setNotice(""), 3500);
        } catch (err) {
            console.error("Pollution record save/update error:", err);

            setFormError(
                err.code === "permission-denied"
                    ? "Permission denied. Please check Firestore security rules."
                    : editingId
                      ? "Pollution record could not be updated. Please try again."
                      : "Pollution record could not be saved. Please try again."
            );
        } finally {
            setSaving(false);
        }
    }

    async function handleDelete(record) {
        if (!isSuperAdmin) {
            setError("Only Super Admin can delete Pollution records.");
            return;
        }

        const confirmed = window.confirm(
            `Are you sure you want to delete the Pollution record for "${
                record.vehicleNo || "this vehicle"
            }"? This action cannot be undone.`
        );

        if (!confirmed) return;

        setDeletingId(record.id);
        setError("");
        setNotice("");

        try {
            await deleteDoc(doc(db, COLLECTION_NAME, record.id));

            setNotice("Pollution record deleted successfully.");
            window.setTimeout(() => setNotice(""), 3500);
        } catch (err) {
            console.error("Pollution record delete error:", err);

            setError(
                err.code === "permission-denied"
                    ? "Permission denied. Check Firestore security rules."
                    : "Pollution record could not be deleted. Please try again."
            );
        } finally {
            setDeletingId(null);
        }
    }

    const expiryOverview = [
        {
            label: "Overdue",
            count: preparedRecords.filter(
                (record) => record.status === "Expired"
            ).length,
            style: "border-red-100 bg-red-50 text-red-700",
        },
        {
            label: "Next 10 days",
            count: preparedRecords.filter((record) => {
                const days = getDays(record.expiryDate);
                return days !== null && days >= 0 && days <= 10;
            }).length,
            style: "border-amber-100 bg-amber-50 text-amber-700",
        },
        {
            label: "Next 30 days",
            count: preparedRecords.filter((record) => {
                const days = getDays(record.expiryDate);
                return days !== null && days >= 0 && days <= 30;
            }).length,
            style: "border-blue-100 bg-blue-50 text-blue-700",
        },
    ];

    const headings = [
        "S. No.",
        "Vehicle No.",
        "Certificate No.",
        "PUC Code",
        "Fuel Type",
        "Registration Date",
        "Certificate Date",
        "Expiry Date",
        "PUC Centre",
        "Amount",
        "Remarks",
        "Status",
        "Actions",
    ];

    return (
        <main className="min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8">
            <div className="mx-auto max-w-[1600px]">
                <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <h1 className="text-3xl font-bold text-slate-900">
                            Pollution Certificate Management
                        </h1>
                        <p className="mt-2 text-sm text-slate-500">
                            Track vehicle PUC certificates, validity and expiry dates.
                        </p>
                    </div>

                    {canEditRecords && (
                        <button
                            type="button"
                            onClick={openAddForm}
                            className="rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-90"
                            style={{ backgroundColor: BLUE }}
                        >
                            + Add Pollution Record
                        </button>
                    )}
                </div>

                {notice && (
                    <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
                        {notice}
                        <button
                            type="button"
                            onClick={() => setNotice("")}
                            className="ml-3 font-bold"
                        >
                            ×
                        </button>
                    </div>
                )}

                <div className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <SummaryCard
                        title="Total Certificates"
                        count={counts.total}
                        detail="All recorded PUC certificates"
                        color="bg-blue-600"
                    />
                    <SummaryCard
                        title="Active"
                        count={counts.active}
                        detail="More than 10 days remaining"
                        color="bg-emerald-500"
                    />
                    <SummaryCard
                        title="Expiring Soon"
                        count={counts.expiring}
                        detail="Expiry within the next 10 days"
                        color="bg-amber-500"
                    />
                    <SummaryCard
                        title="Expired"
                        count={counts.expired}
                        detail="Expiry date has passed"
                        color="bg-red-500"
                    />
                </div>

                <section className="mt-7 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 className="font-semibold text-slate-900">
                                Expiry Overview
                            </h2>
                            <p className="mt-1 text-sm text-slate-500">
                                Review pollution certificates needing attention.
                            </p>
                        </div>

                        <span className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600">
                            Based on current date
                        </span>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        {expiryOverview.map((item) => (
                            <div
                                key={item.label}
                                className={`rounded-xl border p-4 ${item.style}`}
                            >
                                <p className="text-sm font-medium">
                                    {item.label}
                                </p>
                                <p className="mt-2 text-2xl font-bold">
                                    {item.count}
                                </p>
                            </div>
                        ))}
                    </div>
                </section>

                <section className="mt-7 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <div className="border-b border-slate-100 p-5">
                        <h2 className="font-semibold text-slate-900">
                            Pollution Records
                        </h2>

                        <p className="mt-1 text-sm text-slate-500">
                            {filteredRecords.length} of {preparedRecords.length} records
                        </p>

                        <div className="mt-4 grid gap-3 md:grid-cols-3">
                            <input
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder="Search vehicle, certificate, PUC centre..."
                                className="rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                            />

                            <select
                                value={periodFilter}
                                onChange={(event) => setPeriodFilter(event.target.value)}
                                className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm"
                            >
                                <option value="All">Any expiry period</option>
                                <option value="10">Within 10 days</option>
                                <option value="30">Within 30 days</option>
                                <option value="90">Within 90 days</option>
                                <option value="Expired">Already expired</option>
                            </select>

                            <select
                                value={statusFilter}
                                onChange={(event) => setStatusFilter(event.target.value)}
                                className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm"
                            >
                                <option value="All">All statuses</option>
                                <option value="Active">Active</option>
                                <option value="Expiring Soon">Expiring Soon</option>
                                <option value="Expired">Expired</option>
                                <option value="Unknown">Unknown</option>
                            </select>
                        </div>
                    </div>

                    {error ? (
                        <p className="m-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-800">
                            {error}
                        </p>
                    ) : loading ? (
                        <p className="p-10 text-center text-sm text-slate-500">
                            Loading Pollution records...
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[1600px] text-left text-sm">
                                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                    <tr>
                                        {headings.map((heading) => (
                                            <th
                                                key={heading}
                                                className="whitespace-nowrap px-4 py-3 font-semibold"
                                            >
                                                {heading}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>

                                <tbody className="divide-y divide-slate-100">
                                    {filteredRecords.map((record, index) => (
                                        <tr key={record.id} className="hover:bg-slate-50">
                                            <td className="whitespace-nowrap px-4 py-4">
                                                {index + 1}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4 font-semibold text-slate-900">
                                                {record.vehicleNo || "—"}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4">
                                                {record.certificateNo || "—"}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4">
                                                {record.pucCode || "—"}
                                            </td>
                                            <td className="px-4 py-4">
                                                {record.fuelType || "—"}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4">
                                                {formatDate(record.registrationDate)}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4">
                                                {formatDate(record.certificateDate)}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4">
                                                {formatDate(record.expiryDate)}
                                            </td>
                                            <td className="px-4 py-4">
                                                {record.pucCentre || "—"}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4">
                                                {money(record.amount)}
                                            </td>
                                            <td className="max-w-[220px] px-4 py-4 text-slate-600">
                                                {record.remarks || "—"}
                                            </td>
                                            <td className="px-4 py-4">
                                                <StatusBadge status={record.status} />
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4">
                                                <div className="flex items-center gap-2">
                                                    {canEditRecords && (
                                                        <button
                                                            type="button"
                                                            onClick={() => openEditForm(record)}
                                                            className="rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                                                        >
                                                            Edit
                                                        </button>
                                                    )}

                                                    {isSuperAdmin && (
                                                        <button
                                                            type="button"
                                                            disabled={deletingId === record.id}
                                                            onClick={() => handleDelete(record)}
                                                            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                                                        >
                                                            {deletingId === record.id
                                                                ? "Deleting..."
                                                                : "Delete"}
                                                        </button>
                                                    )}

                                                    {!canEditRecords && !isSuperAdmin && (
                                                        <span className="text-xs text-slate-400">
                                                            View only
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}

                                    {filteredRecords.length === 0 && (
                                        <tr>
                                            <td
                                                colSpan={headings.length}
                                                className="px-5 py-12 text-center"
                                            >
                                                <p className="font-medium text-slate-700">
                                                    No Pollution records found
                                                </p>
                                                <p className="mt-1 text-xs text-slate-500">
                                                    {preparedRecords.length === 0
                                                        ? "Use Add Pollution Record to create the first entry."
                                                        : "Try changing your search or filters."}
                                                </p>
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>
            </div>

            {showForm && canEditRecords && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
                    <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
                        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
                            <div>
                                <h2 className="text-lg font-bold text-slate-900">
                                    {editingId
                                        ? "Edit Pollution Record"
                                        : "Add Pollution Record"}
                                </h2>
                                <p className="mt-1 text-sm text-slate-500">
                                    Enter the vehicle and certificate details.
                                </p>
                            </div>

                            <button
                                type="button"
                                onClick={() => {
                                    setShowForm(false);
                                    setFormError("");
                                }}
                                disabled={saving}
                                className="rounded-lg px-3 py-2 text-xl text-slate-500 hover:bg-slate-100"
                            >
                                ×
                            </button>
                        </div>

                        <form
                            onSubmit={handleSubmit}
                            className="grid gap-4 p-6 sm:grid-cols-2"
                        >
                            <label className="text-sm font-medium text-slate-700">
                                Vehicle No. *
                                <input
                                    required
                                    name="vehicleNo"
                                    value={form.vehicleNo}
                                    onChange={updateForm}
                                    placeholder="e.g. UP35T8270"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Certificate No. *
                                <input
                                    required
                                    name="certificateNo"
                                    value={form.certificateNo}
                                    onChange={updateForm}
                                    placeholder="Enter certificate number"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                PUC Code
                                <input
                                    name="pucCode"
                                    value={form.pucCode}
                                    onChange={updateForm}
                                    placeholder="Enter PUC code"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Fuel Type
                                <select
                                    name="fuelType"
                                    value={form.fuelType}
                                    onChange={updateForm}
                                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-normal"
                                >
                                    <option value="">Select fuel type</option>
                                    <option value="Diesel">Diesel</option>
                                    <option value="Petrol">Petrol</option>
                                    <option value="CNG">CNG</option>
                                    <option value="LPG">LPG</option>
                                    <option value="Petrol/CNG">Petrol/CNG</option>
                                    <option value="Other">Other</option>
                                </select>
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Registration Date
                                <input
                                    type="date"
                                    name="registrationDate"
                                    value={form.registrationDate}
                                    onChange={updateForm}
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Certificate Date *
                                <input
                                    required
                                    type="date"
                                    name="certificateDate"
                                    value={form.certificateDate}
                                    onChange={updateForm}
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Expiry Date *
                                <input
                                    required
                                    type="date"
                                    min={form.certificateDate || undefined}
                                    name="expiryDate"
                                    value={form.expiryDate}
                                    onChange={updateForm}
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                PUC Centre
                                <input
                                    name="pucCentre"
                                    value={form.pucCentre}
                                    onChange={updateForm}
                                    placeholder="Enter PUC centre name"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Amount (₹)
                                <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    name="amount"
                                    value={form.amount}
                                    onChange={updateForm}
                                    placeholder="Enter amount (optional)"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700 sm:col-span-2">
                                Remarks
                                <textarea
                                    name="remarks"
                                    value={form.remarks}
                                    onChange={updateForm}
                                    rows={3}
                                    placeholder="Enter remarks (optional)"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            {formError && (
                                <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 sm:col-span-2">
                                    {formError}
                                </p>
                            )}

                            <div className="flex justify-end gap-3 border-t border-slate-100 pt-4 sm:col-span-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setShowForm(false);
                                        setFormError("");
                                    }}
                                    disabled={saving}
                                    className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
                                >
                                    Cancel
                                </button>

                                <button
                                    type="submit"
                                    disabled={saving}
                                    className="rounded-lg px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
                                    style={{ backgroundColor: BLUE }}
                                >
                                    {saving
                                        ? editingId
                                            ? "Updating..."
                                            : "Saving..."
                                        : editingId
                                          ? "Update Record"
                                          : "Save Record"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </main>
    );
}
