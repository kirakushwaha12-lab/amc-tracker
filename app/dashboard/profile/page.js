
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    EmailAuthProvider,
    onAuthStateChanged,
    reauthenticateWithCredential,
    updatePassword,
    updateProfile,
} from "firebase/auth";
import {
    doc,
    getDoc,
    serverTimestamp,
    setDoc,
} from "firebase/firestore";
import { auth, db } from "../../../lib/firebase";

export default function ProfilePage() {
    const router = useRouter();

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [changingPassword, setChangingPassword] = useState(false);
    const [showPasswordForm, setShowPasswordForm] = useState(false);

    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [department, setDepartment] = useState("");
    const [role, setRole] = useState("");

    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");

    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            if (!user) {
                router.replace("/");
                return;
            }

            setLoading(true);
            setError("");

            try {
                const profileSnapshot = await getDoc(
                    doc(db, "users", user.uid)
                );

                const data = profileSnapshot.exists()
                    ? profileSnapshot.data()
                    : {};

                setName(
                    data.name ||
                    data.displayName ||
                    user.displayName ||
                    ""
                );
                setEmail(user.email || data.email || "");
                setDepartment(data.department || "");
                setRole(data.role || "Viewer");
            } catch (err) {
                console.error("Profile loading error:", err);
                setError(
                    "Unable to load profile. Check Firestore permissions."
                );
            } finally {
                setLoading(false);
            }
        });

        return () => unsubscribe();
    }, [router]);

    async function handleSaveProfile(event) {
        event.preventDefault();
        setError("");
        setSuccess("");

        const user = auth.currentUser;

        if (!user) {
            setError("Please sign in again.");
            return;
        }

        if (!name.trim()) {
            setError("Please enter your name.");
            return;
        }

        setSaving(true);

        try {
            await setDoc(
                doc(db, "users", user.uid),
                {
                    name: name.trim(),
                    email: user.email || email,
                    department: department.trim(),
                    updatedAt: serverTimestamp(),
                },
                { merge: true }
            );

            if (user.displayName !== name.trim()) {
                await updateProfile(user, {
                    displayName: name.trim(),
                });
            }

            setSuccess("Profile updated successfully.");
        } catch (err) {
            console.error("Profile update error:", err);
            setError(
                err.code === "permission-denied"
                    ? "Permission denied. Check Firestore security rules."
                    : "Unable to save profile. Please try again."
            );
        } finally {
            setSaving(false);
        }
    }

    async function handleChangePassword(event) {
        event.preventDefault();
        setError("");
        setSuccess("");

        const user = auth.currentUser;

        if (!user || !user.email) {
            setError("Please sign in again.");
            return;
        }

        if (newPassword.length < 6) {
            setError("New password must be at least 6 characters.");
            return;
        }

        if (newPassword !== confirmPassword) {
            setError("New passwords do not match.");
            return;
        }

        if (currentPassword === newPassword) {
            setError("New password must differ from current password.");
            return;
        }

        setChangingPassword(true);

        try {
            const credential = EmailAuthProvider.credential(
                user.email,
                currentPassword
            );

            await reauthenticateWithCredential(user, credential);
            await updatePassword(user, newPassword);

            setCurrentPassword("");
            setNewPassword("");
            setConfirmPassword("");
            setShowPasswordForm(false);
            setSuccess("Password changed successfully.");
        } catch (err) {
            console.error("Password change error:", err);

            const messages = {
                "auth/invalid-credential":
                    "Current password is incorrect.",
                "auth/wrong-password":
                    "Current password is incorrect.",
                "auth/weak-password":
                    "Choose a stronger password.",
                "auth/requires-recent-login":
                    "Please sign out and sign in again, then retry.",
                "auth/too-many-requests":
                    "Too many attempts. Please try again later.",
            };

            setError(
                messages[err.code] ||
                "Unable to change password. Please try again."
            );
        } finally {
            setChangingPassword(false);
        }
    }

    if (loading) {
        return (
            <main className="flex min-h-screen items-center justify-center bg-slate-100 text-slate-600">
                Loading profile...
            </main>
        );
    }

    return (
        <main className="min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8">
            <div className="mx-auto max-w-[1600px]">
                

                <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <h1 className="text-3xl font-bold text-slate-900">
                            My Profile
                        </h1>
                        <p className="mt-2 text-sm text-slate-500">
                            View and manage your account details and password.
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={() => {
                            setShowPasswordForm((previous) => !previous);
                            setError("");
                            setSuccess("");
                        }}
                        className="rounded-xl bg-blue-700 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-800"
                    >
                        {showPasswordForm ? "Cancel" : "Change Password"}
                    </button>
                </div>

                {error && (
                    <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                        {error}
                    </div>
                )}

                {success && (
                    <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                        {success}
                    </div>
                )}

                <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                    <h2 className="text-lg font-bold text-slate-900">
                        Profile Details
                    </h2>

                    <p className="mt-1 text-sm text-slate-500">
                        Update your personal details. Your role is managed by an authorized administrator.
                    </p>

                    <form
                        onSubmit={handleSaveProfile}
                        className="mt-5 grid gap-4 sm:grid-cols-2"
                    >
                        <label className="text-sm font-medium text-slate-700">
                            Full Name
                            <input
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                required
                                maxLength={100}
                                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-blue-500"
                                placeholder="Enter full name"
                            />
                        </label>

                        <label className="text-sm font-medium text-slate-700">
                            Email
                            <input
                                type="email"
                                value={email}
                                readOnly
                                className="mt-1 w-full cursor-not-allowed rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-slate-500 outline-none"
                            />
                        </label>

                        <label className="text-sm font-medium text-slate-700">
                            Department
                            <input
                                value={department}
                                onChange={(event) =>
                                    setDepartment(event.target.value)
                                }
                                maxLength={100}
                                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-blue-500"
                                placeholder="Enter department"
                            />
                        </label>

                        <label className="text-sm font-medium text-slate-700">
                            Role
                            <input
                                value={role}
                                readOnly
                                className="mt-1 w-full cursor-not-allowed rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-slate-500 outline-none"
                            />
                        </label>

                        <div className="flex flex-wrap gap-3 sm:col-span-2">
                            <button
                                type="submit"
                                disabled={saving}
                                className="rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                {saving ? "Saving..." : "Save Changes"}
                            </button>
                        </div>
                    </form>
                </section>

                {showPasswordForm && (
                    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                        <h2 className="text-lg font-bold text-slate-900">
                            Change Password
                        </h2>

                        <p className="mt-1 text-sm text-slate-500">
                            Verify your current password before setting a new one.
                        </p>

                        <form
                            onSubmit={handleChangePassword}
                            className="mt-5 grid gap-4 sm:grid-cols-2"
                        >
                            <label className="text-sm font-medium text-slate-700 sm:col-span-2">
                                Current Password
                                <input
                                    type="password"
                                    autoComplete="current-password"
                                    value={currentPassword}
                                    onChange={(event) =>
                                        setCurrentPassword(event.target.value)
                                    }
                                    required
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-blue-500"
                                    placeholder="Enter current password"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                New Password
                                <input
                                    type="password"
                                    autoComplete="new-password"
                                    value={newPassword}
                                    onChange={(event) =>
                                        setNewPassword(event.target.value)
                                    }
                                    minLength={6}
                                    required
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-blue-500"
                                    placeholder="At least 6 characters"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Confirm New Password
                                <input
                                    type="password"
                                    autoComplete="new-password"
                                    value={confirmPassword}
                                    onChange={(event) =>
                                        setConfirmPassword(event.target.value)
                                    }
                                    minLength={6}
                                    required
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-blue-500"
                                    placeholder="Re-enter new password"
                                />
                            </label>

                            <div className="flex flex-wrap gap-3 sm:col-span-2">
                                <button
                                    type="submit"
                                    disabled={changingPassword}
                                    className="rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    {changingPassword
                                        ? "Updating..."
                                        : "Update Password"}
                                </button>

                               
                            </div>
                        </form>
                    </section>
                )}
            </div>
        </main>
    );
}
