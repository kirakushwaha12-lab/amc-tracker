
const admin = require("firebase-admin");
const Busboy = require("busboy");
const {Readable} = require("node:stream");
const createBusboy = Busboy;
const {setGlobalOptions} = require("firebase-functions/v2");
const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

if (!admin.apps.length) {
  admin.initializeApp();
}

setGlobalOptions({
  maxInstances: 10,
  region: "us-central1",
});

const MAX_FILE_SIZE = 500 * 1024;
const MAX_REQUEST_SIZE = 600 * 1024;

const ALLOWED_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  pdf: "application/pdf",
};
/**
 * Sends a standardized API error response.
 * @param {object} res Express response object.
 * @param {string} message Error message.
 * @param {number} status HTTP status code.
 * @return {object} JSON error response.
 */
function sendError(res, message, status) {
  return res.status(status).json({
    success: false,
    error: message,
  });
}
/**
 * Validates the uploaded file's actual signature.
 * @param {Buffer} buffer Uploaded file buffer.
 * @param {string} extension File extension.
 * @return {boolean} Whether the signature is valid.
 */
function isValidSignature(buffer, extension) {
  if (extension === "pdf") {
    return buffer.subarray(0, 5).toString() === "%PDF-";
  }

  if (extension === "jpg" || extension === "jpeg") {
    return (
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    );
  }

  if (extension === "png") {
    return buffer.subarray(0, 8).equals(
        Buffer.from([
          0x89, 0x50, 0x4e, 0x47,
          0x0d, 0x0a, 0x1a, 0x0a,
        ]),
    );
  }

  return false;
}
/**
 * Verifies the Firebase user and active account status.
 * @param {object} req Express request object.
 * @return {Promise<object>} Verified Firebase user.
 */
async function verifyUser(req) {
  const authorization = req.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    const error = new Error("Authentication required. Please sign in again.");
    error.status = 401;
    throw error;
  }

  const decoded = await admin.auth().verifyIdToken(match[1], true);

  const userDoc = await admin
      .firestore()
      .collection("users")
      .doc(decoded.uid)
      .get();

  if (!userDoc.exists || userDoc.data()?.active !== true) {
    const error = new Error("Your account is inactive or unavailable.");
    error.status = 403;
    throw error;
  }

  return decoded;
}
/**
 * Parses and validates the uploaded multipart document.
 * @param {object} req Express request object.
 * @return {Promise<object>} Validated uploaded file.
 */
function parseUploadedFile(req) {
  return new Promise((resolve, reject) => {
    let parser;

    try {
      parser = createBusboy({
        headers: req.headers,
        limits: {
          files: 1,
          fileSize: MAX_FILE_SIZE,
          fields: 0,
          parts: 1,
        },
      });
    } catch {
      reject(new Error("Invalid document upload request."));
      return;
    }

    let fileCount = 0;
    let fileData = null;
    let fileTooLarge = false;
    let invalidField = false;

    parser.on("file", (fieldName, stream, info) => {
      fileCount++;

      if (fieldName !== "file" || fileCount !== 1) {
        invalidField = true;
        stream.resume();
        return;
      }

      const chunks = [];

      fileData = {
        filename: info.filename || "",
        mimeType: info.mimeType || "",
      };

      stream.on("data", (chunk) => {
        chunks.push(chunk);
      });

      stream.on("limit", () => {
        fileTooLarge = true;
      });

      stream.on("error", reject);

      stream.on("end", () => {
        fileData.buffer = Buffer.concat(chunks);
      });
    });

    parser.on("field", () => {
      invalidField = true;
    });

    parser.on("filesLimit", () => {
      invalidField = true;
    });

    parser.on("fieldsLimit", () => {
      invalidField = true;
    });

    parser.on("partsLimit", () => {
      invalidField = true;
    });

    parser.on("error", () => {
      reject(new Error("Invalid document upload request."));
    });

    parser.on("finish", () => {
      if (fileTooLarge) {
        reject(new Error("Document must be 500 KB or less."));
        return;
      }

      if (invalidField || fileCount !== 1 || !fileData) {
        reject(new Error("Please upload exactly one document."));
        return;
      }

      resolve(fileData);
    });

    Readable.from([req.rawBody]).pipe(parser);
  });
}

exports.ocrApi = onRequest(
    {
      timeoutSeconds: 150,
      memory: "512MiB",
    },
    async (req, res) => {
      if (req.method !== "POST") {
        res.set("Allow", "POST");
        return sendError(res, "Method not allowed.", 405);
      }

      try {
        await verifyUser(req);
      } catch (error) {
        if (error.status) {
          return sendError(res, error.message, error.status);
        }

        logger.warn("OCR authentication failed.");
        return sendError(
            res,
            "Authentication failed. Please sign in again.",
            401,
        );
      }

      const contentLength = Number(req.get("content-length"));

      if (
        Number.isFinite(contentLength) &&
      contentLength > MAX_REQUEST_SIZE
      ) {
        return sendError(res, "Document must be 500 KB or less.", 413);
      }

      if (!Buffer.isBuffer(req.rawBody)) {
        return sendError(res, "Invalid document upload request.", 400);
      }

      if (req.rawBody.length > MAX_REQUEST_SIZE) {
        return sendError(res, "Document must be 500 KB or less.", 413);
      }

      const apiKey = process.env.OCR_SPACE_API_KEY;

      if (!apiKey) {
        logger.error("OCR.Space API key is not configured.");
        return sendError(res, "OCR service is not configured.", 500);
      }

      let uploadedFile;

      try {
        uploadedFile = await parseUploadedFile(req);
      } catch (error) {
        const message = error.message || "Invalid document upload request.";
        const status = message.includes("500 KB") ? 413 : 400;
        return sendError(res, message, status);
      }

      const extension = uploadedFile.filename
          .split(".")
          .pop()
          .toLowerCase();

      if (!Object.hasOwn(ALLOWED_TYPES, extension)) {
        return sendError(
            res,
            "OCR supports JPG, JPEG, PNG and PDF documents.",
            400,
        );
      }

      if (uploadedFile.mimeType !== ALLOWED_TYPES[extension]) {
        return sendError(
            res,
            "The selected file type does not match its extension.",
            400,
        );
      }

      if (!uploadedFile.buffer?.length) {
        return sendError(res, "The selected document is empty.", 400);
      }

      if (!isValidSignature(uploadedFile.buffer, extension)) {
        return sendError(
            res,
            "The file content does not match its file type.",
            400,
        );
      }

      const ocrForm = new FormData();

      ocrForm.append(
          "file",
          new Blob([uploadedFile.buffer], {
            type: uploadedFile.mimeType,
          }),
          uploadedFile.filename,
      );

      ocrForm.append("language", "eng");
      ocrForm.append("OCREngine", "3");
      ocrForm.append("isTable", "true");
      ocrForm.append("detectOrientation", "true");
      ocrForm.append("scale", "true");
      ocrForm.append("isOverlayRequired", "false");

      let response;

      try {
        response = await fetch(
            "https://api.ocr.space/parse/image",
            {
              method: "POST",
              headers: {
                apikey: apiKey,
              },
              body: ocrForm,
              signal: AbortSignal.timeout(120000),
            },
        );
      } catch (error) {
        if (error.name === "TimeoutError") {
          return sendError(
              res,
              "OCR processing timed out. Please try again.",
              504,
          );
        }

        logger.warn("OCR.Space connection failed.");
        return sendError(
            res,
            "OCR service request failed. Please try again.",
            502,
        );
      }

      if (!response.ok) {
        logger.warn("OCR.Space HTTP error:", response.status);
        return sendError(
            res,
            "OCR service returned an unexpected response.",
            502,
        );
      }

      let data;

      try {
        data = await response.json();
      } catch {
        return sendError(
            res,
            "OCR service returned an invalid page result.",
            502,
        );
      }

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return sendError(
            res,
            "OCR service returned an unexpected response.",
            502,
        );
      }

      const parsedResults = Array.isArray(data.ParsedResults) ?
      data.ParsedResults :
      [];

      if (
        data.IsErroredOnProcessing === true ||
      ![1, 2].includes(data.OCRExitCode)
      ) {
        return sendError(
            res,
            "OCR.Space could not process this document. " +
            "Please try a clearer file.",
            422,
        );
      }

      if (
        parsedResults.some(
            (page) =>
              !page ||
          typeof page !== "object" ||
          typeof page.ParsedText !== "string",
        )
      ) {
        return sendError(
            res,
            "OCR service returned an invalid page result.",
            502,
        );
      }

      const text = parsedResults
          .map((page) => page.ParsedText)
          .join("\n\n")
          .trim();

      const hasNoTextMessage =
      /^\s*(?:\*+\s*)?(?:\[)?\s*no text (?:detected|found)\b/i.test(text);

      if (!text || hasNoTextMessage) {
        return res.status(422).json({
          success: false,
          error:
          "The document was received, but OCR could not detect " +
          "readable text. Try a clearer or higher-resolution scan.",
          engine: "3",
          pageCount: parsedResults.length,
        });
      }

      return res.status(200).json({
        success: true,
        text,
        engine: "3",
        pageCount: parsedResults.length,
      });
    },
);


const SUPER_ADMIN_UID = "gm7L9ZxaqOUIm9qBP9Lf2sxDLh92";
/**
 * Normalizes a user role for consistent comparison.
 * @param {string} role User role.
 * @return {string} Normalized role.
 */
function normalizeRole(role) {
  return String(role || "")
      .toLowerCase()
      .replace(/[\s_-]/g, "");
}

exports.deleteApi = onRequest(
    {
      timeoutSeconds: 60,
      memory: "256MiB",
    },
    async (req, res) => {
      if (req.method !== "POST") {
        res.set("Allow", "POST");
        return res.status(405).json({
          success: false,
          error: "Method not allowed.",
        });
      }

      try {
      // 1. Verify authentication
        const authorization = req.get("authorization");
        const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

        if (!token) {
          return res.status(401).json({
            success: false,
            error: "Authentication required.",
          });
        }

        const adminAuth = admin.auth();
        const adminDb = admin.firestore();

        const decoded = await adminAuth.verifyIdToken(token, true);

        // 2. Verify caller profile and role
        const callerRef = adminDb.collection("users").doc(decoded.uid);
        const callerSnap = await callerRef.get();

        if (!callerSnap.exists) {
          return res.status(403).json({
            success: false,
            error: "User profile not found.",
          });
        }

        const caller = callerSnap.data();

        const callerIsSuperAdmin =
        decoded.uid === SUPER_ADMIN_UID ||
        normalizeRole(caller.role) === "superadmin";

        if (!callerIsSuperAdmin || caller.active !== true) {
          return res.status(403).json({
            success: false,
            error: "Only an active Super Admin can delete users.",
          });
        }

        // 3. Validate request body
        const body = req.body;

        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return res.status(400).json({
            success: false,
            error: "Invalid request data.",
          });
        }

        const userId =
        typeof body.userId === "string" ? body.userId.trim() : "";

        if (!userId || userId.length > 128 || userId.includes("/")) {
          return res.status(400).json({
            success: false,
            error: "Invalid user ID.",
          });
        }

        if (userId === decoded.uid) {
          return res.status(400).json({
            success: false,
            error: "You cannot delete your own account.",
          });
        }

        // Protect primary Super Admin
        if (userId === SUPER_ADMIN_UID) {
          return res.status(403).json({
            success: false,
            error: "The primary Super Admin account cannot be deleted.",
          });
        }

        const targetRef = adminDb.collection("users").doc(userId);
        const targetSnap = await targetRef.get();

        if (!targetSnap.exists) {
          return res.status(404).json({
            success: false,
            error: "User profile not found.",
          });
        }

        const target = targetSnap.data();

        // Never delete another Super Admin
        if (normalizeRole(target.role) === "superadmin") {
          return res.status(403).json({
            success: false,
            error: "A Super Admin account cannot be deleted here.",
          });
        }

        // 4. Delete Firebase Authentication account
        try {
          await adminAuth.deleteUser(userId);
        } catch (error) {
          if (error.code !== "auth/user-not-found") {
            throw error;
          }
        }

        // 5. Create audit log and delete Firestore profile
        const auditRef = adminDb.collection("audit_logs").doc();
        const batch = adminDb.batch();

        batch.set(auditRef, {
          action: "USER_DELETED",
          category: "USER_MANAGEMENT",

          actor: {
            uid: decoded.uid,
            name: caller.name || "",
            email: caller.email || decoded.email || "",
            role: caller.role || "Super Admin",
          },

          target: {
            uid: userId,
            name: target.name || "",
            email: target.email || "",
            department: target.department || "",
            role: target.role || "",
            previousActiveStatus: target.active === true,
          },

          description:
          `User ${target.name || target.email || userId} was deleted.`,

          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        batch.delete(targetRef);

        await batch.commit();

        return res.status(200).json({
          success: true,
          message: "User deleted successfully.",
        });
      } catch (error) {
        if (
          error.code === "auth/id-token-expired" ||
        error.code === "auth/id-token-revoked" ||
        error.code === "auth/invalid-id-token" ||
        error.code === "auth/argument-error"
        ) {
          return res.status(401).json({
            success: false,
            error: "Invalid or expired session. Please sign in again.",
          });
        }

        logger.error("Delete user API error:", error);

        return res.status(500).json({
          success: false,
          error: "Delete failed. Please check server logs.",
        });
      }
    },
);
