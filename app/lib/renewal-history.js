
import {
    collection,
    doc,
    getDocs,
    query,
    where,
    runTransaction,
    serverTimestamp,
} from "firebase/firestore";

import { db } from "../../lib/firebase";

const HISTORY_COLLECTION = "renewal_history";

const DOCUMENT_FIELDS = [
    "documentData",
    "documentName",
    "documentSize",
    "documentType",
];

/**
 * Save the previous record and update the same record.
 * Call only for an actual renewal, never for an ordinary edit.
 */
export async function renewRecord({
    collectionName,
    recordId,
    moduleName,
    renewalData,
    actor = {},
}) {
    if (!collectionName || !recordId || !moduleName) {
        throw new Error("Renewal details are incomplete.");
    }

    if (!renewalData || typeof renewalData !== "object") {
        throw new Error("New renewal details are missing.");
    }

    const recordRef = doc(db, collectionName, recordId);
    const historyRef = doc(collection(db, HISTORY_COLLECTION));

    // Keep document metadata, but do not duplicate Base64 file data
    // in the history entry. The old file remains in previousData.
    const historyRenewalData = { ...renewalData };

    DOCUMENT_FIELDS.forEach((field) => {
        delete historyRenewalData[field];
    });

    await runTransaction(db, async (transaction) => {
        const recordSnapshot = await transaction.get(recordRef);

        if (!recordSnapshot.exists()) {
            throw new Error("Original record no longer exists.");
        }

        const previousData = recordSnapshot.data();

        transaction.set(historyRef, {
            moduleName,
            collectionName,
            recordId,
            previousData,
            renewalData: historyRenewalData,
            renewedAt: serverTimestamp(),
            renewedBy: {
                uid: actor.uid || "",
                email: actor.email || "",
                displayName: actor.displayName || "",
            },
            createdAt: serverTimestamp(),
        });

        // Update the original record, not a duplicate.
        // Full renewalData is used here, including document fields.
        transaction.update(recordRef, {
            ...renewalData,
            updatedAt: serverTimestamp(),
        });
    });

    return historyRef.id;
}

/**
 * Get renewal history for a particular module.
 */
export async function getModuleRenewalHistory(moduleName) {
    if (!moduleName) {
        throw new Error("Module name is required.");
    }

    const historyQuery = query(
        collection(db, HISTORY_COLLECTION),
        where("moduleName", "==", moduleName)
    );

    const snapshot = await getDocs(historyQuery);

    return snapshot.docs
        .map((item) => ({
            id: item.id,
            ...item.data(),
        }))
        .sort((a, b) => {
            const dateA = a.renewedAt?.toMillis?.() || 0;
            const dateB = b.renewedAt?.toMillis?.() || 0;

            return dateB - dateA;
        });
}

/**
 * Get renewal history for one particular record.
 */
export async function getRecordRenewalHistory(
    recordId,
    collectionName = null
) {
    if (!recordId) {
        throw new Error("Record ID is required.");
    }

    const constraints = [
        where("recordId", "==", recordId),
    ];

    if (collectionName) {
        constraints.push(where("collectionName", "==", collectionName));
    }

    const historyQuery = query(
        collection(db, HISTORY_COLLECTION),
        ...constraints
    );

    const snapshot = await getDocs(historyQuery);

    return snapshot.docs
        .map((item) => ({
            id: item.id,
            ...item.data(),
        }))
        .sort((a, b) => {
            const dateA = a.renewedAt?.toMillis?.() || 0;
            const dateB = b.renewedAt?.toMillis?.() || 0;

            return dateB - dateA;
        });
}
