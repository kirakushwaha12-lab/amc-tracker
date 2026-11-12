
import { NextResponse } from "next/server";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import {
    FieldValue,
    getFirestore,
} from "firebase-admin/firestore";

export const runtime = "nodejs";

const SUPER_ADMIN_UID = "gm7L9ZxaqOUIm9qBP9Lf2sxDLh92";

function normalizeRole(role) {
    return String(role || "")
        .toLowerCase()
        .replace(/[\s_-]/g, "");
}

function getAdminApp() {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

    if (!projectId || !clientEmail || !privateKey) {
        throw new Error("Firebase Admin credentials are not configured.");
    }

    const existingApp = getApps().find(
        (app) => app.name === "[DEFAULT]"
    );

    if (existingApp) return existingApp;

    return initializeApp({
        credential: cert({
            projectId,
            clientEmail,
            privateKey,
        }),
    });
}

export async function POST(request) {
    try {
        // 1. Verify authentication
        const authorization = request.headers.get("authorization");

        const token = authorization?.startsWith("Bearer ")
            ? authorization.slice(7)
            : null;

        if (!token) {
            return NextResponse.json(
                { error: "Authentication required." },
                { status: 401 }
            );
        }

        const app = getAdminApp();
        const adminAuth = getAuth(app);
        const adminDb = getFirestore(app);

        const decoded = await adminAuth.verifyIdToken(token, true);

        // 2. Verify caller profile and role
        const callerRef = adminDb.collection("users").doc(decoded.uid);
        const callerSnap = await callerRef.get();

        if (!callerSnap.exists) {
            return NextResponse.json(
                { error: "User profile not found." },
                { status: 403 }
            );
        }

        const caller = callerSnap.data();

        const callerIsSuperAdmin =
            decoded.uid === SUPER_ADMIN_UID ||
            normalizeRole(caller.role) === "superadmin";

        if (!callerIsSuperAdmin || caller.active !== true) {
            return NextResponse.json(
                {
                    error: "Only an active Super Admin can delete users.",
                },
                { status: 403 }
            );
        }

        // 3. Validate target user
        let body;

        try {
            body = await request.json();
        } catch {
            return NextResponse.json(
                { error: "Invalid request format." },
                { status: 400 }
            );
        }

        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return NextResponse.json(
                { error: "Invalid request data." },
                { status: 400 }
            );
        }

        const userId =
            typeof body.userId === "string"
                ? body.userId.trim()
                : "";

        if (
            !userId ||
            userId.length > 128 ||
            userId.includes("/")
        ) {
            return NextResponse.json(
                { error: "Invalid user ID." },
                { status: 400 }
            );
        }

        if (userId === decoded.uid) {
            return NextResponse.json(
                {
                    error: "You cannot delete your own account.",
                },
                { status: 400 }
            );
        }



        // Protect the fixed Super Admin account.
        if (userId === SUPER_ADMIN_UID) {
            return NextResponse.json(
                {
                    error: "The primary Super Admin account cannot be deleted.",
                },
                { status: 403 }
            );
        }

        const targetRef = adminDb.collection("users").doc(userId);
        const targetSnap = await targetRef.get();

        if (!targetSnap.exists) {
            return NextResponse.json(
                { error: "User profile not found." },
                { status: 404 }
            );
        }

        const target = targetSnap.data();

        // Never delete another Super Admin.
        if (normalizeRole(target.role) === "superadmin") {
            return NextResponse.json(
                {
                    error: "A Super Admin account cannot be deleted here.",
                },
                { status: 403 }
            );
        }

        // 4. Delete Firebase Authentication account.
        // If already missing, continue with profile deletion.
        try {
            await adminAuth.deleteUser(userId);
        } catch (error) {
            if (error.code !== "auth/user-not-found") {
                throw error;
            }
        }

        // 5. Create permanent audit entry and delete profile
        // in one Firestore batch.
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

            description: `User ${target.name || target.email || userId} was deleted.`,

            createdAt: FieldValue.serverTimestamp(),
        });

        batch.delete(targetRef);

        await batch.commit();

        return NextResponse.json({
            success: true,
            message: "User deleted successfully.",
        });

    } catch (error) {
        console.error("Delete user API error:", error);

        if (
            error.code === "auth/id-token-expired" ||
            error.code === "auth/id-token-revoked" ||
            error.code === "auth/invalid-id-token" ||
            error.code === "auth/argument-error"
        ) {
            return NextResponse.json(
                { error: "Invalid or expired session. Please sign in again." },
                { status: 401 }
            );
        }
        return NextResponse.json(
            {
                error: "Delete failed. Check Firebase Admin credentials and server logs.",
            },
            { status: 500 }
        );
    }
}
