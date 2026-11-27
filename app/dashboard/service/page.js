
"use client";

import { auth, db } from "../../../lib/firebase";
import imageCompression from "browser-image-compression";
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
    deleteField,
} from "firebase/firestore";
import { renewRecord } from "../../lib/renewal-history";
import RenewalHistory from "../../components/RenewalHistory";
const BLUE = "#0b4da2";
const COLLECTION_NAME = "vehicles";
const MAX_DOCUMENT_SIZE = 500 * 1024;

const initialForm = {
    vehicleNo: "",
    vehicleName: "",
    serviceType: "",
    lastServiceDate: "",
    nextServiceDueDate: "",
    serviceCentre: "",
    serviceCharges: "",
    userName: "",
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
            className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${styles[status] || styles.Unknown
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

function normalizeVehicleNo(value) {
    return String(value || "")
        .trim()
        .replace(/\s+/g, "")
        .toUpperCase();
}

export default function ServicePage() {
    const router = useRouter();

    const [records, setRecords] = useState([]);
    const [todayKey, setTodayKey] = useState(
        () => new Date().toDateString()
    );
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");

    const [showForm, setShowForm] = useState(false);
    const [saving, setSaving] = useState(false);
    const [formError, setFormError] = useState("");
    const [form, setForm] = useState(initialForm);

    const [selectedDocument, setSelectedDocument] = useState(null);
    const [existingDocument, setExistingDocument] = useState(null);
    const [removeDocument, setRemoveDocument] = useState(false);

    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("All");
    const [periodFilter, setPeriodFilter] = useState("All");

    const [editingId, setEditingId] = useState(null);
    const [renewingId, setRenewingId] = useState(null);
    const [showRenewalHistory, setShowRenewalHistory] = useState(false);

    const [isSuperAdmin, setIsSuperAdmin] = useState(false);
    const [canEditRecords, setCanEditRecords] = useState(false);
    const [deletingId, setDeletingId] = useState(null);

    // Authentication and permissions
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
                const userSnapshot = await getDoc(
                    doc(db, "users", user.uid)
                );

                if (cancelled) return;

                const userData = userSnapshot.exists()
                    ? userSnapshot.data()
                    : {};

                const role = String(userData.role ?? "")
                    .trim()
                    .toLowerCase()
                    .replace(/[\s_-]+/g, "");

                const active = userData.active === true;

                if (!active) {
                    setError(
                        "Your account is inactive. Please contact the Super Admin."
                    );
                    setLoading(false);
                    return;
                }

                const superAdmin = role === "superadmin";
                const editable =
                    superAdmin ||
                    ["admin", "editor"].includes(role);

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

                        const serviceRecords = allRecords.filter(
                            (record) =>
                                record.category === "Vehicles" &&
                                record.type === "Service"
                        );

                        serviceRecords.sort((a, b) => {
                            const dateA =
                                a.nextServiceDueDate || "9999-12-31";
                            const dateB =
                                b.nextServiceDueDate || "9999-12-31";

                            return dateA.localeCompare(dateB);
                        });

                        setRecords(serviceRecords);
                        setError("");
                        setLoading(false);
                    },
                    (err) => {
                        console.error("Service records read error:", err);

                        if (cancelled) return;

                        setError(
                            "Service records could not be loaded. Check Firestore permissions."
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
    // REFRESH DATE CALCULATIONS AT MIDNIGHT
    useEffect(() => {
        const now = new Date();
        const nextMidnight = new Date(now);

        nextMidnight.setHours(24, 0, 1, 0);

        const timer = window.setTimeout(() => {
            setTodayKey(new Date().toDateString());
        }, nextMidnight.getTime() - now.getTime());

        return () => window.clearTimeout(timer);
    }, [todayKey]);
    const preparedRecords = useMemo(
        () =>
            records.map((record) => ({
                ...record,
                vehicleNo: record.vehicleNo ?? "",
                vehicleName: record.vehicleName ?? "",
                serviceType: record.serviceType ?? "",
                lastServiceDate: record.lastServiceDate ?? "",
                nextServiceDueDate: record.nextServiceDueDate ?? "",
                serviceCentre: record.serviceCentre ?? "",
                serviceCharges: record.serviceCharges ?? "",
                userName: record.userName ?? "",
                remarks: record.remarks ?? "",
                status: getStatus(record.nextServiceDueDate),
            })),
        [records, todayKey]
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
                record.vehicleName,
                record.serviceType,
                record.serviceCentre,
                record.userName,
                record.remarks,
            ].some((value) =>
                String(value ?? "").toLowerCase().includes(query)
            );

            const matchesStatus =
                statusFilter === "All" ||
                record.status === statusFilter;

            const days = getDays(record.nextServiceDueDate);

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

    async function compressImageIfNeeded(file) {
        const isImage = ["image/jpeg", "image/png"].includes(file.type);

        if (!isImage || file.size <= 100 * 1024) {
            return file;
        }

        try {
            const compressedFile = await imageCompression(file, {
                maxSizeMB: 0.2,
                maxWidthOrHeight: 1600,
                useWebWorker: true,
                fileType: file.type,
            });

            return compressedFile.size < file.size
                ? new File([compressedFile], file.name, {
                    type: compressedFile.type,
                    lastModified: Date.now(),
                })
                : file;
        } catch (error) {
            console.error("Photo compression failed:", error);
            throw new Error(
                "Photo compression failed. Please try again."
            );
        }
    }

    async function handleDocumentChange(event) {
        const input = event.target;
        const file = input.files?.[0];

        setFormError("");

        if (!file) return;

        const allowed = ["pdf", "jpg", "jpeg", "png", "doc", "docx"];
        const extension = file.name.split(".").pop()?.toLowerCase();

        if (!allowed.includes(extension)) {
            setFormError(
                "Only PDF, JPG, JPEG, PNG, DOC and DOCX files are allowed."
            );
            input.value = "";
            return;
        }

        try {
            let finalFile = file;

            if (["jpg", "jpeg", "png"].includes(extension)) {
                finalFile = await compressImageIfNeeded(file);
            }

            if (finalFile.size > MAX_DOCUMENT_SIZE) {
                throw new Error("Document size must not exceed 500 KB.");
            }

            setSelectedDocument(finalFile);
            setRemoveDocument(false);
        } catch (error) {
            setFormError(error.message);
            setSelectedDocument(null);
        } finally {
            input.value = "";
        }
    }

    function readDocumentAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();

            reader.onload = () => resolve(reader.result);
            reader.onerror = () =>
                reject(new Error("Could not read the selected document."));

            reader.readAsDataURL(file);
        });
    }

    function updateForm(event) {
        const { name, value } = event.target;

        setForm((current) => ({
            ...current,
            [name]: value,
        }));
    }

    function openAddForm() {
        if (!canEditRecords) {
            setError("You do not have permission to add Service records.");
            return;
        }

        setEditingId(null);
        setRenewingId(null);
        setForm({ ...initialForm });
        setSelectedDocument(null);
        setExistingDocument(null);
        setRemoveDocument(false);
        setFormError("");
        setError("");
        setNotice("");
        setShowForm(true);
    }

    function openEditForm(record) {
        if (!canEditRecords) {
            setError("You do not have permission to edit Service records.");
            return;
        }

        setEditingId(record.id);
        setRenewingId(null);

        setForm({
            vehicleNo: record.vehicleNo ?? "",
            vehicleName: record.vehicleName ?? "",
            serviceType: record.serviceType ?? "",
            lastServiceDate: record.lastServiceDate ?? "",
            nextServiceDueDate: record.nextServiceDueDate ?? "",
            serviceCentre: record.serviceCentre ?? "",
            serviceCharges: String(record.serviceCharges ?? ""),
            userName: record.userName ?? "",
            remarks: record.remarks ?? "",
        });

        setSelectedDocument(null);
        setRemoveDocument(false);

        setExistingDocument(
            record.documentData
                ? {
                    name: record.documentName || "Saved document",
                    data: record.documentData,
                    size: record.documentSize || 0,
                    type: record.documentType || "",
                }
                : null
        );

        setFormError("");
        setError("");
        setNotice("");
        setShowForm(true);
    }
    function openRenewForm(record) {
        if (!canEditRecords) {
            setError("You do not have permission to renew Service records.");
            return;
        }

        setEditingId(null);
        setRenewingId(record.id);

        setForm({
            vehicleNo: record.vehicleNo ?? "",
            vehicleName: record.vehicleName ?? "",
            serviceType: record.serviceType ?? "",
            lastServiceDate: "",
            nextServiceDueDate: "",
            serviceCentre: record.serviceCentre ?? "",
            serviceCharges: String(record.serviceCharges ?? ""),
            userName: record.userName ?? "",
            remarks: record.remarks ?? "",
        });

        setSelectedDocument(null);
        setRemoveDocument(false);

        setExistingDocument(
            record.documentData
                ? {
                    name: record.documentName || "Saved document",
                    data: record.documentData,
                    size: record.documentSize || 0,
                    type: record.documentType || "",
                }
                : null
        );

        setFormError("");
        setError("");
        setNotice("");
        setShowForm(true);
    }
    function closeForm() {
        if (saving) return;

        setShowForm(false);
        setFormError("");
        setEditingId(null);
        setRenewingId(null);
        setForm({ ...initialForm });
        setSelectedDocument(null);
        setExistingDocument(null);
        setRemoveDocument(false);
    }

    async function handleSubmit(event) {
        event.preventDefault();
        setFormError("");
        setNotice("");

        if (!canEditRecords) {
            setFormError("You do not have permission to save changes.");
            return;
        }

        if (!form.vehicleNo.trim()) {
            setFormError("Please enter Vehicle No.");
            return;
        }

        if (
            form.lastServiceDate &&
            form.nextServiceDueDate &&
            form.nextServiceDueDate < form.lastServiceDate
        ) {
            setFormError(
                "Next Due Date cannot be before Last Service Date."
            );
            return;
        }

        if (
            form.serviceCharges !== "" &&
            (!Number.isFinite(Number(form.serviceCharges)) ||
                Number(form.serviceCharges) < 0)
        ) {
            setFormError("Please enter valid Service Charges.");
            return;
        }

        const normalizedVehicleNo = normalizeVehicleNo(form.vehicleNo);

        const duplicateRecord = records.find(
            (record) =>
                normalizeVehicleNo(record.vehicleNo) === normalizedVehicleNo &&
                record.id !== (editingId || renewingId)
        );

        if (duplicateRecord && editingId) {
            setFormError(
                "Another Service record already exists for this vehicle number."
            );
            return;
        }

        setSaving(true);

        try {
            const targetRecord = editingId
                ? records.find((record) => record.id === editingId)
                : duplicateRecord || null;

            let documentFields = {};

            if (selectedDocument) {
                const documentData = await readDocumentAsDataUrl(
                    selectedDocument
                );

                documentFields = {
                    documentData,
                    documentName: selectedDocument.name,
                    documentSize: selectedDocument.size,
                    documentType: selectedDocument.type,
                };
            } else if (existingDocument && !removeDocument) {
                documentFields = {
                    documentData: existingDocument.data,
                    documentName: existingDocument.name,
                    documentSize: existingDocument.size,
                    documentType: existingDocument.type,
                };
            }

            const recordData = {
                category: "Vehicles",
                type: "Service",
                vehicleNo: form.vehicleNo.trim().toUpperCase(),
                vehicleName: form.vehicleName.trim(),
                serviceType: form.serviceType.trim(),
                lastServiceDate: form.lastServiceDate,
                nextServiceDueDate: form.nextServiceDueDate,
                serviceCentre: form.serviceCentre.trim(),
                serviceCharges:
                    form.serviceCharges === ""
                        ? ""
                        : Number(form.serviceCharges),
                userName: form.userName.trim(),
                remarks: form.remarks.trim(),
                ...documentFields,
                updatedAt: serverTimestamp(),
            };

            if (removeDocument && !selectedDocument) {
                recordData.documentData = deleteField();
                recordData.documentName = deleteField();
                recordData.documentSize = deleteField();
                recordData.documentType = deleteField();
            }

            if (renewingId) {
                await renewRecord({
                    collectionName: COLLECTION_NAME,
                    recordId: renewingId,
                    moduleName: "Service",
                    renewalData: recordData,
                    actor: {
                        uid: auth.currentUser?.uid || "",
                        email: auth.currentUser?.email || "",
                    },
                });

                setNotice("Service record renewed successfully. Previous details saved in Renewal History.");
            } else if (targetRecord) {
                await updateDoc(
                    doc(db, COLLECTION_NAME, targetRecord.id),
                    recordData
                );

                setNotice(
                    editingId
                        ? "Service record updated successfully."
                        : "Existing vehicle record updated successfully."
                );
            } else {
                await addDoc(collection(db, COLLECTION_NAME), {
                    ...recordData,
                    createdAt: serverTimestamp(),
                });

                setNotice("Service record saved successfully.");
            }

            setShowForm(false);
            setForm({ ...initialForm });
            setEditingId(null);
            setRenewingId(null);
            setSelectedDocument(null);
            setExistingDocument(null);
            setRemoveDocument(false);
            setFormError("");

            window.setTimeout(() => setNotice(""), 3500);
        } catch (err) {
            console.error("Service record save/update error:", err);

            setFormError(
                err.code === "permission-denied"
                    ? "Permission denied. Please check Firestore security rules."
                    : "Service record could not be saved. Please try again."
            );
        } finally {
            setSaving(false);
        }
    }

    async function handleDelete(record) {
        if (!isSuperAdmin) {
            setError("Only Super Admin can delete Service records.");
            return;
        }

        const confirmed = window.confirm(
            `Are you sure you want to delete the Service record for "${record.vehicleNo || "this vehicle"}"? This action cannot be undone.`
        );

        if (!confirmed) return;

        setDeletingId(record.id);
        setError("");
        setNotice("");

        try {
            await deleteDoc(doc(db, COLLECTION_NAME, record.id));

            setNotice("Service record deleted successfully.");
            window.setTimeout(() => setNotice(""), 3500);
        } catch (err) {
            console.error("Service record delete error:", err);

            setError(
                err.code === "permission-denied"
                    ? "Permission denied. Check Firestore security rules."
                    : "Service record could not be deleted. Please try again."
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
                const days = getDays(record.nextServiceDueDate);
                return days !== null && days >= 0 && days <= 10;
            }).length,
            style: "border-amber-100 bg-amber-50 text-amber-700",
        },
        {
            label: "Next 30 days",
            count: preparedRecords.filter((record) => {
                const days = getDays(record.nextServiceDueDate);
                return days !== null && days >= 0 && days <= 30;
            }).length,
            style: "border-blue-100 bg-blue-50 text-blue-700",
        },
    ];

    const headings = [
        "S. No.",
        "Vehicle No.",
        "Vehicle Name",
        "Service Type",
        "Last Service Date",
        "Next Due Date",
        "Service Centre",
        "Service Charges",
        "User Name",
        "Remarks",
        "Status",
        "Actions",
    ];

    if (loading) {
        return (
            <main className="min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8">
                <div className="mx-auto max-w-[1600px]">
                    <p className="py-10 text-center text-sm text-slate-500">
                        Loading Service records...
                    </p>
                </div>
            </main>
        );
    }

    return (
        <main className="min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8">
            <div className="mx-auto max-w-[1600px]">
                <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <h1 className="text-3xl font-bold text-slate-900">
                            Service Management
                        </h1>
                        <p className="mt-2 text-sm text-slate-500">
                            Track vehicle servicing and upcoming due dates.
                        </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        {canEditRecords && (
                            <button
                                type="button"
                                onClick={openAddForm}
                                className="rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-90"
                                style={{ backgroundColor: BLUE }}
                            >
                                + Add Service Record
                            </button>
                        )}

                        <button
                            type="button"
                            onClick={() => setShowRenewalHistory(true)}
                            className="rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-90"
                            style={{ backgroundColor: BLUE }}
                        >
                            Renewal History
                        </button>
                    </div>
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

                {error && (
                    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                        {error}
                    </div>
                )}

                <div className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <SummaryCard
                        title="Total Vehicles"
                        count={counts.total}
                        detail="All recorded vehicle service records"
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
                        detail="Due within the next 10 days"
                        color="bg-amber-500"
                    />
                    <SummaryCard
                        title="Overdue"
                        count={counts.expired}
                        detail="Next service due date has passed"
                        color="bg-red-500"
                    />
                </div>

                <section className="mt-7 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 className="font-semibold text-slate-900">
                                Service Due Overview
                            </h2>
                            <p className="mt-1 text-sm text-slate-500">
                                Review vehicles needing service attention.
                            </p>
                        </div>

                        <span className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600">
                            Based on Current Date
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
                            Service Records
                        </h2>

                        <p className="mt-1 text-sm text-slate-500">
                            {filteredRecords.length} of {preparedRecords.length} records
                        </p>

                        <div className="mt-4 grid gap-3 md:grid-cols-3">
                            <input
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder="Search vehicle, service type, service centre..."
                                className="rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                            />

                            <select
                                value={periodFilter}
                                onChange={(event) => setPeriodFilter(event.target.value)}
                                className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm"
                            >
                                <option value="All">Any due period</option>
                                <option value="10">Within 10 days</option>
                                <option value="30">Within 30 days</option>
                                <option value="90">Within 90 days</option>
                                <option value="Expired">Already overdue</option>
                            </select>

                            <select
                                value={statusFilter}
                                onChange={(event) => setStatusFilter(event.target.value)}
                                className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm"
                            >
                                <option value="All">All statuses</option>
                                <option value="Active">Active</option>
                                <option value="Expiring Soon">Expiring Soon</option>
                                <option value="Expired">Overdue</option>
                                <option value="Unknown">Unknown</option>
                            </select>
                        </div>
                    </div>

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
                                    <tr
                                        key={record.id}
                                        className="hover:bg-slate-50"
                                    >
                                        <td className="whitespace-nowrap px-4 py-4">
                                            {index + 1}
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-4 font-semibold text-slate-900">
                                            {record.vehicleNo || "—"}
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-4">
                                            {record.vehicleName || "—"}
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-4">
                                            {record.serviceType || "—"}
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-4">
                                            {formatDate(record.lastServiceDate)}
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-4">
                                            {formatDate(record.nextServiceDueDate)}
                                        </td>
                                        <td className="px-4 py-4">
                                            {record.serviceCentre || "—"}
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-4">
                                            {money(record.serviceCharges)}
                                        </td>
                                        <td className="px-4 py-4">
                                            {record.userName || "—"}
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
                                                {canEditRecords && (
                                                    <button
                                                        type="button"
                                                        onClick={() => openRenewForm(record)}
                                                        className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
                                                        style={{ backgroundColor: BLUE }}
                                                    >
                                                        Renew
                                                    </button>
                                                )}
                                                {record.documentData && (
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            const newTab = window.open(
                                                                "",
                                                                "_blank"
                                                            );

                                                            if (!newTab) {
                                                                alert("Please allow pop-ups for this application.");
                                                                return;
                                                            }

                                                            newTab.location.href =
                                                                record.documentData;
                                                        }}
                                                        className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                                                    >
                                                        View Doc
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
                                                No Service records found
                                            </p>
                                            <p className="mt-1 text-xs text-slate-500">
                                                {preparedRecords.length === 0
                                                    ? "Use Add Service Record to create the first entry."
                                                    : "Try changing your search or filters."}
                                            </p>
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </section>
            </div>

            {/* Add / Edit Service Form */}
            {showForm && canEditRecords && (
                <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/50 p-4">
                    <div className="my-auto max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
                        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
                            <div>
                                <h2 className="text-lg font-bold text-slate-900">
                                    {renewingId
                                        ? "Renew Service Record"
                                        : editingId
                                            ? "Edit Service Record"
                                            : "Add Service Record"}
                                </h2>
                                <p className="mt-1 text-sm text-slate-500">
                                    Enter vehicle and service details.
                                </p>
                            </div>

                            <button
                                type="button"
                                onClick={closeForm}
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
                                    disabled={Boolean(editingId || renewingId)}
                                    placeholder="e.g. UP 78 FE 1777"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal disabled:bg-slate-100"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Vehicle Name / Model
                                <input
                                    name="vehicleName"
                                    value={form.vehicleName}
                                    onChange={updateForm}
                                    placeholder="Enter vehicle name or model"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Service Type
                                <input
                                    name="serviceType"
                                    value={form.serviceType}
                                    onChange={updateForm}
                                    placeholder="e.g. General / Repair / Oil Change"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Last Service Date
                                <input

                                    type="date"
                                    name="lastServiceDate"
                                    value={form.lastServiceDate}
                                    onChange={updateForm}
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Next Due Date
                                <input

                                    type="date"
                                    min={form.lastServiceDate || undefined}
                                    name="nextServiceDueDate"
                                    value={form.nextServiceDueDate}
                                    onChange={updateForm}
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Service Centre / Vendor
                                <input
                                    name="serviceCentre"
                                    value={form.serviceCentre}
                                    onChange={updateForm}
                                    placeholder="Enter service centre or vendor"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Service Charges (₹)
                                <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    name="serviceCharges"
                                    value={form.serviceCharges}
                                    onChange={updateForm}
                                    placeholder="Enter service charges"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                User Name
                                <input
                                    name="userName"
                                    value={form.userName}
                                    onChange={updateForm}
                                    placeholder="Enter user name"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4 sm:col-span-2">
                                <label className="block text-sm font-semibold text-slate-800">
                                    Service Document
                                    <span className="ml-2 font-normal text-slate-500">
                                        (Optional)
                                    </span>
                                </label>

                                <p className="mt-1 text-xs text-slate-500">
                                    PDF, JPG, PNG, DOC or DOCX · Maximum 500 KB
                                </p>

                                {existingDocument && !removeDocument && (
                                    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white p-3">
                                        <span className="min-w-0 flex-1 break-all text-sm text-slate-700">
                                            {selectedDocument
                                                ? selectedDocument.name
                                                : existingDocument.name}
                                        </span>

                                        {!selectedDocument && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    const newTab = window.open(
                                                        "",
                                                        "_blank"
                                                    );

                                                    if (!newTab) {
                                                        alert("Please allow pop-ups for this application.");
                                                        return;
                                                    }

                                                    newTab.location.href =
                                                        existingDocument.data;
                                                }}
                                                className="rounded-lg border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                                            >
                                                View
                                            </button>
                                        )}

                                        <label
                                            className="inline-flex cursor-pointer items-center rounded-lg px-3 py-2 text-xs font-semibold text-white transition hover:opacity-90"
                                            style={{ backgroundColor: BLUE }}
                                        >
                                            Replace
                                            <input
                                                type="file"
                                                accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                                                onChange={handleDocumentChange}
                                                className="sr-only"
                                            />
                                        </label>

                                        <button
                                            type="button"
                                            onClick={() => {
                                                setExistingDocument(null);
                                                setSelectedDocument(null);
                                                setRemoveDocument(true);
                                            }}
                                            className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50"
                                        >
                                            Remove
                                        </button>
                                    </div>
                                )}

                                {(!existingDocument || removeDocument) && (
                                    <label className="mt-3 flex w-full cursor-pointer items-center gap-3 rounded-lg border border-blue-200 bg-white p-3 transition hover:border-blue-400 hover:bg-blue-50">
                                        <span
                                            className="inline-flex shrink-0 items-center rounded-lg px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
                                            style={{ backgroundColor: BLUE }}
                                        >
                                            Choose Document
                                        </span>

                                        <span className="min-w-0 flex-1 break-all text-sm text-slate-500">
                                            {selectedDocument
                                                ? selectedDocument.name
                                                : "No file chosen"}
                                        </span>

                                        <input
                                            type="file"
                                            accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                                            onChange={handleDocumentChange}
                                            className="sr-only"
                                        />
                                    </label>
                                )}

                                {selectedDocument && (
                                    <p className="mt-2 break-all text-xs text-emerald-700">
                                        Selected: {selectedDocument.name} (
                                        {(selectedDocument.size / 1024).toFixed(1)} KB)
                                    </p>
                                )}
                            </div>

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
                                    onClick={closeForm}
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
                                        ? renewingId
                                            ? "Renewing..."
                                            : editingId
                                                ? "Updating..."
                                                : "Saving..."
                                        : renewingId
                                            ? "Renew Record"
                                            : editingId
                                                ? "Update Record"
                                                : "Save Record"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
            {showRenewalHistory && (
                <RenewalHistory
                    moduleName="Service"
                    onClose={() => setShowRenewalHistory(false)}
                />
            )}
        </main>
    );
}
