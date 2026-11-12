
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 500 * 1024;
const MAX_REQUEST_SIZE = 600 * 1024;

const ALLOWED_MIME_TYPES = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    pdf: "application/pdf",
};

function getAdminApp() {
    if (getApps().length) return getApps()[0];

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

    if (!projectId || !clientEmail || !privateKey) {
        throw new Error("Firebase Admin credentials are not configured.");
    }

    return initializeApp({
        credential: cert({ projectId, clientEmail, privateKey }),
    });
}

function jsonError(error, status) {
    return Response.json({ success: false, error }, { status });
}

function isValidFileSignature(bytes, extension) {
    if (extension === "pdf") {
        return (
            bytes[0] === 0x25 &&
            bytes[1] === 0x50 &&
            bytes[2] === 0x44 &&
            bytes[3] === 0x46 &&
            bytes[4] === 0x2D
        );
    }

    if (extension === "jpg" || extension === "jpeg") {
        return (
            bytes[0] === 0xFF &&
            bytes[1] === 0xD8 &&
            bytes[2] === 0xFF
        );
    }

    if (extension === "png") {
        return (
            bytes[0] === 0x89 &&
            bytes[1] === 0x50 &&
            bytes[2] === 0x4E &&
            bytes[3] === 0x47 &&
            bytes[4] === 0x0D &&
            bytes[5] === 0x0A &&
            bytes[6] === 0x1A &&
            bytes[7] === 0x0A
        );
    }

    return false;
}

export async function POST(request) {
    try {
        // 1. Authenticate the user.
        const authorization = request.headers.get("authorization");
        const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

        if (!token) {
            return jsonError("Authentication required. Please sign in again.", 401);
        }

        let decodedToken;

        try {
            const app = getAdminApp();
            decodedToken = await getAuth(app).verifyIdToken(token, true);

            const userDoc = await getFirestore(app)
                .collection("users")
                .doc(decodedToken.uid)
                .get();

            if (!userDoc.exists || userDoc.data()?.active !== true) {
                return jsonError("Your account is inactive or unavailable.", 403);
            }
        } catch {
            return jsonError("Authentication failed. Please sign in again.", 401);
        }

        // 2. Check request size before parsing multipart data.
        const contentLength = Number(request.headers.get("content-length"));

        if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_SIZE) {
            return jsonError("Document must be 500 KB or less.", 413);
        }

        const apiKey = process.env.OCR_SPACE_API_KEY;

        if (!apiKey) {
            return jsonError("OCR.Space API key is not configured.", 500);
        }

        // 3. Read and validate the uploaded file.
        let incomingForm;

        try {
            incomingForm = await request.formData();
        } catch {
            return jsonError("Invalid document upload request.", 400);
        }

        const files = incomingForm.getAll("file");

        if (files.length !== 1) {
            return jsonError("Please upload exactly one document.", 400);
        }

        const file = files[0];

        if (!file || typeof file.arrayBuffer !== "function") {
            return jsonError("No document was received.", 400);
        }

        if (file.size === 0) {
            return jsonError("The selected document is empty.", 400);
        }

        if (file.size > MAX_FILE_SIZE) {
            return jsonError("Document must be 500 KB or less.", 413);
        }

        const extension = String(file.name || "")
            .split(".")
            .pop()
            .toLowerCase();

        if (!Object.hasOwn(ALLOWED_MIME_TYPES, extension)) {
            return jsonError(
                "OCR supports JPG, JPEG, PNG and PDF documents.",
                400
            );
        }

        if (file.type !== ALLOWED_MIME_TYPES[extension]) {
            return jsonError(
                "The selected file type does not match its extension.",
                400
            );
        }

        const fileHeader = new Uint8Array(
            await file.slice(0, 8).arrayBuffer()
        );

        if (!isValidFileSignature(fileHeader, extension)) {
            return jsonError(
                "The file content does not match its file type.",
                400
            );
        }

        // 4. Send the document to OCR.Space.
        const ocrForm = new FormData();

        ocrForm.append("file", file, file.name);
        ocrForm.append("language", "eng");
        ocrForm.append("OCREngine", "3");
        ocrForm.append("isTable", "true");
        ocrForm.append("detectOrientation", "true");
        ocrForm.append("scale", "true");
        ocrForm.append("isOverlayRequired", "false");

        let response;

        try {
            response = await fetch("https://api.ocr.space/parse/image", {
                method: "POST",
                headers: { apikey: apiKey },
                body: ocrForm,
                signal: AbortSignal.timeout(120000),
            });
        } catch (error) {
            if (error?.name === "TimeoutError") {
                return jsonError("OCR processing timed out. Please try again.", 504);
            }

            return jsonError("Could not connect to the OCR service.", 502);
        }

        if (!response.ok) {
            console.error("OCR.Space HTTP error:", response.status);
            return jsonError("OCR service request failed. Please try again.", 502);
        }

        // 5. Validate OCR.Space response.
        let data;

        try {
            data = await response.json();
        } catch {
            return jsonError("OCR service returned an invalid response.", 502);
        }

        if (!data || typeof data !== "object" || Array.isArray(data)) {
            return jsonError("OCR service returned an unexpected response.", 502);
        }

        const parsedResults = Array.isArray(data.ParsedResults)
            ? data.ParsedResults
            : [];

        if (
            data.IsErroredOnProcessing === true ||
            ![1, 2].includes(data.OCRExitCode)
        ) {
            return jsonError(
                "OCR.Space could not process this document. Please try a clearer file.",
                422
            );
        }

        if (
            parsedResults.some(
                (page) =>
                    !page ||
                    typeof page !== "object" ||
                    typeof page.ParsedText !== "string"
            )
        ) {
            return jsonError("OCR service returned an invalid page result.", 502);
        }

        const text = parsedResults
            .map((page) => page.ParsedText)
            .join("\n\n")
            .trim();

        const hasNoTextMessage =
            /^\s*(?:\*+\s*)?(?:\[)?\s*no text (?:detected|found)\b/i.test(text);

        if (!text || hasNoTextMessage) {
            return Response.json(
                {
                    success: false,
                    error:
                        "The document was received, but OCR could not detect readable text. Try a clearer or higher-resolution scan.",
                    engine: "3",
                    pageCount: parsedResults.length,
                    ocrExitCode: data.OCRExitCode ?? null,
                },
                { status: 422 }
            );
        }

        return Response.json({
            success: true,
            text,
            engine: "3",
            pageCount: parsedResults.length,
        });
    } catch (error) {
        console.error("OCR server error:", error?.message || "Unknown error");

        return jsonError("Could not process the document. Please try again.", 500);
    }
}
