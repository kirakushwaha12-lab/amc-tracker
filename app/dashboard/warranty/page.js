
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
import { renewRecord } from "../../lib/renewal-history";
import RenewalHistory from "../../components/RenewalHistory";

const BLUE = "#0b4da2";

const initialForm = {
    productId: "",
    productName: "",
    priceWithoutGST: "",
    gstPercent: "",
    user: "",
    department: "",
    purchaseDate: "",
    endDate: "",
    vendor: "",
    warrantyClaim: "N",
    claimedDate: "",
    reasonForIssues: "",
    remarks: "",
};

function getDays(endDate) {
    if (!endDate) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const expiry = new Date(`${endDate}T00:00:00`);
    if (Number.isNaN(expiry.getTime())) return null;

    return Math.ceil(
        (expiry.getTime() - today.getTime()) / 86400000
    );
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

async function compressWarrantyImage(file) {
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

function readWarrantyDocument(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read document."));

        reader.readAsDataURL(file);
    });
}

async function openWarrantyDocument(data) {
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
    } catch (error) {
        tab.close();
        alert("Could not open the document.");
    }
}


function extractWarrantyTableFields(rawText) {
    const aliases = {
        productId: ["Product ID", "Asset ID", "Serial Number", "Serial No", "Item Code"],
        productName: ["Item", "Product Name", "Item Description", "Product Description", "Model", "Equipment Name"],
        priceWithoutGST: ["Price Without GST", "Basic Price", "Purchase Price", "Item Price", "Taxable Value"],
        gstPercent: ["GST %", "GST Rate", "GST Percentage"],
        user: ["User", "Assigned To", "Employee Name", "Allocated To"],
        department: ["Department", "Dept"],
        purchaseDate: ["Purchase Date", "Date of Purchase", "Invoice Date"],
        endDate: ["Warranty Expired", "Warranty Expiry Date", "Warranty End Date", "Valid Until"],
        vendor: ["Supplier", "Vendor", "Dealer", "Seller", "Company"],
        warrantyClaim: ["Warranty Claim", "Claim Status"],
        claimedDate: ["Claimed Date", "Claim Date"],
        reasonForIssues: ["Reason for Issues", "Issue Description", "Problem Description"],
    };

    const normalize = (value) =>
        String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

    const aliasMap = new Map();

    Object.entries(aliases).forEach(([field, names]) => {
        names.forEach((name) => {
            aliasMap.set(normalize(name), field);
        });
    });

    const extracted = {};

    String(rawText || "").split(/\r?\n/).forEach((line) => {
        const cells = line
            .split("|")
            .map((cell) => cell.trim().replace(/^`|`$/g, ""))
            .filter(Boolean);

        if (cells.length < 2) return;

        const label = cells[0];
        const value = cells[1];

        if (!label || !value) return;

        // Ignore Markdown table separator rows.
        if (/^[-:\s]+$/.test(label) || /^[-:\s]+$/.test(value)) {
            return;
        }

        const field = aliasMap.get(normalize(label));

        if (!field || extracted[field]) return;

        let cleaned = value
            .replace(/\*\*/g, "")
            .replace(/^["']|["']$/g, "")
            .trim();

        if (!cleaned) return;

        if (["purchaseDate", "endDate", "claimedDate"].includes(field)) {
            const dateMatch = cleaned.match(
                /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/
            );

            if (dateMatch) {
                let year = Number(dateMatch[3]);

                if (year < 100) {
                    year += year <= 49 ? 2000 : 1900;
                }

                const month = Number(dateMatch[2]);
                const day = Number(dateMatch[1]);

                const date = new Date(Date.UTC(year, month - 1, day));

                if (
                    date.getUTCFullYear() !== year ||
                    date.getUTCMonth() !== month - 1 ||
                    date.getUTCDate() !== day
                ) return;

                cleaned = [
                    String(year).padStart(4, "0"),
                    String(month).padStart(2, "0"),
                    String(day).padStart(2, "0"),
                ].join("-");
            } else {
                return;
            }
        }

        if (field === "priceWithoutGST" || field === "gstPercent") {
            const number = cleaned.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
            if (!number) return;
            cleaned = number[0];
        }

        if (field === "warrantyClaim") {
            const status = cleaned.toLowerCase();

            if (["no", "n", "not claimed"].includes(status)) {
                cleaned = "N";
            } else if (["yes", "y", "claimed"].includes(status)) {
                cleaned = "Y";
            } else {
                return;
            }
        }

        extracted[field] = cleaned;
    });

    return extracted;
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
            className={`inline-flex whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${styles[status] || styles.Unknown
                }`}
        >
            {status}
        </span>
    );
}

function SummaryCard({ title, value, description, color }) {
    return (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium text-slate-500">{title}</p>
                <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                />
            </div>
            <p className="mt-3 text-3xl font-bold text-slate-900">{value}</p>
            <p className="mt-2 text-xs text-slate-500">{description}</p>
        </div>
    );
}

export default function WarrantyPage() {
    const router = useRouter();

    const [records, setRecords] = useState([]);
    const [loadingData, setLoadingData] = useState(true);
    const [dataError, setDataError] = useState("");
    const [notice, setNotice] = useState("");
    const [showModal, setShowModal] = useState(false);
    const [saving, setSaving] = useState(false);

    const [search, setSearch] = useState("");
    const [period, setPeriod] = useState("all");
    const [statusFilter, setStatusFilter] = useState("all");
    const [form, setForm] = useState(initialForm);
    const [editingId, setEditingId] = useState(null);
    const [renewingId, setRenewingId] = useState(null);
    const [showHistory, setShowHistory] = useState(false);

    const [isSuperAdmin, setIsSuperAdmin] = useState(false);
    const [canEditRecords, setCanEditRecords] = useState(false);
    const [deletingId, setDeletingId] = useState(null);
    const [selectedDocument, setSelectedDocument] = useState(null);
    const [existingDocument, setExistingDocument] = useState(null);
    const [isReadingDocument, setIsReadingDocument] = useState(false);
    const [documentError, setDocumentError] = useState("");
    const [todayKey, setTodayKey] = useState(
        () => new Date().toDateString()
    );


    useEffect(() => {
        let unsubscribeRecords = null;
        let authCheckId = 0;

        const unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
            const currentCheck = ++authCheckId;

            // Always clean up the previous user's listener.
            unsubscribeRecords?.();
            unsubscribeRecords = null;

            if (!user) {
                setIsSuperAdmin(false);
                setCanEditRecords(false);
                setRecords([]);
                setLoadingData(false);
                setShowModal(false);
                router.replace("/");
                return;
            }

            setLoadingData(true);
            setDataError("");

            try {
                const userSnapshot = await getDoc(
                    doc(db, "users", user.uid)
                );

                if (currentCheck !== authCheckId) return;

                const userData = userSnapshot.exists()
                    ? userSnapshot.data()
                    : {};

                const role = String(userData.role ?? "")
                    .trim()
                    .toLowerCase()
                    .replace(/[\s_-]+/g, "");

                const active = userData.active === true;

                const superAdmin =
                    active && role === "superadmin";

                const canEdit =
                    superAdmin ||
                    (active && ["admin", "editor"].includes(role));
                setIsSuperAdmin(superAdmin);
                setCanEditRecords(canEdit);

                if (!active) {
                    setRecords([]);
                    setDataError(
                        "Your account is inactive. Please contact the Super Admin."
                    );
                    setLoadingData(false);
                    setShowModal(false);
                    return;
                }

                unsubscribeRecords = onSnapshot(
                    collection(db, "it_devices"),
                    (snapshot) => {
                        if (currentCheck !== authCheckId) return;

                        const warrantyRecords = snapshot.docs
                            .map((document) => ({
                                id: document.id,
                                ...document.data(),
                            }))
                            .filter(
                                (record) =>
                                    String(record.category || "").toLowerCase() ===
                                    "it devices" &&
                                    String(record.type || "").toLowerCase() ===
                                    "warranty"
                            )
                            .map((record) => {
                                const endDate =
                                    record.endDate || record.expiryDate || "";

                                const priceWithoutGST =
                                    record.priceWithoutGST !== "" &&
                                        record.priceWithoutGST != null
                                        ? record.priceWithoutGST
                                        : record.cost ?? "";

                                const gstPercent =
                                    record.gstPercent !== "" &&
                                        record.gstPercent != null
                                        ? record.gstPercent
                                        : record.gst ?? "";

                                return {
                                    ...record,
                                    productId:
                                        record.productId || record.assetId || "",
                                    productName:
                                        record.productName ||
                                        record.product ||
                                        record.item ||
                                        "",
                                    priceWithoutGST,
                                    gstPercent,
                                    user: record.user || "",
                                    department: record.department || "",
                                    purchaseDate:
                                        record.purchaseDate ||
                                        record.startDate ||
                                        "",
                                    endDate,
                                    vendor:
                                        record.vendor ||
                                        record.supplier ||
                                        record.company ||
                                        "",
                                    warrantyClaim:
                                        record.warrantyClaim ||
                                        record.claim ||
                                        "N",
                                    claimedDate: record.claimedDate || "",
                                    reasonForIssues:
                                        record.reasonForIssues || "",
                                    remarks: record.remarks || "",
                                    status: getStatus(endDate),
                                };
                            });

                        warrantyRecords.sort((a, b) => {
                            const dateA = a.endDate || "9999-12-31";
                            const dateB = b.endDate || "9999-12-31";
                            return dateA.localeCompare(dateB);
                        });

                        setRecords(warrantyRecords);
                        setDataError("");
                        setLoadingData(false);
                    },
                    (error) => {
                        if (currentCheck !== authCheckId) return;

                        console.error("Warranty records error:", error);
                        setDataError(
                            "Unable to load warranty records. Please check Firestore permissions."
                        );
                        setLoadingData(false);
                    }
                );
            } catch (error) {
                if (currentCheck !== authCheckId) return;

                console.error("Warranty role check error:", error);

                setIsSuperAdmin(false);
                setCanEditRecords(false);
                setRecords([]);
                setShowModal(false);
                setDataError("User role could not be verified.");
                setLoadingData(false);
            }
        });

        return () => {
            authCheckId++;
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
                status: getStatus(record.endDate),
            })),
        [records, todayKey]
    );
    const summary = useMemo(() => {
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

        const overdue = preparedRecords.filter((record) => {
            const days = getDays(record.endDate);
            return days !== null && days < 0;
        }).length;

        const next10 = preparedRecords.filter((record) => {
            const days = getDays(record.endDate);
            return days !== null && days >= 0 && days <= 10;
        }).length;

        const next30 = preparedRecords.filter((record) => {
            const days = getDays(record.endDate);
            return days !== null && days >= 0 && days <= 30;
        }).length;

        return {
            total,
            active,
            expiring,
            expired,
            overdue,
            next10,
            next30,
        };
    }, [preparedRecords, todayKey]);
    const filteredRecords = useMemo(() => {
        return preparedRecords.filter((record) => {
            const query = search.trim().toLowerCase();

            const matchesSearch =
                !query ||
                [
                    record.productId,
                    record.productName,
                    record.vendor,
                    record.user,
                    record.department,
                    record.reasonForIssues,
                    record.remarks,
                ].some((value) =>
                    String(value ?? "").toLowerCase().includes(query)
                );

            const days = getDays(record.endDate);
            let matchesPeriod = true;

            if (period === "10") {
                matchesPeriod =
                    days !== null && days >= 0 && days <= 10;
            } else if (period === "30") {
                matchesPeriod =
                    days !== null && days >= 0 && days <= 30;
            } else if (period === "90") {
                matchesPeriod =
                    days !== null && days >= 0 && days <= 90;
            } else if (period === "expired") {
                matchesPeriod = days !== null && days < 0;
            }

            const matchesStatus =
                statusFilter === "all" ||
                record.status === statusFilter;

            return matchesSearch && matchesPeriod && matchesStatus;
        });
    }, [preparedRecords, search, period, statusFilter, todayKey]);

    function updateForm(event) {
        const { name, value } = event.target;

        setForm((previous) => ({
            ...previous,
            [name]: value,
        }));
    }

    function openModal() {
        if (!canEditRecords) {
            setNotice("You do not have permission to add or edit records.");
            return;
        }

        setEditingId(null);
        setRenewingId(null);
        setForm({ ...initialForm });
        setSelectedDocument(null);
        setExistingDocument(null);
        setDocumentError("");
        setNotice("");
        setDataError("");
        setShowModal(true);
    }

    function openEditModal(record) {
        if (!canEditRecords) {
            setNotice("You do not have permission to edit records.");
            return;
        }

        setForm({
            productId: record.productId || "",
            productName: record.productName || "",
            priceWithoutGST:
                record.priceWithoutGST === ""
                    ? ""
                    : String(record.priceWithoutGST ?? ""),
            gstPercent:
                record.gstPercent === ""
                    ? ""
                    : String(record.gstPercent ?? ""),
            user: record.user || "",
            department: record.department || "",
            purchaseDate: record.purchaseDate || "",
            endDate: record.endDate || "",
            vendor: record.vendor || "",
            warrantyClaim: record.warrantyClaim || "N",
            claimedDate: record.claimedDate || "",
            reasonForIssues: record.reasonForIssues || "",
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
        setDocumentError("");
        setRenewingId(null);
        setEditingId(record.id);
        setNotice("");
        setDataError("");
        setShowModal(true);
    }
    function openRenewModal(record) {
        if (!canEditRecords) {
            setNotice("You do not have permission to renew records.");
            return;
        }

        setEditingId(null);
        setRenewingId(record.id);

        setForm({
            productId: record.productId || "",
            productName: record.productName || "",
            priceWithoutGST:
                record.priceWithoutGST === ""
                    ? ""
                    : String(record.priceWithoutGST ?? ""),
            gstPercent:
                record.gstPercent === ""
                    ? ""
                    : String(record.gstPercent ?? ""),
            user: record.user || "",
            department: record.department || "",
            purchaseDate: record.purchaseDate || "",
            endDate: "",
            vendor: record.vendor || "",
            warrantyClaim: record.warrantyClaim || "N",
            claimedDate: "",
            reasonForIssues: "",
            remarks: "",
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
        setDocumentError("");
        setNotice("");
        setDataError("");
        setShowModal(true);
    }

    async function handleWarrantyDocumentChange(event) {
        const input = event.target;
        const file = input.files?.[0];

        setDocumentError("");
        setSelectedDocument(null);

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
            const finalFile = await compressWarrantyImage(file);

            if (finalFile.size > MAX_DOCUMENT_SIZE) {
                setDocumentError(
                    "File must be 500 KB or less after compression."
                );
                input.value = "";
                return;
            }

            // Keep selected document for Firestore saving.
            setSelectedDocument(finalFile);

            // DOC/DOCX are upload-only formats.
            if (!["pdf", "jpg", "jpeg", "png"].includes(extension)) {
                setDocumentError(
                    "Document selected successfully. OCR is available for PDF, JPG and PNG files only."
                );
                return;
            }

            if (!input.form) {
                throw new Error("Warranty form could not be identified.");
            }

            setIsReadingDocument(true);

            const rawText = await recognizeDocumentImage(finalFile);

            console.log("WARRANTY OCR TEXT:", rawText);

            if (!rawText || !rawText.trim()) {
                setDocumentError(
                    "Document selected, but no readable text was detected. Please fill the fields manually."
                );
                return;
            }


            const commonExtracted = extractDocumentFields(rawText, input.form);

            // Warranty remarks must never be filled through OCR.
            delete commonExtracted.remarks;

            // Read Warranty-specific pipe-delimited table rows.
            const tableExtracted = extractWarrantyTableFields(rawText);

            console.log("WARRANTY TABLE EXTRACTED:", tableExtracted);

            // Common extraction gets priority; table extraction fills missing fields.
            const extracted = {
                ...tableExtracted,
                ...commonExtracted,
            };
            console.log("WARRANTY FINAL EXTRACTED:", extracted);
            delete extracted.remarks;

            const detectedCount = Object.values(extracted).filter(
                (value) => String(value ?? "").trim() !== ""
            ).length;

            if (detectedCount === 0) {
                setDocumentError(
                    "Document uploaded, but no matching warranty fields were detected. Please fill them manually."
                );
                return;
            }

            // Only blank fields are filled. Existing manual values are preserved.
            setForm((previous) => {
                const result = mergeExtractedFields(previous, extracted);
                return result.form;
            });

            setDocumentError(
                `Document read successfully. ${detectedCount} matching field(s) detected. Please verify the details.`
            );

        } catch (error) {
            console.error("Warranty OCR error:", error);

            setDocumentError(
                error.message ||
                "Document selected, but OCR could not read it. Please fill the fields manually."
            );
        } finally {
            setIsReadingDocument(false);
        }
    }

    async function handleSubmit(event) {
        event.preventDefault();
        setNotice("");

        // Permission guard: do not rely only on hiding the button.
        if (!canEditRecords) {
            setNotice("You do not have permission to add or edit records.");
            return;
        }

        if (!form.productName.trim()) {
            setNotice("Please enter the item / product name.");
            return;
        }
        if (!form.vendor.trim()) {
            setNotice("Please enter the vendor name.");
            return;
        }
        if (
            form.purchaseDate &&
            form.endDate &&
            form.endDate < form.purchaseDate
        ) {
            setNotice("Expiry Date cannot be before Purchase Date.");
            return;
        }

        const price =
            form.priceWithoutGST === ""
                ? ""
                : Number(form.priceWithoutGST);

        const gst =
            form.gstPercent === "" ? "" : Number(form.gstPercent);

        if (price !== "" && (!Number.isFinite(price) || price < 0)) {
            setNotice("Please enter a valid item price.");
            return;
        }

        if (
            gst !== "" &&
            (!Number.isFinite(gst) || gst < 0 || gst > 100)
        ) {
            setNotice("GST must be between 0 and 100.");
            return;
        }

        setSaving(true);

        const recordData = {
            category: "IT Devices",
            type: "Warranty",
            productId: form.productId.trim(),
            productName: form.productName.trim(),
            startDate: form.purchaseDate,
            endDate: form.endDate,
            vendor: form.vendor.trim(),
            cost: price,
            remarks: form.remarks.trim(),
            priceWithoutGST: price,
            gstPercent: gst,
            user: form.user.trim(),
            department: form.department.trim(),
            purchaseDate: form.purchaseDate,
            warrantyClaim: form.warrantyClaim,
            claimedDate:
                form.warrantyClaim === "Y" ? form.claimedDate : "",
            reasonForIssues: form.reasonForIssues.trim(),
            updatedAt: serverTimestamp(),
        };

        let documentFields = {};

        try {
            if (selectedDocument) {
                documentFields = {
                    documentData: await readWarrantyDocument(selectedDocument),
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
            } else if (editingId || renewingId) {
                documentFields = {
                    documentData: deleteField(),
                    documentName: deleteField(),
                    documentSize: deleteField(),
                    documentType: deleteField(),
                };
            }

            if (renewingId) {
                await renewRecord({
                    collectionName: "it_devices",
                    recordId: renewingId,
                    moduleName: "Warranty",
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

                setNotice(
                    "Warranty renewed successfully. Previous details saved in Renewal History."
                );
            } else if (editingId) {
                await updateDoc(doc(db, "it_devices", editingId), {
                    ...recordData,
                    ...documentFields,
                });

                setNotice("Warranty record updated successfully.");
            } else {
                await addDoc(collection(db, "it_devices"), {
                    ...recordData,
                    ...documentFields,
                    createdAt: serverTimestamp(),
                });

                setNotice("Warranty record added successfully.");
            }

            setForm({ ...initialForm });
            setEditingId(null);
            setRenewingId(null);
            setShowModal(false);
            setSelectedDocument(null);
            setExistingDocument(null);
            setDocumentError("");
        } catch (error) {
            console.error("Unable to save warranty:", error);
            setNotice(
                error.code === "permission-denied"
                    ? "Permission denied. Please check Firestore security rules."
                    : "Could not save the record. Please try again."
            );
        } finally {
            setSaving(false);
        }

        return;


    }

    async function handleDelete(record) {
        if (!isSuperAdmin) {
            setDataError("Only Super Admin can delete warranty records.");
            return;
        }

        const confirmed = window.confirm(
            `Are you sure you want to delete "${record.productName || "this warranty record"
            }"? This action cannot be undone.`
        );

        if (!confirmed) return;

        setDeletingId(record.id);
        setDataError("");
        setNotice("");

        try {
            await deleteDoc(doc(db, "it_devices", record.id));
            setNotice("Warranty record deleted successfully.");
            window.setTimeout(() => setNotice(""), 3500);
        } catch (error) {
            console.error("Warranty delete error:", error);
            setDataError(
                error.code === "permission-denied"
                    ? "Permission denied. Please check Firestore security rules."
                    : "Warranty record could not be deleted. Please try again."
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
                            Warranty Management
                        </h1>
                        <p className="mt-2 text-sm text-slate-500">
                            Track warranty details, expiry dates and claims.
                        </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                        {canEditRecords && (
                            <button
                                type="button"
                                onClick={openModal}
                                className="rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
                                style={{ backgroundColor: BLUE }}
                            >
                                + Add Warranty Record
                            </button>
                        )}

                        <button
                            type="button"
                            onClick={() => setShowHistory(true)}
                            className="rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
                            style={{ backgroundColor: BLUE }}
                        >
                            Renewal History
                        </button>
                    </div>
                </div>

                {notice && !showModal && (
                    <div className="mt-5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
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

                {dataError && (
                    <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {dataError}
                    </div>
                )}

                <section className="mt-7 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <SummaryCard
                        title="Total Warranty"
                        value={summary.total}
                        description="All warranty records"
                        color="#2563eb"
                    />
                    <SummaryCard
                        title="Active"
                        value={summary.active}
                        description="More than 10 days remaining"
                        color="#16a34a"
                    />
                    <SummaryCard
                        title="Expiring Soon"
                        value={summary.expiring}
                        description="Expiry within 10 days"
                        color="#d97706"
                    />
                    <SummaryCard
                        title="Expired"
                        value={summary.expired}
                        description="Expiry date has passed"
                        color="#dc2626"
                    />
                </section>

                <section className="mt-7 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 className="font-semibold text-slate-900">
                                Expiry Overview
                            </h2>
                            <p className="mt-1 text-sm text-slate-500">
                                Review warranties needing attention.
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
                                count: summary.overdue,
                                style: "border-red-100 bg-red-50 text-red-700",
                            },
                            {
                                label: "Next 10 days",
                                count: summary.next10,
                                style: "border-amber-100 bg-amber-50 text-amber-700",
                            },
                            {
                                label: "Next 30 days",
                                count: summary.next30,
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
                        <h2 className="font-semibold text-slate-900">
                            Warranty Records
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            {filteredRecords.length} of {records.length} records
                        </p>

                        <div className="mt-4 grid gap-3 md:grid-cols-3">
                            <input
                                type="search"
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder="Search product, vendor, user..."
                                className="rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                            />

                            <select
                                value={period}
                                onChange={(event) => setPeriod(event.target.value)}
                                className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                            >
                                <option value="all">Any Expiry Period</option>
                                <option value="10">Next 10 Days</option>
                                <option value="30">Next 30 Days</option>
                                <option value="90">Next 90 Days</option>
                                <option value="expired">Expired Records</option>
                            </select>

                            <select
                                value={statusFilter}
                                onChange={(event) =>
                                    setStatusFilter(event.target.value)
                                }
                                className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                            >
                                <option value="all">All Statuses</option>
                                <option value="Active">Active</option>
                                <option value="Expiring Soon">Expiring Soon</option>
                                <option value="Expired">Expired</option>
                                <option value="Unknown">Unknown</option>
                            </select>
                        </div>
                    </div>

                    <div className="overflow-x-auto">
                        <table
                            className={`w-full ${filteredRecords.some(
                                (record) => record.warrantyClaim === "Y"
                            )
                                ? "min-w-[2100px]"
                                : "min-w-[1700px]"
                                } text-left text-sm`}
                        >
                            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                <tr>
                                    {[
                                        "S. No.",
                                        "Product ID",
                                        "Item",
                                        "Price Without GST",
                                        "GST %",
                                        "User",
                                        "Dept.",
                                        "Purchase Date",
                                        "Expiry Date",
                                        "Vendor",
                                        "Warranty Claim",

                                        ...(filteredRecords.some(
                                            (record) => record.warrantyClaim === "Y"
                                        )
                                            ? ["Claimed Date", "Reason for Issues"]
                                            : []),

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
                                {loadingData ? (
                                    <tr>
                                        <td colSpan={
                                            filteredRecords.some(
                                                (record) => record.warrantyClaim === "Y"
                                            )
                                                ? 16
                                                : 14
                                        } className="px-4 py-12 text-center text-slate-500">
                                            Loading warranty records...
                                        </td>
                                    </tr>
                                ) : filteredRecords.length === 0 ? (
                                    <tr>
                                        <td colSpan={
                                            filteredRecords.some(
                                                (record) => record.warrantyClaim === "Y"
                                            )
                                                ? 16
                                                : 14
                                        } className="px-4 py-12 text-center">
                                            <p className="font-medium text-slate-700">
                                                No warranty records found
                                            </p>
                                            <p className="mt-1 text-sm text-slate-500">
                                                Add a record or change your search filters.
                                            </p>
                                        </td>
                                    </tr>
                                ) : (
                                    filteredRecords.map((record, index) => (
                                        <tr
                                            key={record.id}
                                            className="transition hover:bg-slate-50"
                                        >
                                            <td className="whitespace-nowrap px-4 py-4 text-slate-600">
                                                {index + 1}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4 text-slate-700">
                                                {record.productId || "—"}
                                            </td>
                                            <td className="px-4 py-4 font-medium text-slate-800">
                                                {record.productName || "—"}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4 text-slate-700">
                                                {money(record.priceWithoutGST)}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4 text-slate-700">
                                                {record.gstPercent !== "" &&
                                                    record.gstPercent !== null &&
                                                    record.gstPercent !== undefined
                                                    ? `${record.gstPercent}%`
                                                    : "—"}
                                            </td>
                                            <td className="px-4 py-4 text-slate-700">
                                                {record.user || "—"}
                                            </td>
                                            <td className="px-4 py-4 text-slate-700">
                                                {record.department || "—"}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4 text-slate-700">
                                                {formatDate(record.purchaseDate)}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4 text-slate-700">
                                                {formatDate(record.endDate)}
                                            </td>
                                            <td className="px-4 py-4 text-slate-700">
                                                {record.vendor || "—"}
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-4 text-slate-700">
                                                {record.warrantyClaim === "Y"
                                                    ? "Yes"
                                                    : record.warrantyClaim === "N" ||
                                                        !record.warrantyClaim
                                                        ? "No"
                                                        : record.warrantyClaim}
                                            </td>
                                            {filteredRecords.some(
                                                (item) => item.warrantyClaim === "Y"
                                            ) && (
                                                    <>
                                                        <td className="whitespace-nowrap px-4 py-4 text-slate-700">
                                                            {record.warrantyClaim === "Y"
                                                                ? formatDate(record.claimedDate)
                                                                : "—"}
                                                        </td>

                                                        <td className="max-w-[220px] whitespace-normal px-4 py-4 text-slate-700">
                                                            {record.warrantyClaim === "Y"
                                                                ? record.reasonForIssues || "—"
                                                                : "—"}
                                                        </td>
                                                    </>
                                                )}
                                            <td className="max-w-[220px] whitespace-normal px-4 py-4 text-slate-700">
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
                                                            onClick={() => openEditModal(record)}
                                                            className="rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                                                        >
                                                            Edit
                                                        </button>
                                                    )}
                                                    {canEditRecords && (
                                                        <button
                                                            type="button"
                                                            onClick={() => openRenewModal(record)}
                                                            className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
                                                            style={{ backgroundColor: BLUE }}
                                                        >
                                                            Renew
                                                        </button>
                                                    )}
                                                    {record.documentData && (
                                                        <button
                                                            type="button"
                                                            onClick={() => openWarrantyDocument(record.documentData)}
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
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>


                </section>


            </div>

            {showModal && canEditRecords && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 p-3 sm:p-6"
                    onMouseDown={(event) => {
                        if (
                            event.target === event.currentTarget &&
                            !saving &&
                            !isReadingDocument
                        ) {
                            setShowModal(false);
                            setNotice("");
                            setEditingId(null);
                            setRenewingId(null);
                            setForm({ ...initialForm });
                            setSelectedDocument(null);
                            setExistingDocument(null);
                            setDocumentError("");
                        }
                    }}
                >
                    <div className="my-auto max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
                        <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4 sm:px-7">
                            <div>
                                <h2 className="text-xl font-bold text-slate-900">
                                    {renewingId
                                        ? "Renew Warranty"
                                        : editingId
                                            ? "Edit Warranty"
                                            : "Add Warranty"}
                                </h2>
                                <p className="mt-1 text-sm text-slate-500">
                                    Enter item and warranty details
                                </p>
                            </div>

                            <button
                                type="button"
                                disabled={saving || isReadingDocument}
                                onClick={() => {
                                    setShowModal(false);
                                    setNotice("");
                                    setEditingId(null);
                                    setRenewingId(null);
                                    setForm({ ...initialForm });
                                    setSelectedDocument(null);
                                    setExistingDocument(null);
                                    setDocumentError("");
                                }}
                                className="rounded-lg px-3 py-2 text-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
                                aria-label="Close form"
                            >
                                ×
                            </button>
                        </div>

                        <form onSubmit={handleSubmit} className="p-5 sm:p-7">
                            {notice && (
                                <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                                    {notice}
                                </div>
                            )}

                            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                                <div className="md:col-span-2">
                                    <h3 className="border-b border-slate-200 pb-2 text-base font-bold text-slate-800">
                                        Product Details
                                    </h3>
                                </div>

                                <label className="text-sm font-medium text-slate-700">
                                    Product ID
                                    <input
                                        name="productId"
                                        data-ocr-aliases="Product ID|Asset ID|Serial Number|Serial No|Item Code"
                                        value={form.productId}
                                        onChange={updateForm}
                                        placeholder="Enter product ID"
                                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal outline-none focus:border-blue-500"
                                    />
                                </label>

                                <label className="text-sm font-medium text-slate-700">
                                    Item / Product Name *
                                    <input
                                        required
                                        name="productName"
                                        data-ocr-aliases="Item|Product Name|Item Description|Product Description|Model|Equipment Name"
                                        value={form.productName}
                                        onChange={updateForm}
                                        placeholder="Enter item or product name"
                                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-blue-500"
                                    />
                                </label>

                                <label className="text-sm font-medium text-slate-700">
                                    Price of Item Without GST
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        name="priceWithoutGST"
                                        data-ocr-aliases="Price Without GST|Basic Price|Purchase Price|Item Price|Taxable Value"
                                        value={form.priceWithoutGST}
                                        onChange={updateForm}
                                        placeholder="Enter price"
                                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-blue-500"
                                    />
                                </label>

                                <label className="text-sm font-medium text-slate-700">
                                    GST %
                                    <input
                                        type="number"
                                        min="0"
                                        max="100"
                                        step="0.01"
                                        name="gstPercent"
                                        data-ocr-aliases="GST %|GST Rate|GST Percentage"
                                        value={form.gstPercent}
                                        onChange={updateForm}
                                        placeholder="Enter GST percentage"
                                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-blue-500"
                                    />
                                </label>

                                <div className="md:col-span-2">
                                    <h3 className="border-b border-slate-200 pb-2 pt-2 text-base font-bold text-slate-800">
                                        Allocation Details
                                    </h3>
                                </div>

                                <label className="text-sm font-medium text-slate-700">
                                    User
                                    <input
                                        name="user"
                                        data-ocr-aliases="User|Assigned To|Employee Name|Allocated To"
                                        value={form.user}
                                        onChange={updateForm}
                                        placeholder="Enter user name"
                                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-blue-500"
                                    />
                                </label>

                                <label className="text-sm font-medium text-slate-700">
                                    Department
                                    <input
                                        name="department"
                                        data-ocr-aliases="Department|Dept"
                                        value={form.department}
                                        onChange={updateForm}
                                        placeholder="Enter department"
                                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-blue-500"
                                    />
                                </label>

                                <div className="md:col-span-2">
                                    <h3 className="border-b border-slate-200 pb-2 pt-2 text-base font-bold text-slate-800">
                                        Warranty Details
                                    </h3>
                                </div>

                                <label className="text-sm font-medium text-slate-700">
                                    Purchase Date
                                    <input

                                        type="date"
                                        name="purchaseDate"
                                        data-ocr-aliases="Purchase Date|Date of Purchase|Invoice Date"
                                        value={form.purchaseDate}
                                        onChange={updateForm}
                                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-blue-500"
                                    />
                                </label>

                                <label className="text-sm font-medium text-slate-700">
                                    Expiry Date
                                    <input

                                        type="date"
                                        min={form.purchaseDate || undefined}
                                        name="endDate"
                                        data-ocr-aliases="Warranty Expired|Warranty Expiry Date|Warranty End Date|Valid Until"
                                        value={form.endDate}
                                        onChange={updateForm}
                                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-blue-500"
                                    />
                                </label>

                                <label className="text-sm font-medium text-slate-700">
                                    Vendor *
                                    <input
                                        required
                                        name="vendor"
                                        data-ocr-aliases="Supplier|Vendor|Dealer|Seller|Company"
                                        value={form.vendor}
                                        onChange={updateForm}
                                        placeholder="Enter vendor name"
                                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-blue-500"
                                    />
                                </label>

                                <label className="text-sm font-medium text-slate-700">
                                    Warranty Claim
                                    <select
                                        name="warrantyClaim"
                                        data-ocr-aliases="Warranty Claim|Claim Status"
                                        value={form.warrantyClaim}
                                        onChange={updateForm}
                                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-normal outline-none focus:border-blue-500"
                                    >
                                        <option value="N">No</option>
                                        <option value="Y">Yes</option>
                                    </select>
                                </label>

                                {form.warrantyClaim === "Y" && (
                                    <>
                                        <label className="text-sm font-medium text-slate-700">
                                            Claimed Date
                                            <input

                                                type="date"
                                                min={form.purchaseDate || undefined}
                                                max={form.endDate || undefined}
                                                name="claimedDate"
                                                data-ocr-aliases="Claimed Date|Claim Date"
                                                value={form.claimedDate}
                                                onChange={updateForm}
                                                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-blue-500"
                                            />
                                        </label>

                                        <label className="text-sm font-medium text-slate-700">
                                            Reason for Issues
                                            <input
                                                name="reasonForIssues"
                                                data-ocr-aliases="Reason for Issues|Issue Description|Problem Description"
                                                value={form.reasonForIssues}
                                                onChange={updateForm}
                                                placeholder="Enter issue or claim reason"
                                                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-blue-500"
                                            />
                                        </label>
                                    </>
                                )}

                                <div className="md:col-span-2 rounded-xl border border-blue-200 bg-blue-50/50 p-4">
                                    <label className="block text-sm font-semibold text-slate-800">
                                        Warranty Document (Optional)
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
                                                    onClick={() => openWarrantyDocument(existingDocument.data)}
                                                    className="rounded-lg border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-700"
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
                                                    onChange={handleWarrantyDocumentChange}
                                                    className="sr-only"
                                                />
                                            </label>

                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setExistingDocument(null);
                                                    setSelectedDocument(null);
                                                }}
                                                className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700"
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    )}

                                    {!existingDocument && (
                                        <label className="mt-3 flex cursor-pointer items-center gap-3 rounded-lg border border-blue-200 bg-white p-3">
                                            <span className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
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
                                                onChange={handleWarrantyDocumentChange}
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

                                    {isReadingDocument && (
                                        <p className="mt-3 flex items-center gap-2 text-sm font-medium text-blue-700">
                                            <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
                                            Reading document and extracting warranty details...
                                        </p>
                                    )}
                                    {documentError && (
                                        <p className="mt-2 text-sm text-blue-700">
                                            {documentError}
                                        </p>
                                    )}
                                </div>
                            </div>
                            <label className="text-sm font-medium text-slate-700 md:col-span-2">
                                Remarks
                                <textarea
                                    name="remarks"
                                    value={form.remarks}
                                    onChange={updateForm}
                                    rows={3}
                                    placeholder="Enter additional remarks (optional)"
                                    className="mt-1 w-full resize-y rounded-lg border border-slate-300 px-3 py-2.5 font-normal outline-none focus:border-blue-500"
                                />
                            </label>

                            <div className="mt-7 flex flex-col-reverse gap-3 border-t border-slate-200 pt-5 sm:flex-row sm:justify-end">
                                <button
                                    type="button"
                                    disabled={saving || isReadingDocument}
                                    onClick={() => {
                                        setShowModal(false);
                                        setNotice("");
                                        setEditingId(null);
                                        setRenewingId(null);
                                        setForm({ ...initialForm });
                                        setSelectedDocument(null);
                                        setExistingDocument(null);
                                        setDocumentError("");
                                    }}
                                    className="rounded-lg border border-slate-300 px-5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                                >
                                    Cancel
                                </button>

                                <button
                                    type="submit"
                                    disabled={saving || isReadingDocument || !canEditRecords}
                                    className="rounded-lg px-6 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                                    style={{ backgroundColor: BLUE }}
                                >
                                    {saving
                                        ? renewingId
                                            ? "Renewing..."
                                            : editingId
                                                ? "Updating..."
                                                : "Saving..."
                                        : renewingId
                                            ? "Renew Warranty"
                                            : editingId
                                                ? "Update Warranty"
                                                : "Save Warranty"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
            {showHistory && (
                <RenewalHistory
                    moduleName="Warranty"
                    onClose={() => setShowHistory(false)}
                />
            )}
        </main>
    );
}
