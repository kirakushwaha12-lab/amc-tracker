
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
import {
    recognizeDocumentImage,
    extractDocumentFields,
    mergeExtractedFields,
} from "../../lib/document-ocr";

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


function extractPucFields(text) {
    const normalized = String(text ?? "")
        .replace(/\r/g, "\n")
        .replace(/[ \t]+/g, " ");

    const fields = {};

    function parseDate(value) {
        const dateText = String(value ?? "").trim();

        const namedMonth = dateText.match(
            /^(\d{1,2})[\/.\-\s]([A-Za-z]{3,9})[\/.\-\s](\d{4})$/i
        );

        if (namedMonth) {
            const months = {
                jan: 1, january: 1,
                feb: 2, february: 2,
                mar: 3, march: 3,
                apr: 4, april: 4,
                may: 5,
                jun: 6, june: 6,
                jul: 7, july: 7,
                aug: 8, august: 8,
                sep: 9, sept: 9, september: 9,
                oct: 10, october: 10,
                nov: 11, november: 11,
                dec: 12, december: 12,
            };

            const day = Number(namedMonth[1]);
            const month = months[namedMonth[2].toLowerCase()];
            const year = Number(namedMonth[3]);

            if (month) {
                const date = new Date(year, month - 1, day);

                if (
                    date.getFullYear() === year &&
                    date.getMonth() === month - 1 &&
                    date.getDate() === day
                ) {
                    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                }
            }
        }

        const numeric = dateText.match(
            /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/
        );

        if (numeric) {
            const day = Number(numeric[1]);
            const month = Number(numeric[2]);
            const year = Number(numeric[3]);
            const date = new Date(year, month - 1, day);

            if (
                date.getFullYear() === year &&
                date.getMonth() === month - 1 &&
                date.getDate() === day
            ) {
                return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            }
        }

        return "";
    }

    // Vehicle Registration Number
    const vehicleMatch = normalized.match(
        /\b([A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{4})\b/i
    );

    if (vehicleMatch) {
        fields.vehicleNo = vehicleMatch[1]
            .replace(/\s+/g, "")
            .toUpperCase();
    }

    // Fuel Type
    const fuelMatch = normalized.match(
        /\b(DIESEL|PETROL|CNG|LPG)\b/i
    );

    if (fuelMatch) {
        const fuel = fuelMatch[1].toUpperCase();

        fields.fuelType =
            fuel === "DIESEL" ? "Diesel" :
                fuel === "PETROL" ? "Petrol" : fuel;
    }

    // Registration Date
    const registrationMatch = normalized.match(
        /D[a-z]{0,3}te\s+of\s+Registration[\s\S]{0,100}?(\d{1,2}[\/.\-\s](?:[A-Za-z]{3,9}|\d{1,2})[\/.\-\s]\d{4})/i
    );

    if (registrationMatch) {
        const date = parseDate(registrationMatch[1]);
        if (date) fields.registrationDate = date;
    }

    // Certificate Date: specifically read the header Date label
    const certificateDateMatch = normalized.match(
        /^\s*Date\s*:\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4})/im
    );

    if (certificateDateMatch) {
        const date = parseDate(certificateDateMatch[1]);
        if (date) fields.certificateDate = date;
    }

    // Expiry Date
    const validityMatch = normalized.match(
        /validity\s*(?:up\s*to|upto|till|until)\s*:\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4})/i
    );

    if (validityMatch) {
        const date = parseDate(validityMatch[1]);
        if (date) fields.expiryDate = date;
    }

    // PUC Code
    const pucCodeMatch = normalized.match(
        /(?:P|R)\s*U\s*C\s*Code[\s\S]{0,45}?\b([A-Z]{2}\d{5,10})\b/i
    );

    if (pucCodeMatch) {
        fields.pucCode = pucCodeMatch[1].toUpperCase();
    }

    // Certificate Serial Number
    const certificateMatch = normalized.match(
        /Certificate\s*(?:SL|S\.?L\.?|Serial)\s*\.?\s*No\.?\s*:\s*([A-Z0-9]{8,25})/i
    );

    if (certificateMatch) {
        fields.certificateNo = certificateMatch[1].toUpperCase();
    }

    // Amount: Fees Rs.100.00 / INR 100 / ₹100
    const feesMatch = normalized.match(
        /\bFees\s*:\s*(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i
    );

    if (feesMatch) {
        const amount = Number(feesMatch[1].replace(/,/g, ""));

        if (Number.isFinite(amount)) {
            fields.amount = String(amount);
        }
    }

    // PUC Centre: detect centre name near the end of certificate
    const centreMatch = normalized.match(
        /\b([A-Z][A-Z0-9&.' -]{1,50}\bPUC\s+(?:CENTRE|CENTER))\b/i
    );

    if (centreMatch) {
        fields.pucCentre = centreMatch[1]
            .replace(/\s+/g, " ")
            .trim();
    }

    return fields;
}


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
    const [selectedDocument, setSelectedDocument] = useState(null);
    const [existingDocument, setExistingDocument] = useState(null);
    const [ocrStatus, setOcrStatus] = useState("");

    const MAX_DOCUMENT_SIZE = 500 * 1024;

    const ALLOWED_DOCUMENT_TYPES = [
        "application/pdf",
        "image/jpeg",
        "image/png",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];

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

                        const pollutionRecords = allRecords.filter(
                            (record) =>
                                record.category === "Vehicles" &&
                                record.type === "Pollution"
                        );

                        pollutionRecords.sort((a, b) => {
                            const dateA = a.expiryDate || a.endDate || "9999-12-31";
                            const dateB = b.expiryDate || b.endDate || "9999-12-31";

                            return dateA.localeCompare(dateB);
                        });

                        setRecords(pollutionRecords);

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


    async function compressImageIfNeeded(file) {
        const isImage = ["image/jpeg", "image/png"].includes(file.type);


        if (!isImage) {
            return file;
        }

        // Images smaller than 100 KB do not need compression.
        if (file.size <= 100 * 1024) {
            return file;
        }

        const options = {
            maxSizeMB: 0.2,
            maxWidthOrHeight: 1600,
            useWebWorker: true,
            fileType: file.type,
        };

        try {
            const compressedFile = await imageCompression(file, options);

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
        setOcrStatus("");

        if (!file) return;


        const formElement = input.form;

        const allowed = ["pdf", "jpg", "jpeg", "png", "doc", "docx"];
        const extension = file.name.split(".").pop()?.toLowerCase();

        if (!allowed.includes(extension)) {
            setFormError("Only PDF, JPG, JPEG, PNG, DOC and DOCX files are allowed.");
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

            if (!["jpg", "jpeg", "png", "pdf"].includes(extension)) {
                setOcrStatus("Document uploaded. OCR is not supported for DOC/DOCX.");
                return;
            }

            if (!formElement) {
                setOcrStatus("Document uploaded. Form could not be detected for OCR.");
                return;
            }

            setOcrStatus("Reading document...");

            const rawText = await recognizeDocumentImage(finalFile);

            // Shared field extraction
            const commonFields = extractDocumentFields(
                rawText,
                formElement
            );

            // PUC-specific extraction remains available
            const pucFields = extractPucFields(rawText);

            setForm((previous) => {
                const commonResult = mergeExtractedFields(
                    previous,
                    commonFields
                );

                const pucResult = mergeExtractedFields(
                    commonResult.form,
                    pucFields
                );

                return {
                    ...pucResult.form,
                    fuelType:
                        pucFields.fuelType ||
                        commonResult.form.fuelType ||
                        previous.fuelType,
                };
            });

            const extractedCount = Object.keys({
                ...commonFields,
                ...pucFields,
            }).length;

            setOcrStatus(
                extractedCount > 0
                    ? "Document read successfully. Please verify the extracted fields."
                    : "Document uploaded, but no matching fields were detected. Please enter details manually."
            );

        } catch (error) {
            console.error("Pollution OCR error:", error);

            setOcrStatus(
                `Document uploaded, but OCR could not read it: ${error.message}`
            );
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
            setError("You do not have permission to add Pollution records.");
            return;
        }

        setEditingId(null);
        setForm({ ...initialForm });
        setSelectedDocument(null);
        setExistingDocument(null);
        setOcrStatus("");
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

        setSelectedDocument(null);

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

    function normalizeFuelType(value) {
        if (!value) return "";

        const fuel = value.trim().toLowerCase();

        const fuelTypes = {
            diesel: "Diesel",
            petrol: "Petrol",
            cng: "CNG",
            lpg: "LPG",
            "petrol/cng": "Petrol/CNG",
            other: "Other",
        };

        return fuelTypes[fuel] || value.trim();
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

        let documentFields = {};

        try {
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
            } else if (existingDocument) {
                documentFields = {
                    documentData: existingDocument.data,
                    documentName: existingDocument.name,
                    documentSize: existingDocument.size,
                    documentType: existingDocument.type,
                };
            }
        } catch (err) {
            setFormError(err.message || "Document could not be read.");
            setSaving(false);
            return;
        }
        const shouldRemoveDocument =
            Boolean(editingId) && !selectedDocument && !existingDocument;
        const recordData = {
            category: "Vehicles",
            type: "Pollution",
            vehicleNo: form.vehicleNo.trim().toUpperCase(),
            certificateNo: form.certificateNo.trim(),
            pucCode: form.pucCode.trim(),
            fuelType: normalizeFuelType(form.fuelType),
            registrationDate: form.registrationDate,
            certificateDate: form.certificateDate,
            expiryDate: form.expiryDate,
            pucCentre: form.pucCentre.trim(),
            amount: form.amount === "" ? "" : Number(form.amount),
            remarks: form.remarks.trim(),
            ...documentFields,
            updatedAt: serverTimestamp(),
        };

        if (shouldRemoveDocument) {
            recordData.documentData = deleteField();
            recordData.documentName = deleteField();
            recordData.documentSize = deleteField();
            recordData.documentType = deleteField();
        }
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
            setSelectedDocument(null);
            setExistingDocument(null);
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
            `Are you sure you want to delete the Pollution record for "${record.vehicleNo || "this vehicle"
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


                                                    {record.documentData && (
                                                        <button
                                                            type="button"
                                                            onClick={async () => {
                                                                const newTab = window.open("about:blank", "_blank");

                                                                if (!newTab) {
                                                                    alert("Please allow pop-ups for this application.");
                                                                    return;
                                                                }

                                                                try {
                                                                    const response = await fetch(record.documentData);
                                                                    const blob = await response.blob();
                                                                    const fileUrl = URL.createObjectURL(blob);

                                                                    newTab.location.href = fileUrl;

                                                                    window.setTimeout(() => {
                                                                        URL.revokeObjectURL(fileUrl);
                                                                    }, 60000);
                                                                } catch (error) {
                                                                    newTab.close();
                                                                    alert("Unable to open the document. Please try again.");
                                                                    console.error("Document preview error:", error);
                                                                }
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
                <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/50 p-4">
                    <div className="my-auto max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
                        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
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
                                    data-ocr-aliases="Vehicle No|Vehicle Number|Registration No|Registration Number|Vehicle Registration Mark"
                                    value={form.vehicleNo}
                                    onChange={updateForm}
                                    placeholder="e.g. UP******"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Certificate No. *
                                <input
                                    required
                                    name="certificateNo"
                                    data-ocr-aliases="Certificate No|Certificate Number|PUC Certificate No|Serial No|Serial Number|Certificate Serial Number"
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
                                    data-ocr-aliases="PUC Code|PUC ID|PUC Centre Code|Pollution Code"
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
                                    data-ocr-aliases="Fuel Type|Type of Fuel|Fuel"
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
                                    data-ocr-aliases="Registration Date|Date of Registration|Vehicle Registration Date"
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
                                    data-ocr-aliases="Certificate Date|Test Date|Inspection Date|Date of Test|Testing Date|Issue Date"
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
                                    data-ocr-aliases="Expiry Date|Certificate Expiry Date|Validity Upto|Validity Up To|Valid Until|Valid Till|PUC Validity"
                                    value={form.expiryDate}
                                    onChange={updateForm}
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                PUC Centre
                                <input
                                    name="pucCentre"
                                    data-ocr-aliases="PUC Centre|PUC Center|Testing Centre|Testing Center|Emission Testing Centre|Emission Testing Center|Authorised Centre"
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
                                    data-ocr-aliases="Testing Fees|PUC Fees|Certificate Fees|Amount Paid|Fee"
                                    value={form.amount}
                                    onChange={updateForm}
                                    placeholder="Enter amount (optional)"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                />
                            </label>



                            <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4 sm:col-span-2">
                                <label className="block text-sm font-semibold text-slate-800">
                                    Pollution Certificate Document
                                    <span className="ml-2 font-normal text-slate-500">
                                        (Optional)
                                    </span>
                                </label>

                                <p className="mt-1 text-xs text-slate-500">
                                    PDF, JPG, PNG, DOC or DOCX · Maximum 500 KB
                                </p>

                                {existingDocument && (
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
                                                    const imageWindow = window.open("", "_blank");

                                                    if (!imageWindow) {
                                                        alert("Please allow pop-ups for this application.");
                                                        return;
                                                    }

                                                    imageWindow.document.title =
                                                        existingDocument.name || "Document";

                                                    imageWindow.document.body.style.margin = "0";
                                                    imageWindow.document.body.style.display = "flex";
                                                    imageWindow.document.body.style.justifyContent = "center";
                                                    imageWindow.document.body.style.alignItems = "center";
                                                    imageWindow.document.body.style.minHeight = "100vh";
                                                    imageWindow.document.body.style.backgroundColor = "#f1f5f9";

                                                    if (existingDocument.type?.startsWith("image/")) {
                                                        const image = imageWindow.document.createElement("img");
                                                        image.src = existingDocument.data;
                                                        image.alt = existingDocument.name || "Uploaded document";
                                                        image.style.maxWidth = "100%";
                                                        image.style.maxHeight = "100vh";
                                                        image.style.objectFit = "contain";
                                                        imageWindow.document.body.appendChild(image);
                                                    } else {
                                                        imageWindow.location.href = existingDocument.data;
                                                    }
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
                                            }}
                                            className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50"
                                        >
                                            Remove
                                        </button>
                                    </div>
                                )}

                                {!existingDocument && (
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

                                {ocrStatus && (
                                    <p
                                        className="mt-2 text-sm text-blue-700"
                                        aria-live="polite"
                                    >
                                        {ocrStatus}
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
