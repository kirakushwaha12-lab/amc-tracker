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
const COLLECTION_NAME = "machinery_records";
const MAX_DOCUMENT_SIZE = 500 * 1024;

const initialForm = {
    machineNo: "",
    machineName: "",
    department: "",
    unit: "",
    lastServiceDate: "",
    nextDueDate: "",
    serviceProvider: "",
    serviceCharges: "",
    amcApplicable: "No",
    amcVendor: "",
    amcStartDate: "",
    amcEndDate: "",
    amcCharges: "",
    remarks: "",
};

function getDays(dateValue) {
    if (!dateValue) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const date = new Date(`${dateValue}T00:00:00`);
    if (Number.isNaN(date.getTime())) return null;

    return Math.round(
        (date.getTime() - today.getTime()) / 86400000
    );
}

function getStatus(dateValue) {
    const days = getDays(dateValue);

    if (days === null) return "Unknown";
    if (days < 0) return "Expired";
    if (days <= 10) return "Expiring Soon";

    return "Active";
}

function isAmcApplicable(record) {
    return (
        String(record?.amcApplicable || "")
            .trim()
            .toLowerCase() === "yes"
    );
}

function getServiceDueDate(record) {
    return record?.nextDueDate || record?.nextServiceDueDate || "";
}

function getOverallStatus(record) {
    const serviceDueDate = getServiceDueDate(record);
    const amcApplicable = isAmcApplicable(record);

    const statuses = [];

    if (serviceDueDate) {
        statuses.push(getStatus(serviceDueDate));
    }

    if (amcApplicable) {
        statuses.push(
            record.amcEndDate
                ? getStatus(record.amcEndDate)
                : "Unknown"
        );
    }

    if (statuses.length === 0) return "Unknown";

    if (statuses.includes("Expired")) return "Expired";

    if (statuses.includes("Expiring Soon")) {
        return "Expiring Soon";
    }

    if (statuses.includes("Unknown")) {
        return "Unknown";
    }

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

function normalizeMachineNo(value) {
    return String(value || "")
        .trim()
        .replace(/\s+/g, "")
        .toUpperCase();
}

export default function MachineryPage() {
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
    const [amcFilter, setAmcFilter] = useState("All");

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

                if (userData.active !== true) {
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

                        const machineryRecords = snapshot.docs.map((item) => ({
                            id: item.id,
                            ...item.data(),
                        }));

                        machineryRecords.sort((a, b) => {
                            const dateA = getServiceDueDate(a) || "9999-12-31";
                            const dateB = getServiceDueDate(b) || "9999-12-31";

                            return dateA.localeCompare(dateB);
                        });

                        setRecords(machineryRecords);
                        setError("");
                        setLoading(false);
                    },
                    (err) => {
                        console.error("Machinery read error:", err);

                        if (cancelled) return;

                        setError(
                            "Machinery records could not be loaded. Check Firestore permissions."
                        );
                        setLoading(false);
                    }
                );
            } catch (err) {
                console.error("Machinery role check error:", err);

                if (!cancelled) {
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
            records.map((record) => {
                const normalizedRecord = {
                    ...record,
                    machineNo: record.machineNo ?? "",
                    machineName: record.machineName ?? "",
                    department: record.department ?? "",
                    unit: record.unit ?? "",
                    lastServiceDate: record.lastServiceDate ?? "",
                    nextDueDate: record.nextDueDate ?? "",
                    serviceProvider: record.serviceProvider ?? "",
                    serviceCharges: record.serviceCharges ?? "",
                    amcApplicable: isAmcApplicable(record) ? "Yes" : "No",
                    amcVendor: record.amcVendor ?? "",
                    amcStartDate: record.amcStartDate ?? "",
                    amcEndDate: record.amcEndDate ?? "",
                    amcCharges: record.amcCharges ?? "",
                    remarks: record.remarks ?? "",
                };

                return {
                    ...normalizedRecord,
                    serviceDueDate: getServiceDueDate(normalizedRecord),
                    status: getOverallStatus(normalizedRecord),
                };
            }),
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

            overdue: preparedRecords.filter(
                (record) => record.status === "Expired"
            ).length,

            amcExpiring: preparedRecords.filter(
                (record) =>
                    isAmcApplicable(record) &&
                    getStatus(record.amcEndDate) === "Expiring Soon"
            ).length,
        }),
        [preparedRecords]
    );

    const filteredRecords = useMemo(() => {
        const query = search.trim().toLowerCase();

        return preparedRecords.filter((record) => {
            const matchesSearch = [
                record.machineNo,
                record.machineName,
                record.department,
                record.unit,
                record.serviceProvider,
                record.serviceCharges,
                record.amcVendor,
                record.amcCharges,
                record.amcStartDate,
                record.amcEndDate,
                record.remarks,
            ].some((value) =>
                String(value ?? "").toLowerCase().includes(query)
            );

            const matchesStatus =
                statusFilter === "All" ||
                record.status === statusFilter;

            const applicableDates = [];

            if (record.serviceDueDate) {
                applicableDates.push(record.serviceDueDate);
            }

            if (
                isAmcApplicable(record) &&
                record.amcEndDate
            ) {
                applicableDates.push(record.amcEndDate);
            }

            const applicableDays = applicableDates
                .map(getDays)
                .filter((days) => days !== null);

            const matchesPeriod =
                periodFilter === "All" ||
                (periodFilter === "Expired"
                    ? applicableDays.some((days) => days < 0)
                    : periodFilter === "10"
                        ? applicableDays.some((days) => days >= 0 && days <= 10)
                        : periodFilter === "30"
                            ? applicableDays.some((days) => days >= 0 && days <= 30)
                            : periodFilter === "90"
                                ? applicableDays.some((days) => days >= 0 && days <= 90)
                                : false);

            const matchesAmc =
                amcFilter === "All" ||
                (amcFilter === "Yes"
                    ? isAmcApplicable(record)
                    : !isAmcApplicable(record));

            return (
                matchesSearch &&
                matchesStatus &&
                matchesPeriod &&
                matchesAmc
            );
        });
    }, [
        preparedRecords,
        search,
        statusFilter,
        periodFilter,
        amcFilter,
    ]);
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
            console.error("Image compression failed:", error);
            throw new Error("Image compression failed. Please try again.");
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
        if (!canEditRecords) return;

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
        if (!canEditRecords) return;

        setEditingId(record.id);
        setRenewingId(null);

        setForm({
            machineNo: record.machineNo ?? "",
            machineName: record.machineName ?? "",
            department: record.department ?? "",
            unit: record.unit ?? "",
            lastServiceDate: record.lastServiceDate ?? "",
            nextDueDate: record.nextDueDate ?? "",
            serviceProvider: record.serviceProvider ?? "",
            serviceCharges: String(record.serviceCharges ?? ""),
            amcApplicable: isAmcApplicable(record) ? "Yes" : "No",
            amcVendor: record.amcVendor ?? "",
            amcStartDate: record.amcStartDate ?? "",
            amcEndDate: record.amcEndDate ?? "",
            amcCharges: String(record.amcCharges ?? ""),
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

    const openRenewForm = (record) => {
        if (!canEditRecords) return;

        setEditingId(null);
        setRenewingId(record.id);

        setForm({
            machineNo: record.machineNo || "",
            machineName: record.machineName || "",
            department: record.department || "",
            unit: record.unit || "",

            lastServiceDate: "",
            nextDueDate: "",

            serviceProvider: record.serviceProvider || "",
            serviceCharges: record.serviceCharges ?? "",

            amcApplicable: isAmcApplicable(record) ? "Yes" : "No",
            amcVendor: record.amcVendor || "",
            amcStartDate: "",
            amcEndDate: "",
            amcCharges: record.amcCharges ?? "",

            remarks: record.remarks || "",
        });

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

        setSelectedDocument(null);
        setRemoveDocument(false);
        setFormError("");
        setError("");
        setNotice("");
        setShowForm(true);
    };

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

        if (
            !form.machineNo.trim() ||
            !form.machineName.trim() ||
            !form.department.trim() ||
            !form.unit.trim() ||
            form.amcApplicable === ""
        ) {
            setFormError(
                "Please fill in all required fields: Machine No., Machine Name, Department, Branch / Unit and AMC Applicable."
            );
            return;
        }

        if (
            form.serviceCharges !== "" &&
            (!Number.isFinite(Number(form.serviceCharges)) ||
                Number(form.serviceCharges) < 0)
        ) {
            setFormError("Please enter valid Service Charges (zero or more).");
            return;
        }

        if (
            form.nextDueDate &&
            form.lastServiceDate &&
            form.nextDueDate < form.lastServiceDate
        ) {
            setFormError(
                "Next Due Date cannot be before Last Service Date."
            );
            return;
        }

        if (form.amcApplicable === "Yes") {
            if (!form.amcVendor.trim()) {
                setFormError(
                    "Please fill AMC Company / Vendor."
                );
                return;
            }

            if (
                form.amcStartDate &&
                form.amcEndDate &&
                form.amcEndDate < form.amcStartDate
            ) {
                setFormError(
                    "AMC End Date cannot be before AMC Start Date."
                );
                return;
            }


        }



        setSaving(true);

        try {
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
                category: "Machinery",
                type: "Machinery",
                machineNo: form.machineNo.trim().toUpperCase(),
                machineName: form.machineName.trim(),
                department: form.department.trim(),
                unit: form.unit.trim(),
                lastServiceDate: form.lastServiceDate,
                nextDueDate: form.nextDueDate,
                serviceProvider: form.serviceProvider.trim(),
                serviceCharges:
                    form.serviceCharges === ""
                        ? ""
                        : Number(form.serviceCharges),
                amcApplicable: form.amcApplicable,
                amcVendor:
                    form.amcApplicable === "Yes"
                        ? form.amcVendor.trim()
                        : "",
                amcStartDate:
                    form.amcApplicable === "Yes"
                        ? form.amcStartDate
                        : "",
                amcEndDate:
                    form.amcApplicable === "Yes"
                        ? form.amcEndDate
                        : "",
                amcCharges:
                    form.amcApplicable === "Yes" && form.amcCharges !== ""
                        ? Number(form.amcCharges)
                        : "",
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
                    moduleName: "Machinery",

                    renewalData: {
                        ...recordData,
                        ...documentFields,
                    },

                    actor: {
                        uid: auth.currentUser?.uid || "",
                        email: auth.currentUser?.email || "",
                        displayName: auth.currentUser?.displayName || "",
                    },
                });

                setNotice("Machinery record renewed successfully.");
            }
            else if (editingId) {
                await updateDoc(
                    doc(db, COLLECTION_NAME, editingId),
                    recordData
                );

                setNotice("Machinery record updated successfully.");
            }
            else {
                await addDoc(collection(db, COLLECTION_NAME), {
                    ...recordData,
                    createdAt: serverTimestamp(),
                });

                setNotice("Machinery record added successfully.");
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
            console.error("Machinery save error:", err);

            setFormError(
                err.code === "permission-denied"
                    ? "Permission denied. Please check Firestore security rules."
                    : "Machinery record could not be saved. Please try again."
            );
        } finally {
            setSaving(false);
        }
    }

    async function handleDelete(record) {
        if (!isSuperAdmin) {
            setError("Only Super Admin can delete Machinery records.");
            return;
        }

        const confirmed = window.confirm(
            `Are you sure you want to delete "${record.machineName || record.machineNo}"? This action cannot be undone.`
        );

        if (!confirmed) return;

        setDeletingId(record.id);
        setError("");
        setNotice("");

        try {
            await deleteDoc(doc(db, COLLECTION_NAME, record.id));

            setNotice("Machinery record deleted successfully.");
            window.setTimeout(() => setNotice(""), 3500);
        } catch (err) {
            console.error("Machinery delete error:", err);

            setError(
                err.code === "permission-denied"
                    ? "Permission denied. Check Firestore security rules."
                    : "Machinery record could not be deleted."
            );
        } finally {
            setDeletingId(null);
        }
    }
    const expiryOverview = [
        // SERVICE DUE
        {
            label: "Overdue",
            count: preparedRecords.filter((record) => {
                const days = getDays(getServiceDueDate(record));
                return days !== null && days < 0;
            }).length,
            style: "border-red-100 bg-red-50 text-red-700",
        },
        {
            label: "Next 10 Days",
            count: preparedRecords.filter((record) => {
                const days = getDays(getServiceDueDate(record));
                return days !== null && days >= 0 && days <= 10;
            }).length,
            style: "border-amber-100 bg-amber-50 text-amber-700",
        },
        {
            label: "Next 30 Days",
            count: preparedRecords.filter((record) => {
                const days = getDays(getServiceDueDate(record));
                return days !== null && days >= 0 && days <= 30;
            }).length,
            style: "border-blue-100 bg-blue-50 text-blue-700",
        },

        // AMC EXPIRY
        {
            label: "Overdue",
            count: preparedRecords.filter((record) => {
                if (!isAmcApplicable(record)) return false;

                const days = getDays(record.amcEndDate);
                return days !== null && days < 0;
            }).length,
            style: "border-red-100 bg-red-50 text-red-700",
        },
        {
            label: "Next 10 Days",
            count: preparedRecords.filter((record) => {
                if (!isAmcApplicable(record)) return false;

                const days = getDays(record.amcEndDate);
                return days !== null && days >= 0 && days <= 10;
            }).length,
            style: "border-amber-100 bg-amber-50 text-amber-700",
        },
        {
            label: "Next 30 Days",
            count: preparedRecords.filter((record) => {
                if (!isAmcApplicable(record)) return false;

                const days = getDays(record.amcEndDate);
                return days !== null && days >= 0 && days <= 30;
            }).length,
            style: "border-blue-100 bg-blue-50 text-blue-700",
        },
    ];
    const showAmcColumns = filteredRecords.some((record) =>
        isAmcApplicable(record)
    );

    const headings = [
        "S. No.",
        "Machine No.",
        "Machine Name",
        "Department",
        "Branch / Unit",
        "Last Service Date",
        "Next Due Date",
        "Service Provider / Company",
        "Service Charges",
        "AMC Applicable",

        ...(showAmcColumns
            ? [
                "AMC Company / Vendor",
                "AMC Charges",
                "AMC Start Date",
                "AMC End Date",
            ]
            : []),

        "Remarks",
        "Overall Status",
        "Actions",
    ];

    if (loading) {
        return (
            <main className="min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8">
                <div className="mx-auto max-w-[1600px]">
                    <p className="py-10 text-center text-sm text-slate-500">
                        Loading Machinery records...
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
                            Machinery Management
                        </h1>
                        <p className="mt-2 text-sm text-slate-500">
                            Manage machinery details and service schedules.
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
                                + Add Machinery Record
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
                        title="Total Machinery Records"
                        count={counts.total}
                        detail="All registered machinery"
                        color="bg-blue-600"
                    />
                    <SummaryCard
                        title="Active Machinery"
                        count={counts.active}
                        detail="All applicable dates have more than 10 days remaining"
                        color="bg-emerald-500"
                    />
                    <SummaryCard
                        title="Expiring Soon"
                        count={counts.expiring}
                        detail="Service or AMC due within the next 10 days"
                        color="bg-amber-500"
                    />
                    <SummaryCard
                        title="Expired Machinery"
                        count={counts.overdue}
                        detail="Service due date or AMC end date has passed"
                        color="bg-red-500"
                    />
                </div>

                <section className="mt-7 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 className="font-semibold text-slate-900">
                                Machinery Overview
                            </h2>
                            <p className="mt-1 text-sm text-slate-500">
                                Review machinery requiring service or AMC attention.
                            </p>
                        </div>
                        <span className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600">
                            Based on Current Date
                        </span>
                    </div>

                    {/* Service Due */}
                    <div className="mt-5">
                        <h3 className="mb-3 text-sm font-medium text-slate-700">
                            Service Due Overview
                        </h3>

                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                            {expiryOverview.slice(0, 3).map((item, index) => (
                                <div
                                    key={`service-${index}`}
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
                    </div>

                    {/* AMC Expiry */}
                    <div className="mt-6">
                        <h3 className="mb-3 text-sm font-medium text-slate-700">
                            AMC Expiry Overview
                        </h3>

                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                            {expiryOverview.slice(3, 6).map((item, index) => (
                                <div
                                    key={`amc-${index}`}
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
                    </div>
                </section>
                <section className="mt-7 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <div className="border-b border-slate-100 p-5">
                        <h2 className="font-semibold text-slate-900">
                            Machinery Records
                        </h2>

                        <p className="mt-1 text-sm text-slate-500">
                            {filteredRecords.length} of {preparedRecords.length} records
                        </p>

                        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                            <input
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder="Search machine, department, branch / unit..."
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
                                <option value="Expired">Expired</option>
                                <option value="Unknown">Unknown</option>
                            </select>

                            <select
                                value={amcFilter}
                                onChange={(event) => setAmcFilter(event.target.value)}
                                className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm"
                            >
                                <option value="All">All AMC records</option>
                                <option value="Yes">AMC Applicable</option>
                                <option value="No">No AMC</option>
                            </select>
                        </div>
                    </div>

                    <div className="overflow-x-auto">
                        <table
                            className={`w-full ${showAmcColumns ? "min-w-[2100px]" : "min-w-[1400px]"} text-left text-sm`}
                        >
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
                                            {record.machineNo || "—"}
                                        </td>

                                        <td className="whitespace-nowrap px-4 py-4">
                                            {record.machineName || "—"}
                                        </td>

                                        <td className="whitespace-nowrap px-4 py-4">
                                            {record.department || "—"}
                                        </td>

                                        <td className="whitespace-nowrap px-4 py-4">
                                            {record.unit || "—"}
                                        </td>

                                        <td className="whitespace-nowrap px-4 py-4">
                                            {formatDate(record.lastServiceDate)}
                                        </td>

                                        <td className="whitespace-nowrap px-4 py-4">
                                            {formatDate(record.serviceDueDate)}
                                        </td>

                                        <td className="whitespace-nowrap px-4 py-4">
                                            {record.serviceProvider || "—"}
                                        </td>

                                        <td className="whitespace-nowrap px-4 py-4">
                                            {money(record.serviceCharges)}
                                        </td>

                                        <td className="whitespace-nowrap px-4 py-4">
                                            {isAmcApplicable(record) ? "Yes" : "No"}
                                        </td>

                                        {showAmcColumns && (
                                            <>
                                                <td className="whitespace-nowrap px-4 py-4">
                                                    {isAmcApplicable(record)
                                                        ? record.amcVendor || "—"
                                                        : "—"}
                                                </td>

                                                <td className="whitespace-nowrap px-4 py-4">
                                                    {isAmcApplicable(record)
                                                        ? money(record.amcCharges)
                                                        : "—"}
                                                </td>

                                                <td className="whitespace-nowrap px-4 py-4">
                                                    {isAmcApplicable(record)
                                                        ? formatDate(record.amcStartDate)
                                                        : "—"}
                                                </td>

                                                <td className="whitespace-nowrap px-4 py-4">
                                                    {isAmcApplicable(record)
                                                        ? formatDate(record.amcEndDate)
                                                        : "—"}
                                                </td>
                                            </>
                                        )}
                                        <td className="min-w-[200px] max-w-[350px] px-4 py-4">
                                            <div className="whitespace-normal break-words text-slate-600">
                                                {record.remarks?.trim() || "—"}
                                            </div>
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-4">
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
                                                            const newTab = window.open("", "_blank");

                                                            if (!newTab) {
                                                                alert("Please allow pop-ups for this application.");
                                                                return;
                                                            }

                                                            newTab.location.href = record.documentData;
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
                                ))}

                                {filteredRecords.length === 0 && (
                                    <tr>
                                        <td
                                            colSpan={headings.length}
                                            className="px-5 py-12 text-center"
                                        >
                                            <p className="font-medium text-slate-700">
                                                No Machinery records found
                                            </p>
                                            <p className="mt-1 text-xs text-slate-500">
                                                {preparedRecords.length === 0
                                                    ? "Use Add Machinery to create the first entry."
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
            {/* Add / Edit Machinery Form */}
            {showForm && canEditRecords && (
                <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/50 p-4">
                    <div className="my-auto max-h-[94vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
                        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
                            <div>
                                <h2 className="text-lg font-bold text-slate-900">
                                    {renewingId
                                        ? "Renew Machinery Record"
                                        : editingId
                                            ? "Edit Machinery Record"
                                            : "Add Machinery"}
                                </h2>
                                <p className="mt-1 text-sm text-slate-500">
                                    Enter machinery and maintenance details.
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
                                Machine No. *
                                <input
                                    required
                                    name="machineNo"
                                    value={form.machineNo}
                                    onChange={updateForm}
                                    placeholder="Enter machine number"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Machine Name *
                                <input
                                    required
                                    name="machineName"
                                    value={form.machineName}
                                    onChange={updateForm}
                                    placeholder="Enter machine name"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Department *
                                <input
                                    required
                                    name="department"
                                    value={form.department}
                                    onChange={updateForm}
                                    placeholder="Enter department"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Branch / Unit *
                                <input
                                    required
                                    name="unit"
                                    value={form.unit}
                                    onChange={updateForm}
                                    placeholder="Enter unit"
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
                                    name="nextDueDate"
                                    value={form.nextDueDate}
                                    onChange={updateForm}
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Service Provider / Company
                                <input
                                    name="serviceProvider"
                                    value={form.serviceProvider}
                                    onChange={updateForm}
                                    placeholder="Enter service provider or company"
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
                                AMC Applicable *
                                <select
                                    required
                                    name="amcApplicable"
                                    value={form.amcApplicable}
                                    onChange={(event) => {
                                        const value = event.target.value;

                                        setForm((current) => ({
                                            ...current,
                                            amcApplicable: value,
                                            ...(value === "No"
                                                ? {
                                                    amcVendor: "",
                                                    amcStartDate: "",
                                                    amcEndDate: "",
                                                    amcCharges: "",
                                                }
                                                : {}),
                                        }));
                                    }}
                                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-normal"
                                >
                                    <option value="Yes">Yes</option>
                                    <option value="No">No</option>
                                </select>
                            </label>

                            {form.amcApplicable === "Yes" && (
                                <>
                                    <div className="sm:col-span-2">
                                        <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4">
                                            <h3 className="font-semibold text-slate-800">
                                                AMC Details
                                            </h3>
                                            <p className="mt-1 text-xs text-slate-500">
                                                Enter AMC information for this machinery.
                                            </p>

                                            <div className="mt-4 grid gap-4 sm:grid-cols-2">
                                                <label className="text-sm font-medium text-slate-700">
                                                    AMC Company / Vendor *
                                                    <input
                                                        required
                                                        name="amcVendor"
                                                        value={form.amcVendor}
                                                        onChange={updateForm}
                                                        placeholder="Enter AMC company"
                                                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-normal"
                                                    />
                                                </label>

                                                <label className="text-sm font-medium text-slate-700">
                                                    AMC Charges (₹)
                                                    <input

                                                        type="number"
                                                        min="0"
                                                        step="0.01"
                                                        name="amcCharges"
                                                        value={form.amcCharges}
                                                        onChange={updateForm}
                                                        placeholder="Enter AMC charges"
                                                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-normal"
                                                    />
                                                </label>

                                                <label className="text-sm font-medium text-slate-700">
                                                    AMC Start Date
                                                    <input

                                                        type="date"
                                                        name="amcStartDate"
                                                        value={form.amcStartDate}
                                                        onChange={updateForm}
                                                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-normal"
                                                    />
                                                </label>

                                                <label className="text-sm font-medium text-slate-700">
                                                    AMC End Date
                                                    <input

                                                        type="date"
                                                        min={form.amcStartDate || undefined}
                                                        name="amcEndDate"
                                                        value={form.amcEndDate}
                                                        onChange={updateForm}
                                                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-normal"
                                                    />
                                                </label>
                                            </div>
                                        </div>
                                    </div>
                                </>
                            )}

                            <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4 sm:col-span-2">
                                <label className="block text-sm font-semibold text-slate-800">
                                    Document Upload
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
                                                    const newTab = window.open("", "_blank");
                                                    if (newTab) {
                                                        newTab.location.href =
                                                            existingDocument.data;
                                                    } else {
                                                        alert("Please allow pop-ups for this application.");
                                                    }
                                                }}
                                                className="rounded-lg border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                                            >
                                                View
                                            </button>
                                        )}

                                        <label
                                            className="inline-flex cursor-pointer items-center rounded-lg px-3 py-2 text-xs font-semibold text-white hover:opacity-90"
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
                    moduleName="Machinery"
                    onClose={() => setShowRenewalHistory(false)}
                />
            )}
        </main>
    );
}