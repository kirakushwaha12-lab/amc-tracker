
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
import {
    extractDocumentFields,
    mergeExtractedFields,
} from "../../lib/document-ocr";

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

const MAX_DOCUMENT_SIZE = 500 * 1024;

const ALLOWED_DOCUMENT_EXTENSIONS = [
    "pdf",
    "jpg",
    "jpeg",
    "png",
    "doc",
    "docx",
];

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
    });

    return compressedFile.size < file.size ? compressedFile : file;
}

function readDocumentAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => resolve(reader.result);
        reader.onerror = () =>
            reject(new Error("Document could not be read."));

        reader.readAsDataURL(file);
    });
}

async function openSavedDocument(dataUrl) {
    if (!dataUrl) return;

    const newWindow = window.open("about:blank", "_blank");

    if (!newWindow) {
        alert("Please allow pop-ups to view the document.");
        return;
    }

    try {
        const response = await fetch(dataUrl);
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);

        newWindow.location.href = objectUrl;

        window.setTimeout(() => {
            URL.revokeObjectURL(objectUrl);
        }, 60000);
    } catch (error) {
        console.error("Document open error:", error);
        newWindow.close();
        alert("Document could not be opened.");
    }
}

function formatDocumentSize(size) {
    if (!Number.isFinite(Number(size)) || Number(size) <= 0) {
        return "";
    }

    return `${(Number(size) / 1024).toFixed(0)} KB`;
}


function extractAmcFallbackFields(rawText) {
    const text = String(rawText || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/\r/g, "\n");

    const lines = text
        .split("\n")
        .map(line => line.replace(/\s+/g, " ").trim())
        .filter(Boolean);

    const result = {};

    const datePattern =
        /\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b|\b\d{1,2}[-\s](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\s]\d{2,4}\b/gi;

    function parseDate(value) {
        const match = String(value ?? "").match(datePattern);
        if (!match) return "";

        const raw = match[0];
        const numeric = raw.match(
            /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/
        );

        if (numeric) {
            let year = Number(numeric[3]);
            if (year < 100) year += 2000;

            const day = Number(numeric[1]);
            const month = Number(numeric[2]);

            if (month < 1 || month > 12 || day < 1 || day > 31) {
                return "";
            }

            return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        }

        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) return "";

        return [
            parsed.getFullYear(),
            String(parsed.getMonth() + 1).padStart(2, "0"),
            String(parsed.getDate()).padStart(2, "0"),
        ].join("-");
    }

    function getAmount(value) {
        const match = String(value ?? "").match(
            /(?:₹|Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i
        );

        if (!match) return null;

        const amount = Number(match[1].replace(/,/g, ""));
        return Number.isFinite(amount) ? amount : null;
    }

    // 1. Service / contract period
    for (const line of lines) {
        if (
            !/\b(period|validity|valid from|valid to|coverage|service period|contract period|commencement|effective|duration)\b/i.test(line)
        ) {
            continue;
        }

        const dates = line.match(datePattern) || [];

        if (dates.length >= 2) {
            result.startDate = parseDate(dates[0]);
            result.endDate = parseDate(dates[1]);
            break;
        }
    }

    // 2. Generic table extraction
    const tableLines = lines.filter(line => line.includes("|"));

    for (let i = 0; i < tableLines.length; i++) {
        const headerCells = tableLines[i]
            .split("|")
            .map(cell => cell.trim());

        const descriptionIndex = headerCells.findIndex(cell =>
            /\b(description|particulars|item details|product details|goods description)\b/i.test(cell)
        );

        const amountIndex = headerCells.findIndex(cell =>
            /^\s*(?:amount|line amount|line total)\s*$/i.test(cell)
        );

        const rateIndex = headerCells.findIndex(cell =>
            /^\s*(?:rate|unit price)\s*$/i.test(cell)
        );

        if (descriptionIndex < 0) continue;

        for (let j = i + 1; j < tableLines.length; j++) {
            const row = tableLines[j]
                .split("|")
                .map(cell =>
                    cell.replace(/<[^>]*>/g, " ")
                        .replace(/\s+/g, " ")
                        .trim()
                );

            if (row.every(cell => !cell)) continue;
            if (row.some(cell => /^:?-{2,}:?$/.test(cell))) continue;

            // Description column only — never quantity or rate columns.
            const description = String(
                row[descriptionIndex] ?? ""
            ).replace(/\s+/g, " ").trim();

            if (description && !result.productName) {
                const candidates = description
                    .split(/\n/)
                    .map(value => value.trim())
                    .filter(Boolean);

                let product = "";

                for (const candidate of candidates) {
                    const cleaned = candidate
                        .replace(/<[^>]*>/g, " ")
                        .replace(/\s+/g, " ")
                        .replace(/^[\d.)\s-]+/, "")
                        .replace(/^(?:servicing\s*&\s*maintenance|servicing\s+and\s+maintenance)\s*/i, "")
                        .replace(/^(?:AMC|CMC)(?:\s*\/\s*(?:AMC|CMC))?\s*(?:FOR|OF)\s*/i, "")
                        .replace(/\b(?:all parts covered|including|excluding)\b.*$/i, "")
                        .replace(/\b(?:period|validity)\b.*$/i, "")
                        .trim();

                    if (
                        cleaned &&
                        /[a-z]{2,}/i.test(cleaned) &&
                        !/^(?:AMC|CMC|servicing|maintenance)$/i.test(cleaned)
                    ) {
                        product = cleaned;
                        break;
                    }
                }

                if (product) {
                    result.productName = product;
                }
            }

            const amountCell = String(
                amountIndex >= 0 ? row[amountIndex] ?? "" : ""
            );

            const rateCell = String(
                rateIndex >= 0 ? row[rateIndex] ?? "" : ""
            );

            const rowAmount = getAmount(amountCell);
            const rowRate = getAmount(rateCell);

            if (rowAmount !== null && result.cost === undefined) {
                result.cost = String(rowAmount);
            } else if (rowRate !== null && result.cost === undefined) {
                result.cost = String(rowRate);
            }

            // Stop after the first populated item row.
            if (description) break;
        }

        break;
    }

    // 3. Explicit final payable / grand total has highest priority.
    const totalPatterns = [
        /(?:grand\s*total|net\s*payable|amount\s*payable|total\s*payable|invoice\s*total|total\s*amount|amount\s*chargeable)\s*[:\-]?\s*(?:₹|Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i,
        /(?:total)\s*[:\-]?\s*(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i,
    ];

    for (const pattern of totalPatterns) {
        const match = text.match(pattern);

        if (match) {
            const amount = getAmount(match[1]);

            if (amount !== null) {
                result.cost = String(amount);
                break;
            }
        }
    }

    // 4. If explicit final total is absent, use base amount + clearly labelled taxes.
    // Do not calculate tax unless the tax labels and amounts are actually detected.
    if (!totalPatterns.some(pattern => pattern.test(text))) {
        const taxAmounts = [];
        const taxPattern =
            /\b(?:CGST|SGST|IGST|GST)\b[^\d₹]{0,30}(?:₹|Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)/gi;

        let taxMatch;

        while ((taxMatch = taxPattern.exec(text)) !== null) {
            const amount = getAmount(taxMatch[1]);
            if (amount !== null) taxAmounts.push(amount);
        }

        const hasBaseAmount = result.cost !== undefined;
        const hasTaxLabels = /\b(?:CGST|SGST|IGST|GST)\b/i.test(text);

        if (hasBaseAmount && taxAmounts.length > 0 && hasTaxLabels) {
            const totalTax = taxAmounts.reduce((sum, value) => sum + value, 0);
            result.cost = String(Number(result.cost) + totalTax);
        }
    }

    return result;
}


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
    const [selectedDocument, setSelectedDocument] = useState(null);
    const [existingDocument, setExistingDocument] = useState(null);
    const [ocrStatus, setOcrStatus] = useState("");
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

                        const amcRecords = allRecords.filter(
                            (record) =>
                                (record.category === "IT Devices" &&
                                    record.type === "AMC") ||
                                (record.category === "AMC" && !record.type)
                        );

                        amcRecords.sort((a, b) => {
                            const dateA = a.endDate || a.expiryDate || "9999-12-31";
                            const dateB = b.endDate || b.expiryDate || "9999-12-31";

                            return dateA.localeCompare(dateB);
                        });

                        setRecords(amcRecords);

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
                const endDate =
                    record.endDate || record.expiryDate || "";

                const productName =
                    record.productName || record.product || "";

                const vendor =
                    record.vendor || record.company || "";

                const cost =
                    record.cost !== "" && record.cost != null
                        ? record.cost
                        : record.charges ?? "";

                return {
                    ...record,
                    productName,
                    productId: record.productId ?? "",
                    vendor,
                    startDate: record.startDate || "",
                    endDate,
                    cost,
                    branchUnit: record.branchUnit || "",
                    remarks: record.remarks || "",
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
        setSelectedDocument(null);
        setExistingDocument(null);
        setFormError("");
        setOcrStatus("");
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

        // Load the existing uploaded document into the edit form.
        setSelectedDocument(null);

        setExistingDocument(
            record.documentData
                ? {
                    documentData: record.documentData,
                    documentName: record.documentName || "Saved document",
                    documentSize: record.documentSize || 0,
                    documentType: record.documentType || "",
                }
                : null
        );

        setFormError("");
        setOcrStatus("");
        setNotice("");
        setError("");
        setShowForm(true);
    }


    function updateForm(event) {
        const { name, value } = event.target;
        setForm((current) => ({ ...current, [name]: value }));
    }

    async function handleDocumentChange(event) {
        const input = event.target;
        const file = input.files?.[0];

        input.value = "";

        if (!file) return;

        setFormError("");
        setOcrStatus("");
        setSelectedDocument(null);

        const extension = getDocumentExtension(file.name);

        if (!ALLOWED_DOCUMENT_EXTENSIONS.includes(extension)) {
            setFormError(
                "Only PDF, JPG, JPEG, PNG, DOC and DOCX files are allowed."
            );
            return;
        }

        try {
            let processedFile = file;

            if (["jpg", "jpeg", "png"].includes(extension)) {
                processedFile = await compressImageIfNeeded(file);
            }

            if (processedFile.size > MAX_DOCUMENT_SIZE) {
                setFormError(
                    "Document size must be 500 KB or less. Please choose a smaller file."
                );
                return;
            }

            // Retain the selected document even if OCR processing fails.
            setSelectedDocument(processedFile);

            const ocrSupported = ["jpg", "jpeg", "png", "pdf"].includes(
                getDocumentExtension(processedFile.name)
            );

            if (!ocrSupported) {
                setOcrStatus(
                    "Document selected. OCR is available for JPG, PNG and PDF files. You can enter details manually."
                );
                return;
            }

            setOcrStatus("Reading AMC document...");

            try {
                console.log("Original file:", file.name, file.type);
                console.log("Processed file:", processedFile.name, processedFile.type);
                const ocrFormData = new FormData();

                ocrFormData.append(
                    "file",
                    processedFile,
                    processedFile.name
                );

                const ocrResponse = await fetch("/api/ocr", {
                    method: "POST",
                    body: ocrFormData,
                });

                const ocrData = await ocrResponse.json();

                if (!ocrResponse.ok || !ocrData.success) {
                    throw new Error(
                        ocrData.error || "AMC document OCR failed."
                    );
                }

                const rawText = ocrData.text || "";
                console.log("========== AMC RAW OCR TEXT ==========");
                console.log(rawText);
                console.log("======================================");


                if (!rawText || !rawText.trim()) {
                    setOcrStatus(
                        "Document selected, but no readable text was detected. You can enter details manually."
                    );
                    return;
                }

                if (!input.form) {
                    throw new Error("AMC form could not be identified.");
                }
                const commonExtracted = extractDocumentFields(rawText, input.form);
                const fallbackExtracted = extractAmcFallbackFields(rawText);

                // Prioritize values extracted by the common OCR engine.
                // Use fallback extraction only for fields not detected by the common OCR engine.
                const extracted = {
                    ...commonExtracted,
                    ...Object.fromEntries(
                        Object.entries(fallbackExtracted).filter(
                            ([key, value]) =>
                                !String(commonExtracted[key] ?? "").trim() &&
                                String(value ?? "").trim() !== ""
                        )
                    ),
                };

                console.log("AMC COMMON OCR:", commonExtracted);
                console.log("AMC FALLBACK OCR:", fallbackExtracted);
                console.log("AMC FINAL OCR:", extracted);

                setForm((current) => {
                    const result = mergeExtractedFields(current, extracted);
                    return result.form;
                });

                const detectedCount = Object.values(extracted).filter(
                    (value) => String(value ?? "").trim() !== ""
                ).length;

                setOcrStatus(
                    detectedCount > 0
                        ? `${detectedCount} field(s) detected. Please review the extracted details before saving.`
                        : "Document read, but no matching form fields were detected. You can enter details manually."
                );
            } catch (ocrError) {
                console.error("AMC OCR error:", ocrError);

                setOcrStatus(
                    "Document selected, but OCR could not read it. You can enter the details manually."
                );
            }
        } catch (err) {
            console.error("AMC document processing error:", err);

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


        let documentFields = {};

        try {
            if (selectedDocument) {
                const documentData = await readDocumentAsDataUrl(selectedDocument);

                documentFields = {
                    documentData,
                    documentName: selectedDocument.name,
                    documentSize: selectedDocument.size,
                    documentType:
                        selectedDocument.type ||
                        (getDocumentExtension(selectedDocument.name) === "pdf"
                            ? "application/pdf"
                            : ""),
                };
            } else if (existingDocument?.documentData) {
                documentFields = {
                    documentData: existingDocument.documentData,
                    documentName: existingDocument.documentName,
                    documentSize: existingDocument.documentSize || 0,
                    documentType: existingDocument.documentType || "",
                };
            } else if (editingId) {
                documentFields = {
                    documentData: deleteField(),
                    documentName: deleteField(),
                    documentSize: deleteField(),
                    documentType: deleteField(),
                };
            }
        } catch (err) {
            console.error("AMC document preparation error:", err);
            setFormError("Document could not be prepared. Please try again.");
            setSaving(false);
            return;
        }
        try {
            if (editingId) {
                await updateDoc(
                    doc(db, "it_devices", editingId),
                    {
                        ...recordData,
                        ...documentFields,
                    }
                );
                setNotice("AMC record updated successfully.");
            } else {
                await addDoc(collection(db, "it_devices"), {
                    ...recordData,
                    ...documentFields,
                    createdAt: serverTimestamp(),
                });
                setNotice("AMC record saved successfully.");
            }

            setShowForm(false);
            setForm(initialForm);
            setEditingId(null);
            setFormError("");
            setOcrStatus("");
            setSelectedDocument(null);
            setExistingDocument(null);

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
            `Are you sure you want to delete "${record.productName || "this AMC record"
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
                                                    {record.documentData && (
                                                        <button
                                                            type="button"
                                                            onClick={() => openSavedDocument(record.documentData)}
                                                            className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                                                        >
                                                            View Doc
                                                        </button>
                                                    )}
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
                                    data-ocr-aliases="Equipment Name|Item Description|Product|Machine Name|Asset Description|Description of Goods|Servicing & Maintenance|AMC/CMC|UPS|Equipment Description"
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
                                    data-ocr-aliases="Serial Number|Serial No|Asset ID|Equipment ID|Machine ID|Model Number|Product Code|Item Code"
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
                                    data-ocr-aliases="Supplier (Bill from)|Bill From|Supplier Name|Vendor Name|Service Provider|AMC Provider|Service Agency|Company Name|Supplier"
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
                                    data-ocr-aliases="Service Start Date|AMC Start Date|Contract Start Date|Valid From|Period From|AMC Period From|Service Period From|Contract Period From"
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
                                    data-ocr-aliases="Service End Date|AMC End Date|Contract End Date|Valid To|Period To|AMC Period To|Service Period To|Contract Period To"
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
                                    data-ocr-aliases="AMC Charges|AMC Amount|Annual Maintenance Charges|Contract Amount|Total Charges|Rate|Basic Amount|AMC/CMC Charges|Service Charges"
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
                                    data-ocr-aliases="Branch Name|Unit Name|Location|Site"
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
                                    AMC Document (optional) <span className="ml-2 font-normal text-slate-500">(Optional)</span>
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
                                                onClick={() => openSavedDocument(existingDocument.documentData)}
                                                className="rounded-lg border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                                            >
                                                View
                                            </button>
                                        )}

                                        <label className="inline-flex cursor-pointer items-center rounded-lg px-3 py-2 text-xs font-semibold text-white"
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
                                            {selectedDocument ? selectedDocument.name : "No file chosen"}
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
                                        className={`mt-3 rounded-lg p-3 text-xs ${ocrStatus.startsWith("Reading")
                                            ? "bg-blue-50 text-blue-700"
                                            : ocrStatus.includes("detected")
                                                ? "bg-emerald-50 text-emerald-700"
                                                : "bg-amber-50 text-amber-700"
                                            }`}
                                    >
                                        {ocrStatus}
                                    </p>
                                )}
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
