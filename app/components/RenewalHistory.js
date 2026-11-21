
"use client";

import { useEffect, useState } from "react";
import { getModuleRenewalHistory } from "../lib/renewal-history";

export default function RenewalHistory({
    moduleName,
    onClose,
}) {
    const [historyRecords, setHistoryRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        let cancelled = false;

        async function loadHistory() {
            try {
                setLoading(true);
                setError("");

                const records = await getModuleRenewalHistory(moduleName);

                if (!cancelled) {
                    setHistoryRecords(records);
                }
            } catch (err) {
                console.error("Renewal history error:", err);

                if (!cancelled) {
                    setError(
                        err.message || "Unable to load renewal history."
                    );
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        if (moduleName) {
            loadHistory();
        } else {
            setError("Module name is missing.");
            setLoading(false);
        }

        return () => {
            cancelled = true;
        };
    }, [moduleName]);

    function formatDate(value) {
        if (!value) return "-";

        let date;

        if (typeof value?.toDate === "function") {
            date = value.toDate();
        } else if (value instanceof Date) {
            date = value;
        } else {
            date = new Date(value);
        }

        if (Number.isNaN(date.getTime())) return "-";

        return date.toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
        });
    }

    function getRenewedBy(record) {
        return (
            record.renewedBy?.displayName ||
            record.renewedBy?.email ||
            "-"
        );
    }

    function getRecordName(record) {
        const data = record.previousData || {};

        return (
            data.productName ||
            data.vehicleNo ||
            data.vehicleNumber ||
            data.productId ||
            data.policyNo ||
            data.name ||
            "Record"
        );
    }

    function getOldExpiry(record) {
        const data = record.previousData || {};

        return (
            data.endDate ||
            data.expiryDate ||
            data.renewalDate ||
            data.nextServiceDueDate ||
            null
        );
    }

    function getNewExpiry(record) {
        const data = record.renewalData || {};

        return (
            data.endDate ||
            data.expiryDate ||
            data.renewalDate ||
            data.nextServiceDueDate ||
            null
        );
    }

    async function openPreviousDocument(dataUrl) {
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
        } catch (err) {
            console.error("Previous document open error:", err);

            newWindow.close();
            alert("Previous document could not be opened.");
        }
    }

    return (
        <div
            onClick={onClose}
            style={{
                position: "fixed",
                inset: 0,
                zIndex: 1000,
                background: "rgba(15, 23, 42, 0.60)",
                backdropFilter: "blur(3px)",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                padding: "16px",
            }}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                style={{
                    background: "#fff",
                    width: "100%",
                    maxWidth: "1100px",
                    maxHeight: "90vh",
                    overflowY: "auto",
                    borderRadius: "14px",
                    color: "#1e293b",
                    boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
                    overflowX: "hidden",
                }}
            >
                {/* Header */}
                <div
                    style={{
                        background: "#0b4da2",
                        color: "#fff",
                        padding: "20px 24px",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "12px",
                    }}
                >
                    <div>
                        <h2
                            style={{
                                margin: 0,
                                fontSize: "20px",
                                fontWeight: 700,
                            }}
                        >
                            ↶ {moduleName} Renewal History
                        </h2>

                        <p
                            style={{
                                margin: "6px 0 0",
                                color: "#dbeafe",
                                fontSize: "13px",
                            }}
                        >
                            Previous and renewed record details
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close renewal history"
                        style={{
                            border: "1px solid rgba(255,255,255,0.35)",
                            background: "rgba(255,255,255,0.12)",
                            color: "#fff",
                            borderRadius: "8px",
                            width: "34px",
                            height: "34px",
                            cursor: "pointer",
                            fontSize: "21px",
                            lineHeight: 1,
                            flexShrink: 0,
                        }}
                    >
                        ×
                    </button>
                </div>

                {/* Content */}
                <div style={{ padding: "22px 24px" }}>
                    {loading ? (
                        <div
                            style={{
                                textAlign: "center",
                                padding: "55px 15px",
                                color: "#64748b",
                                fontSize: "14px",
                            }}
                        >
                            Loading renewal history...
                        </div>
                    ) : error ? (
                        <div
                            style={{
                                background: "#fef2f2",
                                color: "#dc2626",
                                padding: "15px",
                                borderRadius: "8px",
                                fontSize: "14px",
                            }}
                        >
                            {error}
                        </div>
                    ) : historyRecords.length === 0 ? (
                        <div
                            style={{
                                textAlign: "center",
                                padding: "50px 15px",
                                background: "#f8fafc",
                                border: "1px dashed #cbd5e1",
                                borderRadius: "10px",
                            }}
                        >
                            <div
                                style={{
                                    fontSize: "32px",
                                    marginBottom: "10px",
                                }}
                            >
                                ↶
                            </div>

                            <p
                                style={{
                                    margin: 0,
                                    color: "#334155",
                                    fontSize: "15px",
                                    fontWeight: 600,
                                }}
                            >
                                No Renewal History Found
                            </p>

                            <p
                                style={{
                                    margin: "7px 0 0",
                                    color: "#64748b",
                                    fontSize: "13px",
                                }}
                            >
                                Renewal records will appear here after a renewal.
                            </p>
                        </div>
                    ) : (
                        <>
                            <div
                                style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    marginBottom: "14px",
                                    gap: "10px",
                                    flexWrap: "wrap",
                                }}
                            >
                                <span
                                    style={{
                                        fontSize: "14px",
                                        fontWeight: 600,
                                        color: "#334155",
                                    }}
                                >
                                    Renewal Records
                                </span>

                                <span
                                    style={{
                                        background: "#eff6ff",
                                        color: "#0b4da2",
                                        padding: "6px 11px",
                                        borderRadius: "20px",
                                        fontSize: "12px",
                                        fontWeight: 700,
                                    }}
                                >
                                    Total: {historyRecords.length}
                                </span>
                            </div>

                            <div
                                style={{
                                    overflowX: "auto",
                                    border: "1px solid #e2e8f0",
                                    borderRadius: "9px",
                                }}
                            >
                                <table
                                    style={{
                                        width: "100%",
                                        borderCollapse: "collapse",
                                        fontSize: "13px",
                                        minWidth: "850px",
                                    }}
                                >
                                    <thead>
                                        <tr
                                            style={{
                                                background: "#0b4da2",
                                                color: "#fff",
                                            }}
                                        >
                                            {[
                                                "S. No.",
                                                "Record",
                                                "Previous Expiry",
                                                "New Expiry",
                                                "Previous Document",
                                                "Renewed On",
                                                "Renewed By",
                                            ].map((heading) => (
                                                <th
                                                    key={heading}
                                                    style={{
                                                        padding: "13px 12px",
                                                        textAlign: "left",
                                                        whiteSpace: "nowrap",
                                                        fontWeight: 600,
                                                    }}
                                                >
                                                    {heading}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>

                                    <tbody>
                                        {historyRecords.map((record, index) => {
                                            const previousDocument =
                                                record.previousData?.documentData;

                                            return (
                                                <tr
                                                    key={record.id}
                                                    style={{
                                                        background:
                                                            index % 2 === 0
                                                                ? "#fff"
                                                                : "#f8fafc",
                                                        borderBottom:
                                                            "1px solid #e2e8f0",
                                                    }}
                                                >
                                                    <td style={cellStyle}>
                                                        {index + 1}
                                                    </td>

                                                    <td
                                                        style={{
                                                            ...cellStyle,
                                                            fontWeight: 600,
                                                            color: "#334155",
                                                        }}
                                                    >
                                                        {getRecordName(record)}
                                                    </td>

                                                    <td style={cellStyle}>
                                                        {formatDate(getOldExpiry(record))}
                                                    </td>

                                                    <td
                                                        style={{
                                                            ...cellStyle,
                                                            color: "#15803d",
                                                            fontWeight: 600,
                                                        }}
                                                    >
                                                        {formatDate(getNewExpiry(record))}
                                                    </td>

                                                    <td style={cellStyle}>
                                                        {previousDocument ? (
                                                            <button
                                                                type="button"
                                                                onClick={() =>
                                                                    openPreviousDocument(
                                                                        previousDocument
                                                                    )
                                                                }
                                                                style={{
                                                                    background: "#0b4da2",
                                                                    color: "#fff",
                                                                    border: "none",
                                                                    padding: "7px 11px",
                                                                    borderRadius: "6px",
                                                                    cursor: "pointer",
                                                                    fontSize: "12px",
                                                                    fontWeight: 600,
                                                                    whiteSpace: "nowrap",
                                                                }}
                                                            >
                                                                View Document
                                                            </button>
                                                        ) : (
                                                            <span style={{ color: "#94a3b8" }}>
                                                                -
                                                            </span>
                                                        )}
                                                    </td>

                                                    <td style={cellStyle}>
                                                        {formatDate(record.renewedAt)}
                                                    </td>

                                                    <td style={cellStyle}>
                                                        {getRenewedBy(record)}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    )}
                </div>

                {/* Footer */}
                <div
                    style={{
                        borderTop: "1px solid #e2e8f0",
                        padding: "14px 24px",
                        display: "flex",
                        justifyContent: "flex-end",
                        background: "#f8fafc",
                    }}
                >
                    <button
                        type="button"
                        onClick={onClose}
                        style={{
                            background: "#0b4da2",
                            color: "#fff",
                            border: "none",
                            borderRadius: "8px",
                            padding: "9px 20px",
                            fontSize: "13px",
                            fontWeight: 600,
                            cursor: "pointer",
                        }}
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}

const cellStyle = {
    padding: "12px",
    color: "#475569",
    whiteSpace: "nowrap",
    verticalAlign: "middle",
};
