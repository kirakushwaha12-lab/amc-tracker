
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
    deleteField,
} from "firebase/firestore";

import imageCompression from "browser-image-compression";
import { auth, db } from "../../../lib/firebase";
import {
    recognizeDocumentImage,
    extractDocumentFields,
    mergeExtractedFields,
} from "../../lib/document-ocr";

const BLUE = "#0b4da2";
const SUPER_ADMIN_UID = "gm7L9ZxaqOUIm9qBP9Lf2sxDLh92";

const initialForm = {
    productName: "",
    productId: "",
    policyNo: "",
    renewalDate: "",
    companyVendor: "",
    startDate: "",
    expiryDate: "",
    amount: "",
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

function getPolicyStatus(policy) {
    if (!policy.expiryDate) return "Unknown";

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const expiry = new Date(`${policy.expiryDate}T00:00:00`);

    if (Number.isNaN(expiry.getTime())) return "Unknown";

    const days = Math.ceil((expiry - today) / 86400000);

    if (days < 0) return "Expired";
    if (days <= 10) return "Expiring Soon";

    return "Active";
}

function money(value) {
    if (value === "" || value === null || value === undefined) {
        return "—";
    }

    const number = Number(value);

    if (!Number.isFinite(number)) return "—";

    return number.toLocaleString("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 2,
    });
}
const MAX_DOCUMENT_SIZE = 500 * 1024;

function getDocumentExtension(name = "") {
    return name.split(".").pop()?.toLowerCase() || "";
}

async function compressInsuranceImage(file) {
    const extension = getDocumentExtension(file.name);
    const isImage = ["jpg", "jpeg", "png"].includes(extension);

    if (!isImage || file.size <= 100 * 1024) return file;

    const compressed = await imageCompression(file, {
        maxSizeMB: 0.2,
        maxWidthOrHeight: 1600,
        useWebWorker: true,
        fileType: file.type || undefined,
    });

    if (compressed.size >= file.size) return file;

    return new File([compressed], file.name, {
        type: compressed.type || file.type,
        lastModified: Date.now(),
    });
}

function readInsuranceDocument(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => resolve(reader.result);
        reader.onerror = () =>
            reject(new Error("Could not read document."));

        reader.readAsDataURL(file);
    });
}

async function openInsuranceDocument(data) {
    const tab = window.open("", "_blank");

    if (!tab) {
        alert("Please allow pop-ups to view the document.");
        return;
    }

    try {
        const response = await fetch(data);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);

        tab.location.href = url;

        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
        tab.close();
        alert("Could not open the document.");
    }
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
            className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${styles[status] || styles.Unknown
                }`}
        >
            {status}
        </span>
    );
}

export default function InsurancePage() {
    const router = useRouter();

    const [policies, setPolicies] = useState([]);
    const [loading, setLoading] = useState(true);
    const [userChecked, setUserChecked] = useState(false);
    const [error, setError] = useState("");
    const [formError, setFormError] = useState("");
    const [notice, setNotice] = useState("");
    const [showForm, setShowForm] = useState(false);
    const [saving, setSaving] = useState(false);
    const [form, setForm] = useState({ ...initialForm });
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("All");
    const [periodFilter, setPeriodFilter] = useState("All");

    const [editingId, setEditingId] = useState(null);
    const [isSuperAdmin, setIsSuperAdmin] = useState(false);
    const [canEditRecords, setCanEditRecords] = useState(false);
    const [deletingId, setDeletingId] = useState(null);
    const [selectedDocument, setSelectedDocument] = useState(null);
    const [existingDocument, setExistingDocument] = useState(null);
    const [documentError, setDocumentError] = useState("");
    const [ocrStatus, setOcrStatus] = useState("");

    useEffect(() => {
        let unsubscribePolicies;
        let cancelled = false;

        const unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
            unsubscribePolicies?.();
            unsubscribePolicies = undefined;

            setUserChecked(true);
            setError("");
            setIsSuperAdmin(false);
            setCanEditRecords(false);

            if (!user) {
                setPolicies([]);
                setLoading(false);
                router.replace("/");
                return;
            }

            setLoading(true);

            try {
                const isFixedSuperAdmin = user.uid === SUPER_ADMIN_UID;
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

                if (!isActive) {
                    setPolicies([]);
                    setError(
                        "Your account is inactive. Please contact the Super Admin."
                    );
                    setLoading(false);
                    return;
                }

                unsubscribePolicies = onSnapshot(
                    collection(db, "vehicles"),
                    (snapshot) => {
                        if (cancelled) return;

                        const insuranceRecords = snapshot.docs
                            .map((item) => {
                                const data = item.data();

                                return {
                                    id: item.id,
                                    ...data,
                                    renewalDate: data.renewalDate ?? "",
                                    companyVendor:
                                        data.companyVendor ??
                                        data.insuranceCompany ??
                                        data.vendor ??
                                        data.company ??
                                        "",
                                    startDate:
                                        data.startDate ??
                                        data.periodDate ??
                                        "",
                                };
                            })
                            .filter(
                                (record) =>
                                    String(record.category || "").toLowerCase() === "vehicles" &&
                                    String(record.type || "").toLowerCase() === "insurance"
                            );

                        insuranceRecords.sort((a, b) => {
                            const dateA = a.expiryDate || "9999-12-31";
                            const dateB = b.expiryDate || "9999-12-31";

                            return dateA.localeCompare(dateB);
                        });

                        setPolicies(insuranceRecords);

                        setError("");
                        setLoading(false);
                    },
                    (err) => {
                        console.error("Insurance read error:", err);

                        if (cancelled) return;

                        setError(
                            "Insurance records could not be loaded. Please check Firestore permissions."
                        );
                        setLoading(false);
                    }
                );
            } catch (err) {
                console.error("Insurance role check error:", err);

                if (!cancelled) {
                    setIsSuperAdmin(false);
                    setCanEditRecords(false);
                    setPolicies([]);
                    setError("User role could not be verified.");
                    setLoading(false);
                }
            }
        });

        return () => {
            cancelled = true;
            unsubscribeAuth();
            unsubscribePolicies?.();
        };
    }, [router]);

    const counts = useMemo(() => {
        const total = policies.length;

        const active = policies.filter(
            (policy) => getPolicyStatus(policy) === "Active"
        ).length;

        const expiring = policies.filter(
            (policy) => getPolicyStatus(policy) === "Expiring Soon"
        ).length;

        const expired = policies.filter(
            (policy) => getPolicyStatus(policy) === "Expired"
        ).length;

        return { total, active, expiring, expired };
    }, [policies]);

    const expiryOverview = useMemo(() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let overdue = 0;
        let next10 = 0;
        let next30 = 0;

        policies.forEach((policy) => {
            if (!policy.expiryDate) return;

            const expiry = new Date(`${policy.expiryDate}T00:00:00`);

            if (Number.isNaN(expiry.getTime())) return;

            const days = Math.ceil((expiry - today) / 86400000);

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
    }, [policies]);

    const filteredPolicies = useMemo(() => {
        const queryText = search.trim().toLowerCase();

        return policies.filter((policy) => {
            const matchesSearch = [
                policy.productName,
                policy.productId,
                policy.policyNo,
                policy.companyVendor,
            ].some((value) =>
                String(value || "").toLowerCase().includes(queryText)
            );

            const status = getPolicyStatus(policy);

            const matchesStatus =
                statusFilter === "All" || status === statusFilter;

            let matchesPeriod = true;

            if (periodFilter !== "All") {
                if (!policy.expiryDate) {
                    matchesPeriod = false;
                } else {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);

                    const expiry = new Date(
                        `${policy.expiryDate}T00:00:00`
                    );

                    if (Number.isNaN(expiry.getTime())) {
                        matchesPeriod = false;
                    } else {
                        const days = Math.ceil(
                            (expiry - today) / 86400000
                        );

                        if (periodFilter === "Expired") {
                            matchesPeriod = days < 0;
                        } else {
                            matchesPeriod =
                                days >= 0 &&
                                days <= Number(periodFilter);
                        }
                    }
                }
            }

            return matchesSearch && matchesStatus && matchesPeriod;
        });
    }, [policies, search, statusFilter, periodFilter]);

    function openAddForm() {
        if (!canEditRecords) {
            setError("You do not have permission to add Insurance records.");
            return;
        }

        setEditingId(null);
        setForm({ ...initialForm });
        setFormError("");
        setSelectedDocument(null);
        setExistingDocument(null);
        setDocumentError("");
        setError("");
        setNotice("");
        setShowForm(true);
        setOcrStatus("");
    }

    function openEditForm(policy) {
        if (!canEditRecords) {
            setError("You do not have permission to edit Insurance records.");
            return;
        }

        setEditingId(policy.id);

        setForm({
            productName: policy.productName ?? "",
            productId: policy.productId ?? "",
            policyNo: policy.policyNo ?? "",
            renewalDate: policy.renewalDate ?? "",
            companyVendor: policy.companyVendor ?? "",
            startDate: policy.startDate ?? "",
            expiryDate: policy.expiryDate ?? "",
            amount: String(policy.amount ?? ""),
        });


        setExistingDocument(
            policy.documentData
                ? {
                    name: policy.documentName || "Saved document",
                    data: policy.documentData,
                    size: policy.documentSize || 0,
                    type: policy.documentType || "",
                }
                : null
        );

        setSelectedDocument(null);
        setDocumentError("");
        setFormError("");
        setError("");
        setNotice("");
        setShowForm(true);
        setOcrStatus("");
    }

    function handleChange(event) {
        const { name, value } = event.target;

        setForm((current) => ({
            ...current,
            [name]: value,
        }));
    }



    async function handleInsuranceDocumentChange(event) {
        const input = event.target;
        const file = input.files?.[0];

        setDocumentError("");
        setOcrStatus("");

        if (!file) return;

        const allowed = ["pdf", "jpg", "jpeg", "png", "doc", "docx"];
        const extension = getDocumentExtension(file.name);

        if (!allowed.includes(extension)) {
            setDocumentError(
                "Only PDF, JPG, PNG, DOC and DOCX files are allowed."
            );
            input.value = "";
            return;
        }

        try {
            const finalFile = await compressInsuranceImage(file);

            if (finalFile.size > MAX_DOCUMENT_SIZE) {
                setDocumentError(
                    "File must be 500 KB or less after compression."
                );
                input.value = "";
                return;
            }

            // Keep the selected document even if OCR fails.
            setSelectedDocument(finalFile);
            const ocrSupported = ["jpg", "jpeg", "png", "pdf"].includes(
                getDocumentExtension(finalFile.name)
            );

            if (!ocrSupported) {
                setOcrStatus(
                    "Document saved. OCR is available for JPG, PNG and PDF files."
                );
                return;
            }

            setOcrStatus("Reading insurance document...");

            try {
                const rawText = await recognizeDocumentImage(finalFile);

                console.log("INSURANCE OCR TEXT:", rawText);

                if (!rawText || !rawText.trim()) {
                    setOcrStatus(
                        "Document selected, but no readable text was detected."
                    );
                    return;
                }

                // Common OCR extraction: reads the current form's labels
                // and aliases instead of using Insurance-specific hardcoding.
                if (!input.form) {
                    throw new Error("Insurance form could not be identified.");
                }

                const extracted = extractDocumentFields(
                    rawText,
                    input.form
                );

                console.log("COMMON OCR EXTRACTED FIELDS:", extracted);

                // Fill only blank fields. Existing manual entries stay unchanged.
                setForm((current) => {
                    const result = mergeExtractedFields(
                        current,
                        extracted
                    );

                    return result.form;
                });

                const detectedCount = Object.values(extracted).filter(
                    (value) => String(value ?? "").trim() !== ""
                ).length;

                setOcrStatus(
                    detectedCount > 0
                        ? `${detectedCount} field(s) detected. Review the extracted details before saving.`
                        : "Document read, but no matching form fields were detected. You can enter details manually."
                );

            } catch (ocrError) {
                console.error("Insurance OCR error:", ocrError);

                setOcrStatus(
                    "Document selected, but OCR could not read it. You can enter the details manually."
                );
            }

        } catch (error) {
            setDocumentError(
                error.message || "Could not process this file."
            );
            input.value = "";
        }
    }


    async function handleSubmit(event) {
        event.preventDefault();
        setFormError("");
        setNotice("");

        if (!canEditRecords) {
            setShowForm(false);
            setFormError("You do not have permission to add or edit Insurance records.");
            return;
        }

        if (!form.productName.trim()) {
            setFormError("Product Name is required.");
            return;
        }

        if (!form.policyNo.trim()) {
            setFormError("Policy No. is required.");
            return;
        }

        if (!form.companyVendor.trim()) {
            setFormError("Company / Vendor is required.");
            return;
        }

        if (!form.startDate) {
            setFormError("Start Date is required.");
            return;
        }

        if (!form.expiryDate) {
            setFormError("Expiry Date is required.");
            return;
        }

        if (form.expiryDate < form.startDate) {
            setFormError("Expiry Date cannot be before Start Date.");
            return;
        }

        if (
            form.amount === "" ||
            !Number.isFinite(Number(form.amount)) ||
            Number(form.amount) < 0
        ) {
            setFormError("Please enter a valid Amount.");
            return;
        }

        try {
            setSaving(true);

            const recordData = {
                category: "Vehicles",
                type: "Insurance",
                productName: form.productName.trim(),
                productId: form.productId.trim(),
                policyNo: form.policyNo.trim(),
                renewalDate: form.renewalDate,
                companyVendor: form.companyVendor.trim(),
                startDate: form.startDate,
                expiryDate: form.expiryDate,
                amount: Number(form.amount),
                updatedAt: serverTimestamp(),
            };


            let documentFields = {};


            if (selectedDocument) {
                documentFields = {
                    documentData: await readInsuranceDocument(selectedDocument),
                    documentName: selectedDocument.name,
                    documentSize: selectedDocument.size,
                    documentType: selectedDocument.type || "",
                };
            } else if (existingDocument?.data) {
                documentFields = {
                    documentData: existingDocument.data,
                    documentName: existingDocument.name,
                    documentSize: existingDocument.size || 0,
                    documentType: existingDocument.type || "",
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
                await updateDoc(doc(db, "vehicles", editingId), {
                    ...recordData,
                    ...documentFields,
                });

                setNotice("Insurance record updated successfully.");
            } else {
                await addDoc(collection(db, "vehicles"), {
                    ...recordData,
                    ...documentFields,
                    createdAt: serverTimestamp(),
                });

                setNotice("Insurance record added successfully.");
            }

            setForm({ ...initialForm });
            setEditingId(null);
            setShowForm(false);
            setSelectedDocument(null);
            setExistingDocument(null);
            setDocumentError("");
            window.setTimeout(() => setNotice(""), 3500);
        } catch (err) {
            console.error("Insurance save error:", err);

            setFormError(
                err.code === "permission-denied"
                    ? "Permission denied. Please check Firestore security rules."
                    : editingId
                        ? "Insurance record could not be updated. Please try again."
                        : "Insurance record could not be saved. Please try again."
            );
        } finally {
            setSaving(false);
        }
    }

    async function handleDelete(policy) {
        if (!isSuperAdmin) {
            setError("Only Super Admin can delete Insurance records.");
            return;
        }

        const confirmed = window.confirm(
            `Delete the Insurance record for "${policy.productName || "this record"}"? This action cannot be undone.`
        );

        if (!confirmed) return;

        setDeletingId(policy.id);
        setError("");
        setNotice("");

        try {
            await deleteDoc(doc(db, "vehicles", policy.id));

            setNotice("Insurance record deleted successfully.");
            window.setTimeout(() => setNotice(""), 3500);
        } catch (err) {
            console.error("Insurance delete error:", err);

            setError(
                err.code === "permission-denied"
                    ? "Permission denied. Check Firestore security rules."
                    : "Insurance record could not be deleted."
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
                            Insurance Management
                        </h1>

                        <p className="mt-2 text-sm text-slate-500">
                            Track insurance details, renewal dates and expiry dates.
                        </p>
                    </div>

                    {canEditRecords && (
                        <button
                            type="button"
                            onClick={openAddForm}
                            className="rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-90"
                            style={{ backgroundColor: BLUE }}
                        >
                            + Add Insurance
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
                        detail="All recorded insurance entries"
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
                        detail="Records past their expiry date"
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
                                Quick view of upcoming and overdue records
                            </p>
                        </div>

                        <span className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600">
                            Based on current date
                        </span>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        <div className="rounded-xl border border-red-100 bg-red-50 p-4">
                            <p className="text-sm font-medium text-red-700">Overdue</p>
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
                    <div className="border-b border-slate-100 p-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <h2 className="font-semibold text-slate-900">
                                    Insurance Records
                                </h2>
                                <p className="mt-1 text-sm text-slate-500">
                                    {filteredPolicies.length} of {policies.length} records
                                </p>
                            </div>
                        </div>

                        <div className="mt-4 grid gap-3 md:grid-cols-3">
                            <input
                                type="text"
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder="Search product, policy or company..."
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
                    ) : loading || !userChecked ? (
                        <p className="p-10 text-center text-sm text-slate-500">
                            Loading insurance records...
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
                                            "Policy No.",
                                            "Renewal Date",
                                            "Company / Vendor",
                                            "Start Date",
                                            "Expiry Date",
                                            "Amount",
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
                                    {filteredPolicies.map((policy, index) => (
                                        <tr
                                            key={policy.id}
                                            className="hover:bg-slate-50"
                                        >
                                            <td className="whitespace-nowrap px-4 py-4 text-slate-600">
                                                {index + 1}
                                            </td>

                                            <td className="whitespace-nowrap px-4 py-4 font-medium text-slate-900">
                                                {policy.productName || "—"}
                                            </td>

                                            <td className="whitespace-nowrap px-4 py-4 text-slate-600">
                                                {policy.productId || "—"}
                                            </td>

                                            <td className="whitespace-nowrap px-4 py-4 text-slate-700">
                                                {policy.policyNo || "—"}
                                            </td>

                                            <td className="whitespace-nowrap px-4 py-4 text-slate-600">
                                                {formatDate(policy.renewalDate)}
                                            </td>

                                            <td className="whitespace-nowrap px-4 py-4 text-slate-700">
                                                {policy.companyVendor || "—"}
                                            </td>

                                            <td className="whitespace-nowrap px-4 py-4 text-slate-600">
                                                {formatDate(policy.startDate)}
                                            </td>

                                            <td className="whitespace-nowrap px-4 py-4 text-slate-600">
                                                {formatDate(policy.expiryDate)}
                                            </td>

                                            <td className="whitespace-nowrap px-4 py-4 text-slate-700">
                                                {money(policy.amount)}
                                            </td>

                                            <td className="whitespace-nowrap px-4 py-4">
                                                <StatusBadge status={getPolicyStatus(policy)} />
                                            </td>

                                            <td className="whitespace-nowrap px-4 py-4">
                                                <div className="flex items-center gap-2">
                                                    {canEditRecords && (
                                                        <button
                                                            type="button"
                                                            onClick={() => openEditForm(policy)}
                                                            className="rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                                                        >
                                                            Edit
                                                        </button>
                                                    )}

                                                    {policy.documentData && (
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                openInsuranceDocument(policy.documentData)
                                                            }
                                                            className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                                                        >
                                                            View Doc
                                                        </button>
                                                    )}

                                                    {isSuperAdmin && (
                                                        <button
                                                            type="button"
                                                            disabled={deletingId === policy.id}
                                                            onClick={() => handleDelete(policy)}
                                                            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                                                        >
                                                            {deletingId === policy.id
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

                                    {filteredPolicies.length === 0 && (
                                        <tr>
                                            <td colSpan={11} className="px-5 py-12 text-center">
                                                <p className="font-medium text-slate-700">
                                                    No insurance records found
                                                </p>
                                                <p className="mt-1 text-xs text-slate-500">
                                                    {policies.length === 0
                                                        ? "No insurance records have been added yet."
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
                    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/50 p-4">
                        <div className="my-auto max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
                            <div className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white p-5">
                                <div>
                                    <h2 className="text-xl font-bold text-slate-900">
                                        {editingId ? "Edit Insurance" : "Add Insurance"}
                                    </h2>
                                    <p className="mt-1 text-sm text-slate-500">
                                        Enter the details below.
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
                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-slate-700">
                                            Product Name *
                                        </label>
                                        <input
                                            required
                                            name="productName"
                                            data-ocr-aliases="Insured Item|Vehicle Description|Insured Property|Vehicle Model|Make and Model|Make/Model|Make Model|Make - Model|Vehicle Make/Model"
                                            value={form.productName}
                                            onChange={handleChange}
                                            placeholder="e.g. Motorcycle, DG Set"
                                            className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                                        />
                                    </div>

                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-slate-700">
                                            Product ID
                                        </label>
                                        <input
                                            name="productId"
                                            data-ocr-aliases="Registration No|Registration Mark|Vehicle No|Vehicle Registration No"
                                            value={form.productId}
                                            onChange={handleChange}
                                            placeholder="Enter product ID"
                                            className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                                        />
                                    </div>

                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-slate-700">
                                            Policy No. *
                                        </label>
                                        <input
                                            required
                                            name="policyNo"
                                            data-ocr-aliases="Policy Number|Policy No|Policy Reference|Certificate No"
                                            value={form.policyNo}
                                            onChange={handleChange}
                                            placeholder="Enter policy number"
                                            className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                                        />
                                    </div>

                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-slate-700">
                                            Renewal Date
                                        </label>
                                        <input
                                            type="date"
                                            name="renewalDate"
                                            data-ocr-aliases="Next Renewal Date|Renewal Due Date|dt"
                                            value={form.renewalDate}
                                            onChange={handleChange}
                                            className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                                        />
                                    </div>

                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-slate-700">
                                            Insurance / Partner Company *
                                        </label>
                                        <input
                                            required
                                            name="companyVendor"
                                            data-ocr-aliases="Insurance Company|Insurer|Partner Company|Company Name"
                                            value={form.companyVendor}
                                            onChange={handleChange}
                                            placeholder="Enter insurance company"
                                            className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                                        />
                                    </div>

                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-slate-700">
                                            Start Date *
                                        </label>
                                        <input
                                            required
                                            type="date"
                                            name="startDate"
                                            data-ocr-range-label="Period of Insurance"
                                            data-ocr-range-part="start"
                                            data-ocr-aliases="Policy Start Date|Period of Insurance From|Risk Commencement Date|Valid From|From"
                                            value={form.startDate}
                                            onChange={handleChange}
                                            className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                                        />
                                    </div>

                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-slate-700">
                                            Expiry Date *
                                        </label>
                                        <input
                                            required
                                            type="date"
                                            min={form.startDate || undefined}
                                            name="expiryDate"
                                            data-ocr-range-label="Period of Insurance"
                                            data-ocr-range-part="end"
                                            data-ocr-aliases="Policy Expiry Date|Period of Insurance To|Risk Expiry Date|Valid To|To Midnight Of"
                                            value={form.expiryDate}
                                            onChange={handleChange}
                                            className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                                        />
                                    </div>

                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-slate-700">
                                            Amount (₹) *
                                        </label>
                                        <input
                                            required
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            name="amount"
                                            data-ocr-aliases="Total|Total Premium|Premium Amount|Gross Premium|Amount Payable"
                                            value={form.amount}
                                            onChange={handleChange}
                                            placeholder="Enter amount"
                                            className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                                        />
                                    </div>


                                    <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-4 sm:col-span-2">
                                        <label className="block text-sm font-semibold text-slate-800">
                                            Insurance Document (Optional)
                                        </label>

                                        <p className="mt-1 text-xs text-slate-500">
                                            PDF, JPG, PNG, DOC or DOCX · Maximum 500 KB
                                        </p>

                                        {existingDocument && (
                                            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white p-3">
                                                <span className="min-w-0 flex-1 break-all text-sm text-slate-700">
                                                    {selectedDocument?.name || existingDocument.name}
                                                </span>

                                                {!selectedDocument && (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            openInsuranceDocument(existingDocument.data)
                                                        }
                                                        className="rounded-lg border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-700"
                                                    >
                                                        View
                                                    </button>
                                                )}

                                                <label
                                                    className="cursor-pointer rounded-lg px-3 py-2 text-xs font-semibold text-white"
                                                    style={{ backgroundColor: BLUE }}
                                                >
                                                    Replace
                                                    <input
                                                        type="file"
                                                        accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                                                        onChange={handleInsuranceDocumentChange}
                                                        className="sr-only"
                                                    />
                                                </label>

                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setExistingDocument(null);
                                                        setSelectedDocument(null);
                                                        setDocumentError("");
                                                    }}
                                                    className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700"
                                                >
                                                    Remove
                                                </button>
                                            </div>
                                        )}

                                        {!existingDocument && (
                                            <label className="mt-3 flex cursor-pointer items-center gap-3 rounded-lg border border-blue-200 bg-white p-3">
                                                <span
                                                    className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
                                                    style={{ backgroundColor: BLUE }}
                                                >
                                                    Choose Document
                                                </span>

                                                <span className="min-w-0 flex-1 break-all text-sm text-slate-500">
                                                    {selectedDocument?.name || "No file chosen"}
                                                </span>

                                                <input
                                                    type="file"
                                                    accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                                                    onChange={handleInsuranceDocumentChange}
                                                    className="sr-only"
                                                />
                                            </label>
                                        )}

                                        {selectedDocument && (
                                            <p className="mt-2 text-xs text-emerald-700">
                                                Selected: {selectedDocument.name} ·{" "}
                                                {(selectedDocument.size / 1024).toFixed(1)} KB
                                            </p>
                                        )}
                                        {ocrStatus && (
                                            <p className="mt-2 text-sm text-blue-700">
                                                {ocrStatus}
                                            </p>
                                        )}
                                        {documentError && (
                                            <p className="mt-2 text-sm text-red-600">
                                                {documentError}
                                            </p>
                                        )}
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
        </main >
    );
}