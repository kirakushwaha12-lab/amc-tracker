
import { NextResponse } from "next/server";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

export const runtime = "nodejs";

function getAdminApp() {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

    if (!projectId || !clientEmail || !privateKey) {
        throw new Error("Firebase Admin credentials are not configured.");
    }

    const existingApp = getApps().find((app) => app.name === "[DEFAULT]");
    if (existingApp) return existingApp;

    return initializeApp({
        credential: cert({ projectId, clientEmail, privateKey }),
    });
}

export async function POST(request) {
    try {
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
        const callerSnap = await adminDb.collection("users").doc(decoded.uid).get();

        if (!callerSnap.exists) {
            return NextResponse.json(
                { error: "User profile not found." },
                { status: 403 }
            );
        }

        const caller = callerSnap.data();
        const role = String(caller.role || "").toLowerCase().replace(/[\s_-]/g, "");

        if (role !== "superadmin" || caller.active === false) {
            return NextResponse.json(
                { error: "Only an active Super Admin can delete users." },
                { status: 403 }
            );
        }

        const body = await request.json();
        const userId = String(body.userId || "").trim();

        if (!userId || userId === decoded.uid) {
            return NextResponse.json(
                { error: "Invalid user ID. You cannot delete your own account." },
                { status: 400 }
            );
        }

        const targetRef = adminDb.collection("users").doc(userId);
        const targetSnap = await targetRef.get();

        if (targetSnap.exists) {
            const target = targetSnap.data();
            const targetRole = String(target.role || "")
                .toLowerCase()
                .replace(/[\s_-]/g, "");

            if (targetRole === "superadmin") {
                return NextResponse.json(
                    { error: "A Super Admin account cannot be deleted here." },
                    { status: 403 }
                );
            }
        }

        try {
            await adminAuth.deleteUser(userId);
        } catch (error) {
            if (error.code !== "auth/user-not-found") throw error;
        }

        // Delete only the user profile; preserve all business records.
        await targetRef.delete();

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Delete user API error:", error);

        if (
            error.code === "auth/id-token-expired" ||
            error.code === "auth/id-token-revoked"
        ) {
            return NextResponse.json(
                { error: "Session expired. Please sign in again." },
                { status: 401 }
            );
        }

        return NextResponse.json(
            { error: "Delete failed. Check Firebase Admin credentials and server logs." },
            { status: 500 }
        );
    }
}
