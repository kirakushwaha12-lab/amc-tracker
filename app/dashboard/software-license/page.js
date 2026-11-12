
"use client";

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
import { auth, db } from "../../../lib/firebase";

const BLUE = "#0b4da2";
const SUPER_ADMIN_UID = "gm7L9ZxaqOUIm9qBP9Lf2sxDLh92";
const COLLECTION_NAME = "it_devices";
const MAX_DOCUMENT_SIZE = 500 * 1024;

const ALLOWED_DOCUMENT_EXTENSIONS = [
    "pdf",
    "jpg",
    "jpeg",
    "png",
    "doc",
    "docx",
];

const initialForm = {
    licenseName: "",
    licenseId: "",
    vendor: "",
    startDate: "",
    expiryDate: "",
    cost: "",
    branchUnit: "",
    remarks: "",
};

function getDays(expiryDate) {
    if (!expiryDate) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const expiry = new Date(`${expiryDate}T00:00:00`);

    if (Number.isNaN(expiry.getTime())) return null;

    return Math.ceil((expiry.getTime() - today.getTime()) / 86400000);
}

function getStatus(expiryDate) {
    const days = getDays(expiryDate);

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
                <p className="text-sm font-medium text-slate-500">
                    {title}
                </p>
                <span className={`h-2.5 w-2.5 rounded-full ${color}`} />
            </div>

            <p className="mt-3 text-3xl font-bold text-slate-900">
                {count}
            </p>

            <p className="mt-2 text-xs text-slate-500">
                {detail}
            </p>
        </div>
    );
}

function getDocumentExtension(fileName = "") {
    return fileName.split(".").pop()?.toLowerCase() || "";
}

async function compressImageIfNeeded(file) {
    const extension = getDocumentExtension(file.name);
    const isImage = ["jpg", "jpeg", "png"].includes(extension);

    if (!isImage || file.size <= 100 * 1024) {
        return file;
    }

    const compressedFile = await imageCompression(file, {
        maxSizeMB: 0.2,
        maxWidthOrHeight: 1600,
        useWebWorker: true,
        fileType: file.type || undefined,
    });

    if (compressedFile.size >= file.size) {
        return file;
    }

    return new File([compressedFile], file.name, {
        type: compressedFile.type || file.type,
        lastModified: Date.now(),
    });
}

function readDocumentAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
            if (typeof reader.result === "string") {
                resolve(reader.result);
            } else {
                reject(new Error("Document could not be read."));
            }
        };

        reader.onerror = () => {
            reject(new Error("Document could not be read."));
        };

        reader.readAsDataURL(file);
    });
}

async function openSavedDocument(dataUrl) {
    if (!dataUrl) return;

    let documentWindow = null;
    let objectUrl = null;

    try {
        documentWindow = window.open("about:blank", "_blank");

        if (!documentWindow) {
            alert("Please allow pop-ups to view the document.");
            return;
        }

        const response = await fetch(dataUrl);

        if (!response.ok) {
            throw new Error("Could not load the saved document.");
        }

        const blob = await response.blob();

        objectUrl = URL.createObjectURL(blob);
        documentWindow.location.href = objectUrl;

        window.setTimeout(() => {
            URL.revokeObjectURL(objectUrl);
        }, 60000);
    } catch (error) {
        console.error("Software License document open error:", error);

        if (documentWindow && !documentWindow.closed) {
            documentWindow.close();
        }

        alert("Document could not be opened. Please try again.");
    }
}

export default function SoftwareLicensePage() {
    const router = useRouter();

    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [formError, setFormError] = useState("");

    const [showForm, setShowForm] = useState(false);
    const [saving, setSaving] = useState(false);
    const [form, setForm] = useState({ ...initialForm });

    const [selectedDocument, setSelectedDocument] = useState(null);
    const [existingDocument, setExistingDocument] = useState(null);

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

        const unsubscribeAuth = onAuthStateChanged(
            auth,
            async (user) => {
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
                    const isFixedSuperAdmin =
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
                        .toLowerCase()
                        .replace(/[\s_-]+/g, "");

                    const isActive =
                        userData.active === true || isFixedSuperAdmin;

                    const superAdmin =
                        isFixedSuperAdmin ||
                        (isActive && role === "superadmin");

                    const canEdit =
                        superAdmin ||
                        (isActive &&
                            ["admin", "editor"].includes(role));

                    setIsSuperAdmin(superAdmin);
                    setCanEditRecords(canEdit);

                    if (!isActive) {
                        setRecords([]);
                        setError(
                            "Your account is inactive. Please contact the Super Admin."
                        );
                        setLoading(false);
                        return;
                    }

                    unsubscribeRecords = onSnapshot(
                        collection(db, COLLECTION_NAME),
                        (snapshot) => {
                            if (cancelled) return;

                            const licenseRecords = snapshot.docs
                                .filter((item) => {
                                    const data = item.data();

                                    return (
                                        data.category === "IT Devices" &&
                                        data.type === "Software License"
                                    );
                                })
                                .map((item) => {
                                    const data = item.data();

                                    const cost =
                                        data.cost !== "" && data.cost != null
                                            ? data.cost
                                            : data.charges ?? data.amount ?? "";

                                    return {
                                        ...data,
                                        id: item.id,
                                        licenseName:
                                            data.licenseName ??
                                            data.softwareName ??
                                            data.productName ??
                                            data.name ??
                                            "",
                                        licenseId: data.licenseId ?? data.productId ?? "",
                                        vendor:
                                            data.vendor ??
                                            data.provider ??
                                            data.company ??
                                            "",
                                        startDate:
                                            data.startDate ??
                                            data.purchaseDate ??
                                            "",
                                        expiryDate:
                                            data.expiryDate ??
                                            data.endDate ??
                                            data.validTill ??
                                            "",
                                        cost,
                                        branchUnit: data.branchUnit ?? data.unit ?? "",
                                        remarks: data.remarks ?? "",
                                    };
                                });

                            licenseRecords.sort((a, b) => {
                                const dateA =
                                    a.expiryDate || "9999-12-31";
                                const dateB =
                                    b.expiryDate || "9999-12-31";

                                return dateA.localeCompare(dateB);
                            });

                            setRecords(licenseRecords);
                            setError("");
                            setLoading(false);
                        },
                        (err) => {
                            if (cancelled) return;

                            console.error(
                                "Software License read error:",
                                err
                            );

                            setError(
                                "Software License records could not be loaded. Check Firestore permissions."
                            );

                            setLoading(false);
                        }
                    );
                } catch (err) {
                    if (cancelled) return;

                    console.error(
                        "Software License access check error:",
                        err
                    );

                    setIsSuperAdmin(false);
                    setCanEditRecords(false);
                    setRecords([]);

                    setError(
                        "Your access could not be verified. Please refresh the page or check your account permissions."
                    );

                    setLoading(false);
                }
            }
        );

        return () => {
            cancelled = true;
            unsubscribeAuth();
            unsubscribeRecords?.();
        };
    }, [router]);

    const preparedRecords = useMemo(
        () =>
            records.map((record) => ({
                ...record,
                status: getStatus(record.expiryDate),
            })),
        [records]
    );

    const counts = useMemo(() => {
        return {
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
        };
    }, [preparedRecords]);

    const expiryOverview = useMemo(() => {
        let overdue = 0;
        let next10 = 0;
        let next30 = 0;

        preparedRecords.forEach((record) => {
            const days = getDays(record.expiryDate);

            if (days === null) return;

            if (days < 0) {
                overdue++;
            } else {
                if (days <= 10) {
                    next10++;
                }

                if (days <= 30) {
                    next30++;
                }
            }
        });

        return { overdue, next10, next30 };
    }, [preparedRecords]);

    const filteredRecords = useMemo(() => {
        const query = search.trim().toLowerCase();

        return preparedRecords.filter((record) => {
            const matchesSearch = [
                record.licenseName,
                record.licenseId,
                record.vendor,
                record.branchUnit,
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

            return (
                matchesSearch &&
                matchesStatus &&
                matchesPeriod
            );
        });
    }, [preparedRecords, search, statusFilter, periodFilter]);

    function resetDocumentState() {
        setSelectedDocument(null);
        setExistingDocument(null);
    }

    function openAddForm() {
        if (!canEditRecords) {
            setError(
                "You do not have permission to add Software License records."
            );
            return;
        }

        setEditingId(null);
        setForm({ ...initialForm });
        resetDocumentState();
        setFormError("");
        setError("");
        setNotice("");
        setShowForm(true);
    }

    function openEditForm(record) {
        if (!canEditRecords) {
            setError(
                "You do not have permission to edit Software License records."
            );
            return;
        }

        setEditingId(record.id);

        setForm({
            licenseName: record.licenseName ?? "",
            licenseId: record.licenseId ?? "",
            vendor: record.vendor ?? "",
            startDate: record.startDate ?? "",
            expiryDate: record.expiryDate ?? "",
            cost: String(record.cost ?? ""),
            branchUnit: record.branchUnit ?? "",
            remarks: record.remarks ?? "",
        });

        setExistingDocument(
            record.documentData
                ? {
                    documentData: record.documentData,
                    documentName:
                        record.documentName || "Saved document",
                    documentSize: record.documentSize || 0,
                    documentType: record.documentType || "",
                }
                : null
        );

        setSelectedDocument(null);
        setFormError("");
        setError("");
        setNotice("");
        setShowForm(true);
    }

    function updateForm(event) {
        const { name, value } = event.target;

        setForm((current) => ({
            ...current,
            [name]: value,
        }));
    }

    async function handleDocumentChange(event) {
        const input = event.target;
        const file = input.files?.[0];

        input.value = "";

        if (!file) return;

        setFormError("");
        setSelectedDocument(null);

        const extension = getDocumentExtension(file.name);

        if (!ALLOWED_DOCUMENT_EXTENSIONS.includes(extension)) {
            setFormError(
                "Only PDF, JPG, JPEG, PNG, DOC and DOCX files are allowed."
            );
            return;
        }

        try {
            const processedFile =
                await compressImageIfNeeded(file);

            if (processedFile.size > MAX_DOCUMENT_SIZE) {
                setFormError(
                    "Document size must be 500 KB or less. Please choose a smaller file."
                );
                return;
            }

            setSelectedDocument(processedFile);
        } catch (err) {
            console.error(
                "Software License document processing error:",
                err
            );

            setFormError(
                err.message ||
                "Document could not be processed. Please try another file."
            );
        }
    }

    async function handleSubmit(event) {
        event.preventDefault();

        setFormError("");
        setNotice("");

        if (!canEditRecords) {
            setFormError(
                "You do not have permission to add or edit Software License records."
            );
            return;
        }

        if (
            !form.licenseName.trim() ||
            !form.vendor.trim() ||
            !form.startDate ||
            !form.expiryDate
        ) {
            setFormError(
                "Please fill in all required fields marked with *."
            );
            return;
        }

        if (form.expiryDate < form.startDate) {
            setFormError(
                "Expiry Date cannot be before Start Date."
            );
            return;
        }

        if (
            form.cost === "" ||
            !Number.isFinite(Number(form.cost)) ||
            Number(form.cost) < 0
        ) {
            setFormError("Please enter a valid license cost.");
            return;
        }

        setSaving(true);

        try {
            const recordData = {
                category: "IT Devices",
                type: "Software License",
                licenseName: form.licenseName.trim(),
                licenseId: form.licenseId.trim(),
                vendor: form.vendor.trim(),
                startDate: form.startDate,
                expiryDate: form.expiryDate,
                cost: Number(form.cost),
                branchUnit: form.branchUnit.trim(),
                remarks: form.remarks.trim(),
                updatedAt: serverTimestamp(),
            };

            let documentFields = {};

            if (selectedDocument) {
                const documentData =
                    await readDocumentAsDataUrl(selectedDocument);

                documentFields = {
                    documentData,
                    documentName: selectedDocument.name,
                    documentSize: selectedDocument.size,
                    documentType:
                        selectedDocument.type ||
                        (getDocumentExtension(
                            selectedDocument.name
                        ) === "pdf"
                            ? "application/pdf"
                            : ""),
                };
            } else if (existingDocument?.documentData) {
                documentFields = {
                    documentData: existingDocument.documentData,
                    documentName: existingDocument.documentName,
                    documentSize:
                        existingDocument.documentSize || 0,
                    documentType:
                        existingDocument.documentType || "",
                };
            } else if (editingId) {
                documentFields = {
                    documentData: deleteField(),
                    documentName: deleteField(),
                    documentSize: deleteField(),
                    documentType: deleteField(),
                };
            }

            if (editingId) {
                await updateDoc(
                    doc(db, COLLECTION_NAME, editingId),
                    {
                        ...recordData,
                        ...documentFields,
                    }
                );

                setNotice(
                    "Software License record updated successfully."
                );
            } else {
                await addDoc(collection(db, COLLECTION_NAME), {
                    ...recordData,
                    ...documentFields,
                    createdAt: serverTimestamp(),
                });

                setNotice(
                    "Software License record saved successfully."
                );
            }

            setShowForm(false);
            setForm({ ...initialForm });
            setEditingId(null);
            setFormError("");
            resetDocumentState();

            window.setTimeout(() => setNotice(""), 3500);
        } catch (err) {
            console.error(
                "Software License save error:",
                err
            );

            setFormError(
                err.code === "permission-denied"
                    ? "Permission denied. Please check Firestore security rules."
                    : err.code === "resource-exhausted"
                        ? "The document or record is too large for Firestore. Please choose a smaller document."
                        : editingId
                            ? "Software License record could not be updated. Please try again."
                            : "Software License record could not be saved. Please try again."
            );
        } finally {
            setSaving(false);
        }
    }

    async function handleDelete(record) {
        if (!isSuperAdmin) {
            setError(
                "Only Super Admin can delete Software License records."
            );
            return;
        }

        const confirmed = window.confirm(
            `Are you sure you want to delete "${record.licenseName || "this Software License record"}"? This action cannot be undone.`
        );

        if (!confirmed) return;

        setDeletingId(record.id);
        setError("");
        setNotice("");

        try {
            await deleteDoc(
                doc(db, COLLECTION_NAME, record.id)
            );

            setNotice(
                "Software License record deleted successfully."
            );

            window.setTimeout(() => setNotice(""), 3500);
        } catch (err) {
            console.error(
                "Software License delete error:",
                err
            );

            setError(
                err.code === "permission-denied"
                    ? "Permission denied. Check Firestore security rules."
                    : "Software License record could not be deleted."
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
                            Software License Management
                        </h1>

                        <p className="mt-2 text-sm text-slate-500">
                            Track software licenses, vendors, costs and expiry dates.
                        </p>
                    </div>

                    {canEditRecords && (
                        <button
                            type="button"
                            onClick={openAddForm}
                            className="rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-90"
                            style={{ backgroundColor: BLUE }}
                        >
                            + Add License
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
                        title="Total Licenses"
                        count={counts.total}
                        detail="All recorded software licenses"
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
                                Review licenses needing attention.
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
                                count: expiryOverview.overdue,
                                style: "border-red-100 bg-red-50 text-red-700",
                            },
                            {
                                label: "Next 10 days",
                                count: expiryOverview.next10,
                                style: "border-amber-100 bg-amber-50 text-amber-700",
                            },
                            {
                                label: "Next 30 days",
                                count: expiryOverview.next30,
                                style: "border-blue-100 bg-blue-50 text-blue-700",
                            },
                        ].map((item) => (
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
                        <div>
                            <h2 className="font-semibold text-slate-900">
                                Software License Records
                            </h2>

                            <p className="mt-1 text-sm text-slate-500">
                                {filteredRecords.length} of {preparedRecords.length} records
                            </p>
                        </div>

                        <div className="mt-4 grid gap-3 md:grid-cols-3">
                            <input
                                value={search}
                                onChange={(event) =>
                                    setSearch(event.target.value)
                                }
                                placeholder="Search license, ID, vendor, branch..."
                                className="rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                            />

                            <select
                                value={periodFilter}
                                onChange={(event) =>
                                    setPeriodFilter(event.target.value)
                                }
                                className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm"
                            >
                                <option value="All">
                                    Any expiry period
                                </option>
                                <option value="10">
                                    Within 10 days
                                </option>
                                <option value="30">
                                    Within 30 days
                                </option>
                                <option value="90">
                                    Within 90 days
                                </option>
                                <option value="Expired">
                                    Already expired
                                </option>
                            </select>

                            <select
                                value={statusFilter}
                                onChange={(event) =>
                                    setStatusFilter(event.target.value)
                                }
                                className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm"
                            >
                                <option value="All">All statuses</option>
                                <option value="Active">Active</option>
                                <option value="Expiring Soon">
                                    Expiring Soon
                                </option>
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
                            Loading Software License records...
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[1200px] text-left text-sm">
                                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                    <tr>
                                        {[
                                            "S. No.",
                                            "Software / License Name",
                                            "License ID",
                                            "Vendor",
                                            "Start Date",
                                            "Expiry Date",
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
                                        <tr
                                            key={record.id}
                                            className="hover:bg-slate-50"
                                        >
                                            <td className="whitespace-nowrap px-4 py-4">
                                                {index + 1}
                                            </td>

                                            <td className="px-4 py-4 font-medium text-slate-900">
                                                {record.licenseName || "—"}
                                            </td>

                                            <td className="whitespace-nowrap px-4 py-4">
                                                {record.licenseId || "—"}
                                            </td>

                                            <td className="px-4 py-4">
                                                {record.vendor || "—"}
                                            </td>

                                            <td className="whitespace-nowrap px-4 py-4">
                                                {formatDate(record.startDate)}
                                            </td>

                                            <td className="whitespace-nowrap px-4 py-4">
                                                {formatDate(record.expiryDate)}
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
                                                    {record.documentData && (
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                openSavedDocument(record.documentData)
                                                            }
                                                            className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                                                        >
                                                            View Doc
                                                        </button>
                                                    )}

                                                    {canEditRecords && (
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                openEditForm(record)
                                                            }
                                                            className="rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                                                        >
                                                            Edit
                                                        </button>
                                                    )}

                                                    {isSuperAdmin && (
                                                        <button
                                                            type="button"
                                                            disabled={deletingId === record.id}
                                                            onClick={() =>
                                                                handleDelete(record)
                                                            }
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
                                                colSpan={11}
                                                className="px-5 py-12 text-center"
                                            >
                                                <p className="font-medium text-slate-700">
                                                    No Software License records found
                                                </p>

                                                <p className="mt-1 text-xs text-slate-500">
                                                    {preparedRecords.length === 0
                                                        ? canEditRecords
                                                            ? "Use Add License to create the first entry."
                                                            : "No Software License records are available."
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
                <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/50 p-4">
                    <div className="my-auto max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
                        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
                            <div>
                                <h2 className="text-lg font-bold text-slate-900">
                                    {editingId
                                        ? "Edit Software License"
                                        : "Add Software License"}
                                </h2>

                                <p className="mt-1 text-sm text-slate-500">
                                    Enter the license details. License ID, Branch / Unit and Remarks are optional.
                                </p>
                            </div>

                            <button
                                type="button"
                                onClick={() => {
                                    setShowForm(false);
                                    setFormError("");
                                    resetDocumentState();
                                }}
                                disabled={saving}
                                className="rounded-lg px-3 py-2 text-xl text-slate-500 hover:bg-slate-100 disabled:opacity-50"
                            >
                                ×
                            </button>
                        </div>

                        <form
                            onSubmit={handleSubmit}
                            className="grid gap-4 p-6 sm:grid-cols-2"
                        >
                            <label className="text-sm font-medium text-slate-700">
                                Software / License Name *
                                <input
                                    required
                                    name="licenseName"
                                    value={form.licenseName}
                                    onChange={updateForm}
                                    placeholder="e.g. Microsoft 365, Adobe, Antivirus"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                License ID
                                <input
                                    name="licenseId"
                                    value={form.licenseId}
                                    onChange={updateForm}
                                    placeholder="Enter license ID"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Vendor / Provider *
                                <input
                                    required
                                    name="vendor"
                                    value={form.vendor}
                                    onChange={updateForm}
                                    placeholder="Enter vendor or provider name"
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
                                    name="expiryDate"
                                    value={form.expiryDate}
                                    onChange={updateForm}
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Cost / Charges (₹) *
                                <input
                                    required
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    name="cost"
                                    value={form.cost}
                                    onChange={updateForm}
                                    placeholder="Enter license cost"
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

                            <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4 sm:col-span-2">
                                <label className="block text-sm font-semibold text-slate-800">
                                    Software License Document{" "}
                                    <span className="ml-2 font-normal text-slate-500">
                                        (Optional)
                                    </span>
                                </label>

                                <p className="mt-1 text-xs text-slate-500">
                                    PDF, JPG, PNG, DOC or DOCX · Maximum 500 KB
                                </p>

                                {existingDocument?.documentData && (
                                    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white p-3">
                                        <span className="min-w-0 flex-1 break-all text-sm text-slate-700">
                                            {selectedDocument
                                                ? selectedDocument.name
                                                : existingDocument.documentName}
                                        </span>

                                        {!selectedDocument && (
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    openSavedDocument(
                                                        existingDocument.documentData
                                                    )
                                                }
                                                className="rounded-lg border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                                            >
                                                View
                                            </button>
                                        )}

                                        <label
                                            className="inline-flex cursor-pointer items-center rounded-lg px-3 py-2 text-xs font-semibold text-white"
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
                                            }}
                                            className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50"
                                        >
                                            Remove
                                        </button>
                                    </div>
                                )}

                                {!existingDocument?.documentData && (
                                    <label className="mt-3 flex w-full cursor-pointer items-center gap-3 rounded-lg border border-blue-200 bg-white p-3 transition hover:border-blue-400 hover:bg-blue-50">
                                        <span
                                            className="inline-flex shrink-0 items-center rounded-lg px-4 py-2 text-sm font-semibold text-white"
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

                                <p className="mt-2 text-xs text-slate-500">
                                    Images larger than 100 KB are compressed before saving.
                                </p>
                            </div>

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
                                        resetDocumentState();
                                    }}
                                    disabled={saving}
                                    className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50"
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
                                            ? "Update License"
                                            : "Save License"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </main>
    );
}
