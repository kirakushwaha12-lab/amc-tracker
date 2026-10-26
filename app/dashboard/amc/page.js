
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
const SUPER_ADMIN_UID = "gm7L9ZxaqOUIm9qBP9Lf2sxDLh92";

function getDays(endDate) {
    if (!endDate) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const end = new Date(`${endDate}T00:00:00`);
    if (Number.isNaN(end.getTime())) return null;

    return Math.ceil((end.getTime() - today.getTime()) / 86400000);
}

function getStatus(endDate) {
    const days = getDays(endDate);

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

const initialForm = {
    productName: "",
    productId: "",
    startDate: "",
    endDate: "",
    vendor: "",
    cost: "",
    branchUnit: "",
    remarks: "",
};

export default function AMCPage() {
    const router = useRouter();

    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [showForm, setShowForm] = useState(false);
    const [saving, setSaving] = useState(false);
    const [formError, setFormError] = useState("");
    const [notice, setNotice] = useState("");
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

            if (!user) {
                setIsSuperAdmin(false);
                setCanEditRecords(false);
                setRecords([]);
                setLoading(false);
                router.replace("/");
                return;
            }

            setLoading(true);
            setError("");

            try {
                const isFixedSuperAdmin = user.uid === SUPER_ADMIN_UID;
                const userRef = doc(db, "users", user.uid);
                const userSnapshot = await getDoc(userRef);

                if (cancelled) return;

                const userData = userSnapshot.exists()
                    ? userSnapshot.data()
                    : {};

                const role = String(userData.role ?? "")
                    .trim()
                    .toLowerCase();

                const isActive =
                    userData.active === true || isFixedSuperAdmin;

                const superAdmin =
                    isFixedSuperAdmin ||
                    (isActive &&
                        (role === "super admin" || role === "superadmin"));

                const canEdit =
                    superAdmin ||
                    (isActive && ["admin", "editor"].includes(role));

                setIsSuperAdmin(superAdmin);
                setCanEditRecords(canEdit);

                // Do not subscribe to records if the account is inactive.
                if (!isActive) {
                    setRecords([]);
                    setError(
                        "Your account is inactive. Please contact the Super Admin."
                    );
                    setLoading(false);
                    return;
                }

                unsubscribeRecords = onSnapshot(
                    collection(db, "it_devices"),
                    (snapshot) => {
                        if (cancelled) return;

                        const allRecords = snapshot.docs.map((item) => ({
                            id: item.id,
                            ...item.data(),
                        }));

                        setRecords(
                            allRecords.filter(
                                (record) =>
                                    (record.category === "IT Devices" &&
                                        record.type === "AMC") ||
                                    (record.category === "AMC" && !record.type)
                            )
                        );

                        setError("");
                        setLoading(false);
                    },
                    (err) => {
                        console.error("AMC records read error:", err);

                        if (cancelled) return;

                        setError(
                            "AMC records could not be loaded. Check Firestore permissions."
                        );
                        setLoading(false);
                    }
                );
            } catch (err) {
                console.error("User role check error:", err);

                if (!cancelled) {
                    setIsSuperAdmin(false);
                    setCanEditRecords(false);
                    setRecords([]);
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
                const endDate = record.endDate ?? record.expiryDate ?? "";

                return {
                    ...record,
                    productName: record.productName ?? record.product ?? "",
                    productId: record.productId ?? "",
                    vendor: record.vendor ?? record.company ?? "",
                    startDate: record.startDate ?? "",
                    endDate,
                    cost: record.cost ?? record.charges ?? "",
                    branchUnit: record.branchUnit ?? "",
                    remarks: record.remarks ?? "",
                    status: getStatus(endDate),
                };
            }),
        [records]
    );

    const counts = useMemo(() => {
        const total = preparedRecords.length;
        const active = preparedRecords.filter(
            (record) => record.status === "Active"
        ).length;
        const expiring = preparedRecords.filter(
            (record) => record.status === "Expiring Soon"
        ).length;
        const expired = preparedRecords.filter(
            (record) => record.status === "Expired"
        ).length;

        return { total, active, expiring, expired };
    }, [preparedRecords]);

    const filteredRecords = useMemo(() => {
        const query = search.trim().toLowerCase();

        return preparedRecords.filter((record) => {
            const matchesSearch = [
                record.productName,
                record.productId,
                record.vendor,
                record.branchUnit,
                record.remarks,
            ].some((value) =>
                String(value ?? "").toLowerCase().includes(query)
            );

            const matchesStatus =
                statusFilter === "All" || record.status === statusFilter;

            const days = getDays(record.endDate);

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

    function openAddForm() {
        if (!canEditRecords) {
            setError("You do not have permission to add AMC records.");
            return;
        }

        setEditingId(null);
        setForm(initialForm);
        setFormError("");
        setNotice("");
        setError("");
        setShowForm(true);
    }

    function openEditForm(record) {
        if (!canEditRecords) {
            setError("You do not have permission to edit AMC records.");
            return;
        }

        setEditingId(record.id);
        setForm({
            productName: record.productName || "",
            productId: record.productId || "",
            startDate: record.startDate || "",
            endDate: record.endDate || "",
            vendor: record.vendor || "",
            cost: String(record.cost ?? ""),
            branchUnit: record.branchUnit || "",
            remarks: record.remarks || "",
        });
        setFormError("");
        setNotice("");
        setError("");
        setShowForm(true);
    }

    function updateForm(event) {
        const { name, value } = event.target;
        setForm((current) => ({ ...current, [name]: value }));
    }

    async function handleSubmit(event) {
        event.preventDefault();
        setFormError("");
        setNotice("");

        if (!canEditRecords) {
            setShowForm(false);
            setFormError("You do not have permission to add or edit AMC records.");
            return;
        }

        if (
            !form.productName.trim() ||
            !form.vendor.trim() ||
            !form.startDate ||
            !form.endDate
        ) {
            setFormError("Please fill in all required fields marked with *.");
            return;
        }

        if (form.endDate < form.startDate) {
            setFormError("Expiry Date cannot be before Start Date.");
            return;
        }

        if (
            form.cost === "" ||
            !Number.isFinite(Number(form.cost)) ||
            Number(form.cost) < 0
        ) {
            setFormError("Please enter a valid AMC charge.");
            return;
        }

        setSaving(true);

        const recordData = {
            category: "IT Devices",
            type: "AMC",
            productName: form.productName.trim(),
            productId: form.productId.trim(),
            startDate: form.startDate,
            endDate: form.endDate,
            vendor: form.vendor.trim(),
            cost: Number(form.cost),
            branchUnit: form.branchUnit.trim(),
            remarks: form.remarks.trim(),
            updatedAt: serverTimestamp(),
        };

        try {
            if (editingId) {
                await updateDoc(
                    doc(db, "it_devices", editingId),
                    recordData
                );
                setNotice("AMC record updated successfully.");
            } else {
                await addDoc(collection(db, "it_devices"), {
                    ...recordData,
                    createdAt: serverTimestamp(),
                });
                setNotice("AMC record saved successfully.");
            }

            setShowForm(false);
            setForm(initialForm);
            setEditingId(null);
            setFormError("");

            window.setTimeout(() => setNotice(""), 3500);
        } catch (err) {
            console.error("AMC record save/update error:", err);

            setFormError(
                err.code === "permission-denied"
                    ? "Permission denied. Please check Firestore security rules."
                    : editingId
                      ? "AMC record could not be updated. Please try again."
                      : "AMC record could not be saved. Please try again."
            );
        } finally {
            setSaving(false);
        }
    }

    async function handleDelete(record) {
        if (!isSuperAdmin) {
            setError("Only Super Admin can delete AMC records.");
            return;
        }

        const confirmed = window.confirm(
            `Are you sure you want to delete "${
                record.productName || "this AMC record"
            }"? This action cannot be undone.`
        );

        if (!confirmed) return;

        setDeletingId(record.id);
        setError("");
        setNotice("");

        try {
            await deleteDoc(doc(db, "it_devices", record.id));

            setNotice("AMC record deleted successfully.");
            window.setTimeout(() => setNotice(""), 3500);
        } catch (err) {
            console.error("AMC record delete error:", err);

            setError(
                err.code === "permission-denied"
                    ? "Permission denied. Check Firestore security rules."
                    : "AMC record could not be deleted. Please try again."
            );
        } finally {
            setDeletingId(null);
        }
    }

    return (
        <main className="min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8">
            <div className="mx-auto max-w-[1600px]">
                <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <h1 className="mt-1 text-3xl font-bold text-slate-900">
                            AMC Management
                        </h1>
                        <p className="mt-2 text-sm text-slate-500">
                            Track AMC validity, charges and expiry status by branch or unit.
                        </p>
                    </div>

                    {canEditRecords && (
                        <button
                            type="button"
                            onClick={openAddForm}
                            className="rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-90"
                            style={{ backgroundColor: BLUE }}
                        >
                            + Add AMC
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
                        title="Total AMC"
                        count={counts.total}
                        detail="All recorded AMC contracts"
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
                        detail="End date has passed"
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
                                Review contracts needing attention.
                            </p>
                        </div>
                        <span className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600">
                            Based on current date
                        </span>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        {[
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
                                    const days = getDays(record.endDate);
                                    return days !== null && days >= 0 && days <= 10;
                                }).length,
                                style: "border-amber-100 bg-amber-50 text-amber-700",
                            },
                            {
                                label: "Next 30 days",
                                count: preparedRecords.filter((record) => {
                                    const days = getDays(record.endDate);
                                    return days !== null && days >= 0 && days <= 30;
                                }).length,
                                style: "border-blue-100 bg-blue-50 text-blue-700",
                            },
                        ].map((item) => (
                            <div
                                key={item.label}
                                className={`rounded-xl border p-4 ${item.style}`}
                            >
                                <p className="text-sm font-medium">{item.label}</p>
                                <p className="mt-2 text-2xl font-bold">{item.count}</p>
                            </div>
                        ))}
                    </div>
                </section>

                <section className="mt-7 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <div className="border-b border-slate-100 p-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <h2 className="font-semibold text-slate-900">
                                    AMC Records
                                </h2>
                                <p className="mt-1 text-sm text-slate-500">
                                    {filteredRecords.length} of {preparedRecords.length} records
                                </p>
                            </div>
                        </div>

                        <div className="mt-4 grid gap-3 md:grid-cols-3">
                            <input
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder="Search product, product ID, vendor, branch..."
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
                            Loading AMC records...
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[1200px] text-left text-sm">
                                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                    <tr>
                                        {[
                                            "S. No.",
                                            "Product Name",
                                            "Product ID",
                                            "Start Date",
                                            "Expiry Date",
                                            "Vendor",
                                            "Cost",
                                            "Branch / Unit",
                                            "Remarks",
                                            "Status",
                                            "Actions",
                                        ].map((heading) => (
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
                                            <td className="px-4 py-4 font-medium text-slate-900">
                                                {record.productName || "—"}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4">
                                                {record.productId || "—"}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4">
                                                {formatDate(record.startDate)}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4">
                                                {formatDate(record.endDate)}
                                            </td>
                                            <td className="px-4 py-4">
                                                {record.vendor || "—"}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4">
                                                {money(record.cost)}
                                            </td>
                                            <td className="px-4 py-4">
                                                {record.branchUnit || "—"}
                                            </td>
                                            <td className="max-w-[260px] px-4 py-4 text-slate-600">
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
                                            <td colSpan={11} className="px-5 py-12 text-center">
                                                <p className="font-medium text-slate-700">
                                                    No AMC records found
                                                </p>
                                                <p className="mt-1 text-xs text-slate-500">
                                                    {preparedRecords.length === 0
                                                        ? "No AMC records have been added yet."
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
                    <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
                        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
                            <div>
                                <h2 className="text-lg font-bold text-slate-900">
                                    {editingId ? "Edit AMC Record" : "Add AMC Record"}
                                </h2>
                                <p className="mt-1 text-sm text-slate-500">
                                    Enter the required AMC details. Product ID, Branch and Remarks are optional.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowForm(false)}
                                disabled={saving}
                                className="rounded-lg px-3 py-2 text-xl text-slate-500 hover:bg-slate-100"
                            >
                                ×
                            </button>
                        </div>

                        <form onSubmit={handleSubmit} className="grid gap-4 p-6 sm:grid-cols-2">
                            <label className="text-sm font-medium text-slate-700">
                                Product Name *
                                <input
                                    required
                                    name="productName"
                                    value={form.productName}
                                    onChange={updateForm}
                                    placeholder="Enter product name"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Product ID
                                <input
                                    name="productId"
                                    value={form.productId}
                                    onChange={updateForm}
                                    placeholder="Enter product ID"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Vendor *
                                <input
                                    required
                                    name="vendor"
                                    value={form.vendor}
                                    onChange={updateForm}
                                    placeholder="Enter vendor name"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Start Date *
                                <input
                                    required
                                    type="date"
                                    name="startDate"
                                    value={form.startDate}
                                    onChange={updateForm}
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Expiry Date *
                                <input
                                    required
                                    type="date"
                                    min={form.startDate || undefined}
                                    name="endDate"
                                    value={form.endDate}
                                    onChange={updateForm}
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Charges (₹) *
                                <input
                                    required
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    name="cost"
                                    value={form.cost}
                                    onChange={updateForm}
                                    placeholder="Enter AMC charges"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Branch / Unit
                                <input
                                    name="branchUnit"
                                    value={form.branchUnit}
                                    onChange={updateForm}
                                    placeholder="Enter branch or unit"
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
                                          ? "Update AMC"
                                          : "Save AMC"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </main>
    );
}
