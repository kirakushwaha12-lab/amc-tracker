
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut } from "firebase/auth";
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

const BLUE = "#2563eb";
const SUPER_ADMIN_UID = "gm7L9ZxaqOUIm9qBP9Lf2sxDLh92";

const initialForm = {
    examinationType: "",
    unit: "",
    examinationDate: "",
    validTill: "",
};

function formatDate(value) {
    if (!value) return "—";

    const date = new Date(`${value}T00:00:00`);

    if (Number.isNaN(date.getTime())) return value;

    return date.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    });
}

function getStatus(record) {
    if (!record.validTill) return "Unknown";

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const expiry = new Date(`${record.validTill}T00:00:00`);

    if (Number.isNaN(expiry.getTime())) return "Unknown";

    const days = Math.ceil((expiry - today) / 86400000);

    if (days < 0) return "Expired";
    if (days <= 10) return "Expiring Soon";

    return "Active";
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

export default function CompliancePage() {
    const router = useRouter();

    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [userChecked, setUserChecked] = useState(false);
    const [error, setError] = useState("");
    const [formError, setFormError] = useState("");
    const [notice, setNotice] = useState("");
    const [showForm, setShowForm] = useState(false);
    const [saving, setSaving] = useState(false);
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
            setUserChecked(true);

            unsubscribeRecords?.();
            unsubscribeRecords = undefined;

            if (!user) {
                setRecords([]);
                setLoading(false);
                router.replace("/");
                return;
            }

            setLoading(true);
            setError("");

            try {
                const protectedSuperAdmin = user.uid === SUPER_ADMIN_UID;

                const userSnapshot = await getDoc(doc(db, "users", user.uid));
                const userData = userSnapshot.exists()
                    ? userSnapshot.data()
                    : {};

                if (cancelled) return;

                if (!protectedSuperAdmin && userData.active === false) {
                    setRecords([]);
                    setLoading(false);
                    setCanEditRecords(false);
                    setIsSuperAdmin(false);
                    await signOut(auth);

                    if (!cancelled) router.replace("/");
                    return;
                }

                const role = String(userData.role ?? "")
                    .trim()
                    .toLowerCase()
                    .replace(/[\s_-]+/g, "");

                const superAdmin =
                    protectedSuperAdmin || role === "superadmin";

                const canEdit =
                    superAdmin ||
                    role === "admin" ||
                    role === "editor";

                setIsSuperAdmin(superAdmin);
                setCanEditRecords(canEdit);

                unsubscribeRecords = onSnapshot(
                    collection(db, "compliance_records"),
                    (snapshot) => {
                        if (cancelled) return;

                        setRecords(
                            snapshot.docs.map((item) => {
                                const data = item.data();

                                return {
                                    id: item.id,
                                    ...data,
                                    examinationType:
                                        data.examinationType ??
                                        data.typeOfExamination ??
                                        data.name ??
                                        "",
                                    unit: data.unit ?? "",
                                    examinationDate:
                                        data.examinationDate ??
                                        data.lastExaminationDate ??
                                        "",
                                    validTill:
                                        data.validTill ??
                                        data.validTillDate ??
                                        data.expiryDate ??
                                        "",
                                };
                            })
                        );

                        setError("");
                        setLoading(false);
                    },
                    (err) => {
                        if (cancelled) return;

                        console.error("Compliance read error:", err);
                        setError(
                            "Compliance records could not be loaded. Please check Firestore permissions."
                        );
                        setLoading(false);
                    }
                );
            } catch (err) {
                if (cancelled) return;

                console.error("Compliance access check error:", err);
                setIsSuperAdmin(false);
                setCanEditRecords(false);
                setError(
                    "Your access could not be verified. Please refresh the page or check your account permissions."
                );
                setLoading(false);
            }
        });

        return () => {
            cancelled = true;
            unsubscribeAuth();
            unsubscribeRecords?.();
        };
    }, [router]);

    const counts = useMemo(
        () => ({
            total: records.length,
            active: records.filter((r) => getStatus(r) === "Active").length,
            expiring: records.filter((r) => getStatus(r) === "Expiring Soon").length,
            expired: records.filter((r) => getStatus(r) === "Expired").length,
        }),
        [records]
    );

    const expiryOverview = useMemo(() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let overdue = 0;
        let next10 = 0;
        let next30 = 0;

        records.forEach((record) => {
            if (!record.validTill) return;

            const expiry = new Date(`${record.validTill}T00:00:00`);
            if (Number.isNaN(expiry.getTime())) return;

            const days = Math.ceil((expiry - today) / 86400000);

            if (days < 0) overdue++;
            else if (days <= 10) next10++;
            else if (days <= 30) next30++;
        });

        return { overdue, next10, next30 };
    }, [records]);

    const filteredRecords = useMemo(() => {
        const term = search.trim().toLowerCase();

        return records.filter((record) => {
            const matchesSearch = [
                record.examinationType,
                record.unit,
                record.examinationDate,
                record.validTill,
            ].some((value) =>
                String(value || "").toLowerCase().includes(term)
            );

            const status = getStatus(record);
            const matchesStatus =
                statusFilter === "All" || status === statusFilter;

            let matchesPeriod = true;

            if (periodFilter !== "All") {
                if (!record.validTill) {
                    matchesPeriod = false;
                } else {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);

                    const expiry = new Date(`${record.validTill}T00:00:00`);

                    if (Number.isNaN(expiry.getTime())) {
                        matchesPeriod = false;
                    } else {
                        const days = Math.ceil((expiry - today) / 86400000);

                        matchesPeriod =
                            periodFilter === "Expired"
                                ? days < 0
                                : days >= 0 && days <= Number(periodFilter);
                    }
                }
            }

            return matchesSearch && matchesStatus && matchesPeriod;
        });
    }, [records, search, statusFilter, periodFilter]);

    function handleChange(event) {
        const { name, value } = event.target;
        setForm((current) => ({ ...current, [name]: value }));
    }

    function openAddForm() {
        if (!canEditRecords) {
            setError("You have view-only access to Compliance records.");
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
            setError("You do not have permission to edit Compliance records.");
            return;
        }

        setEditingId(record.id);
        setForm({
            examinationType: record.examinationType ?? "",
            unit: record.unit ?? "",
            examinationDate: record.examinationDate ?? "",
            validTill: record.validTill ?? "",
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
            setFormError("You do not have permission to add or edit records.");
            return;
        }

        if (!form.examinationType.trim()) {
            setFormError("Type of Examination is required.");
            return;
        }

        if (!form.validTill) {
            setFormError("Valid Till date is required.");
            return;
        }

        if (form.examinationDate && form.examinationDate > form.validTill) {
            setFormError("Examination Date cannot be after Valid Till.");
            return;
        }

        try {
            setSaving(true);

            const recordData = {
                category: "Compliance",
                type: "Compliance",
                examinationType: form.examinationType.trim(),
                unit: form.unit.trim(),
                examinationDate: form.examinationDate,
                validTill: form.validTill,
                updatedAt: serverTimestamp(),
            };

            if (editingId) {
                await updateDoc(
                    doc(db, "compliance_records", editingId),
                    recordData
                );
                setNotice("Compliance record updated successfully.");
            } else {
                await addDoc(collection(db, "compliance_records"), {
                    ...recordData,
                    createdAt: serverTimestamp(),
                });
                setNotice("Compliance record added successfully.");
            }

            setForm({ ...initialForm });
            setEditingId(null);
            setShowForm(false);
        } catch (err) {
            console.error("Compliance save error:", err);
            setFormError(
                err.code === "permission-denied"
                    ? "Permission denied. Please check Firestore security rules."
                    : "Record could not be saved. Please try again."
            );
        } finally {
            setSaving(false);
        }
    }

    async function handleDelete(record) {
        if (!isSuperAdmin) {
            setError("Only Super Admin can delete Compliance records.");
            return;
        }

        const confirmed = window.confirm(
            `Delete "${record.examinationType || "this record"}" for unit "${record.unit || "—"}"? This cannot be undone.`
        );

        if (!confirmed) return;

        setDeletingId(record.id);
        setError("");
        setNotice("");

        try {
            await deleteDoc(doc(db, "compliance_records", record.id));
            setNotice("Compliance record deleted successfully.");
        } catch (err) {
            console.error("Compliance delete error:", err);
            setError(
                err.code === "permission-denied"
                    ? "Permission denied. Check Firestore security rules."
                    : "Compliance record could not be deleted."
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
                            Compliance Management
                        </h1>
                        <p className="mt-2 text-sm text-slate-500">
                            Track examination records and validity dates.
                        </p>
                    </div>

                    {canEditRecords && (
                        <button
                            type="button"
                            onClick={openAddForm}
                            className="rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-90"
                            style={{ backgroundColor: BLUE }}
                        >
                            + Add Record
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
                        title="Total Records"
                        count={counts.total}
                        detail="All compliance entries"
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
                        detail="Expiry within 10 days"
                        color="bg-amber-500"
                    />
                    <SummaryCard
                        title="Expired"
                        count={counts.expired}
                        detail="Past their validity date"
                        color="bg-red-500"
                    />
                </div>

                <section className="mt-7 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <h2 className="text-lg font-bold text-slate-900">
                        Expiry Overview
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                        Upcoming and overdue compliance records
                    </p>

                    <div className="mt-5 grid gap-4 sm:grid-cols-3">
                        <div className="rounded-xl border border-red-100 bg-red-50 p-4">
                            <p className="text-sm font-medium text-red-700">
                                Overdue
                            </p>
                            <p className="mt-2 text-2xl font-bold text-red-800">
                                {expiryOverview.overdue}
                            </p>
                        </div>
                        <div className="rounded-xl border border-amber-100 bg-amber-50 p-4">
                            <p className="text-sm font-medium text-amber-700">
                                Next 10 Days
                            </p>
                            <p className="mt-2 text-2xl font-bold text-amber-800">
                                {expiryOverview.next10}
                            </p>
                        </div>
                        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
                            <p className="text-sm font-medium text-blue-700">
                                Next 30 Days
                            </p>
                            <p className="mt-2 text-2xl font-bold text-blue-800">
                                {expiryOverview.next30}
                            </p>
                        </div>
                    </div>
                </section>

                <section className="mt-7 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <div className="border-b border-slate-200 p-5">
                        <h2 className="text-lg font-bold text-slate-900">
                            Compliance Records
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            {filteredRecords.length} record(s) found
                        </p>
                    </div>

                    <div className="grid gap-3 p-5 md:grid-cols-3">
                        <input
                            type="text"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder="Search examination, unit or date..."
                            className="rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                        />

                        <select
                            value={periodFilter}
                            onChange={(event) => setPeriodFilter(event.target.value)}
                            className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-500"
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
                            className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                        >
                            <option value="All">All statuses</option>
                            <option value="Active">Active</option>
                            <option value="Expiring Soon">Expiring Soon</option>
                            <option value="Expired">Expired</option>
                            <option value="Unknown">Unknown</option>
                        </select>
                    </div>

                    {error ? (
                        <p className="m-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-800">
                            {error}
                        </p>
                    ) : loading || !userChecked ? (
                        <p className="p-10 text-center text-sm text-slate-500">
                            Loading compliance records...
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[1000px] text-left text-sm">
                                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                    <tr>
                                        {[
                                            "S. No.",
                                            "Type of Examination",
                                            "Unit",
                                            "Examination Date",
                                            "Valid Till",
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
                                    {filteredRecords.map((record, index) => {
                                        const status = getStatus(record);

                                        return (
                                            <tr
                                                key={record.id}
                                                className="transition hover:bg-slate-50"
                                            >
                                                <td className="whitespace-nowrap px-4 py-4 text-slate-600">
                                                    {index + 1}
                                                </td>
                                                <td className="px-4 py-4 font-medium text-slate-900">
                                                    {record.examinationType || "—"}
                                                </td>
                                                <td className="whitespace-nowrap px-4 py-4 text-slate-700">
                                                    {record.unit || "—"}
                                                </td>
                                                <td className="whitespace-nowrap px-4 py-4 text-slate-600">
                                                    {formatDate(record.examinationDate)}
                                                </td>
                                                <td className="whitespace-nowrap px-4 py-4 text-slate-600">
                                                    {formatDate(record.validTill)}
                                                </td>
                                                <td className="whitespace-nowrap px-4 py-4">
                                                    <StatusBadge status={status} />
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
                                                                className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
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
                                        );
                                    })}

                                    {filteredRecords.length === 0 && (
                                        <tr>
                                            <td
                                                colSpan={7}
                                                className="px-5 py-12 text-center"
                                            >
                                                <p className="font-medium text-slate-700">
                                                    No compliance records found
                                                </p>
                                                <p className="mt-1 text-xs text-slate-500">
                                                    {records.length === 0
                                                        ? canEditRecords
                                                            ? "Use Add Record to create the first entry."
                                                            : "No compliance entries are available."
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

                {showForm && canEditRecords && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 p-4">
                        <div className="my-auto w-full max-w-2xl rounded-2xl bg-white shadow-xl">
                            <div className="flex items-center justify-between border-b border-slate-200 p-5">
                                <div>
                                    <h2 className="text-xl font-bold text-slate-900">
                                        {editingId
                                            ? "Edit Record"
                                            : "Add Compliance Record"}
                                    </h2>
                                    <p className="mt-1 text-sm text-slate-500">
                                        Enter the examination and validity details.
                                    </p>
                                </div>

                                <button
                                    type="button"
                                    disabled={saving}
                                    onClick={() => {
                                        setShowForm(false);
                                        setFormError("");
                                    }}
                                    className="rounded-lg px-3 py-2 text-xl text-slate-500 hover:bg-slate-100 disabled:opacity-50"
                                >
                                    ×
                                </button>
                            </div>

                            <form onSubmit={handleSubmit}>
                                <div className="grid gap-4 p-6 sm:grid-cols-2">
                                    <div className="sm:col-span-2">
                                        <label className="mb-1.5 block text-sm font-medium text-slate-700">
                                            Type of Examination *
                                        </label>
                                        <input
                                            required
                                            name="examinationType"
                                            value={form.examinationType}
                                            onChange={handleChange}
                                            placeholder="e.g. Factory License, Fire NOC"
                                            className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                                        />
                                    </div>

                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-slate-700">
                                            Unit
                                        </label>
                                        <input
                                            name="unit"
                                            value={form.unit}
                                            onChange={handleChange}
                                            placeholder="e.g. E-42 or B-7"
                                            className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                                        />
                                    </div>

                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-slate-700">
                                            Examination Date
                                        </label>
                                        <input
                                            type="date"
                                            name="examinationDate"
                                            value={form.examinationDate}
                                            onChange={handleChange}
                                            className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                                        />
                                    </div>

                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-slate-700">
                                            Valid Till *
                                        </label>
                                        <input
                                            required
                                            type="date"
                                            name="validTill"
                                            value={form.validTill}
                                            onChange={handleChange}
                                            className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                                        />
                                    </div>

                                    {formError && (
                                        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 sm:col-span-2">
                                            {formError}
                                        </p>
                                    )}
                                </div>

                                <div className="flex flex-wrap justify-end gap-3 border-t border-slate-200 p-5">
                                    <button
                                        type="button"
                                        disabled={saving}
                                        onClick={() => {
                                            setShowForm(false);
                                            setFormError("");
                                        }}
                                        className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                                    >
                                        Cancel
                                    </button>

                                    <button
                                        type="submit"
                                        disabled={saving}
                                        className="rounded-xl px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
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
            </div>
        </main>
    );
}
