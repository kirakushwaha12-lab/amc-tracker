"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    deleteUser,
    getAuth,
} from "firebase/auth";
import {
    collection,
    doc,
    getDoc,
    onSnapshot,
    setDoc,
    updateDoc,
    serverTimestamp,
} from "firebase/firestore";
import { getApps, initializeApp } from "firebase/app";
import { auth, db } from "../../../lib/firebase";

const SECONDARY_APP_NAME = "AILUserCreation";

function normalizeRole(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[_-]/g, " ")
        .replace(/\s+/g, " ");
}

function isSuperAdmin(role) {
    const normalized = normalizeRole(role);
    return normalized === "super admin" || normalized === "superadmin";
}

function isAdmin(role) {
    return normalizeRole(role) === "admin";
}

function canAccessUsers(role) {
    return isSuperAdmin(role) || isAdmin(role);
}

function getRole(value) {
    const normalized = normalizeRole(value);

    if (normalized === "super admin" || normalized === "superadmin") {
        return "Super Admin";
    }

    if (normalized === "admin") return "Admin";
    if (normalized === "editor") return "Editor";

    return "Viewer";
}

export default function UsersPage() {
    const router = useRouter();

    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [updatingUserId, setUpdatingUserId] = useState("");
    const [showForm, setShowForm] = useState(false);
    const [currentRole, setCurrentRole] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    const [form, setForm] = useState({
        name: "",
        email: "",
        department: "",
        role: "Viewer",
        password: "",
    });

    useEffect(() => {
        let unsubscribeUsers;
        let cancelled = false;

        const unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
            unsubscribeUsers?.();
            unsubscribeUsers = undefined;

            if (!user) {
                router.replace("/");
                return;
            }

            setLoading(true);
            setError("");

            try {
                const profile = await getDoc(doc(db, "users", user.uid));

                if (cancelled) return;

                const profileData = profile.exists() ? profile.data() : {};
                const role = profileData.role || "";

                setCurrentRole(role);

                if (
                    profileData.active === false ||
                    !canAccessUsers(role)
                ) {
                    setError(
                        "Only an active Admin or Super Admin can access user management."
                    );
                    setLoading(false);
                    return;
                }

                unsubscribeUsers = onSnapshot(
                    collection(db, "users"),
                    (snapshot) => {
                        if (cancelled) return;

                        const list = snapshot.docs.map((item) => {
                            const data = item.data();

                            return {
                                id: item.id,
                                name: data.name || data.displayName || "—",
                                email: data.email || "—",
                                department: data.department || "—",
                                role: getRole(data.role),
                                status:
                                    data.active === false
                                        ? "Inactive"
                                        : "Active",
                            };
                        });

                        list.sort((a, b) =>
                            a.name.localeCompare(b.name)
                        );

                        setUsers(list);
                        setLoading(false);
                    },
                    (err) => {
                        console.error("Users loading error:", err);

                        setError(
                            "Users could not be loaded. Check Firestore security rules."
                        );

                        setLoading(false);
                    }
                );
            } catch (err) {
                console.error("User permission check failed:", err);

                if (!cancelled) {
                    setError(
                        "Unable to verify user access. Check Firestore permissions."
                    );
                    setLoading(false);
                }
            }
        });

        return () => {
            cancelled = true;
            unsubscribeAuth();
            unsubscribeUsers?.();
        };
    }, [router]);

    function updateForm(event) {
        const { name, value } = event.target;

        setForm((previous) => ({
            ...previous,
            [name]: value,
        }));
    }

    async function handleAddUser(event) {
        event.preventDefault();
        setError("");
        setSuccess("");

        if (!canAccessUsers(currentRole)) {
            setError("You do not have permission to add users.");
            return;
        }

        if (
            isAdmin(currentRole) &&
            !["Viewer", "Editor"].includes(form.role)
        ) {
            setError("Admin can create only Viewer and Editor accounts.");
            return;
        }

        if (!isSuperAdmin(currentRole) && !isAdmin(currentRole)) {
            setError("You do not have permission to add users.");
            return;
        }

        if (form.password.length < 6) {
            setError(
                "Temporary password must be at least 6 characters."
            );
            return;
        }

        if (
            !form.name.trim() ||
            !form.email.trim() ||
            !form.department.trim()
        ) {
            setError("Please complete all fields.");
            return;
        }

        setSaving(true);
        let createdUser = null;

        try {
            const secondaryApp =
                getApps().find(
                    (app) => app.name === SECONDARY_APP_NAME
                ) ||
                initializeApp(
                    auth.app.options,
                    SECONDARY_APP_NAME
                );

            const secondaryAuth = getAuth(secondaryApp);

            const credential =
                await createUserWithEmailAndPassword(
                    secondaryAuth,
                    form.email.trim(),
                    form.password
                );

            createdUser = credential.user;

            await setDoc(doc(db, "users", createdUser.uid), {
                name: form.name.trim(),
                email: form.email.trim(),
                department: form.department.trim(),
                role: form.role,
                active: true,
                createdAt: serverTimestamp(),
                createdBy: auth.currentUser?.uid || "",
            });

            setSuccess(
                "User created successfully. Share the temporary password securely."
            );

            setForm({
                name: "",
                email: "",
                department: "",
                role: "Viewer",
                password: "",
            });

            setShowForm(false);
        } catch (err) {
            console.error("Add user error:", err);

            if (createdUser) {
                try {
                    await deleteUser(createdUser);
                } catch (cleanupError) {
                    console.error(
                        "Could not roll back new Auth account:",
                        cleanupError
                    );
                }
            }

            if (err.code === "auth/email-already-in-use") {
                setError(
                    "This email already has a Firebase Authentication account."
                );
            } else if (err.code === "auth/weak-password") {
                setError("Choose a stronger temporary password.");
            } else if (
                err.code === "permission-denied" ||
                err.code === "firestore/permission-denied"
            ) {
                setError(
                    "Firestore blocked user creation. Check your published security rules and account permissions."
                );
            } else {
                setError(err.message || "Could not create the user.");
            }
        } finally {
            setSaving(false);
        }
    }

    async function handleRoleChange(userId, newRole) {
        setError("");
        setSuccess("");

        if (!isSuperAdmin(currentRole)) {
            setError("Only Super Admin can change roles.");
            return;
        }

        if (userId === auth.currentUser?.uid) {
            setError("You cannot change your own role here.");
            return;
        }

        const targetUser = users.find(
            (item) => item.id === userId
        );

        if (!targetUser) return;

        if (isSuperAdmin(targetUser.role)) {
            setError(
                "Super Admin accounts are protected from role changes."
            );
            return;
        }

        if (newRole === "Super Admin") {
            setError(
                "Super Admin promotion is disabled here to protect administrator access."
            );
            return;
        }

        if (!["Admin", "Editor", "Viewer"].includes(newRole)) {
            setError("Please select a valid role.");
            return;
        }

        const confirmed = window.confirm(
            `Change ${targetUser.name}'s role to ${newRole}?`
        );

        if (!confirmed) return;

        setUpdatingUserId(userId);

        try {
            await updateDoc(doc(db, "users", userId), {
                role: newRole,
                updatedAt: serverTimestamp(),
                updatedBy: auth.currentUser?.uid || "",
            });

            setSuccess(
                `${targetUser.name}'s role was updated to ${newRole}.`
            );
        } catch (err) {
            console.error("Role update error:", err);
            setError(
                "Role could not be updated. Check Firestore permissions."
            );
        } finally {
            setUpdatingUserId("");
        }
    }

    async function handleStatusToggle(item) {
        setError("");
        setSuccess("");

        if (!isSuperAdmin(currentRole)) {
            setError("Only Super Admin can change user status.");
            return;
        }

        if (item.id === auth.currentUser?.uid) {
            setError("You cannot deactivate your own account.");
            return;
        }

        if (isSuperAdmin(item.role)) {
            setError(
                "Super Admin accounts cannot be deactivated from this page."
            );
            return;
        }

        const makeActive = item.status === "Inactive";
        const nextStatus = makeActive ? "Active" : "Inactive";

        const confirmed = window.confirm(
            `${makeActive ? "Activate" : "Deactivate"} ${item.name}'s account? ${
                makeActive
                    ? "The account will be allowed to access permitted records."
                    : "The account will lose access to protected tracker records."
            }`
        );

        if (!confirmed) return;

        setUpdatingUserId(item.id);

        try {
            await updateDoc(doc(db, "users", item.id), {
                active: makeActive,
                updatedAt: serverTimestamp(),
                updatedBy: auth.currentUser?.uid || "",
            });

            setSuccess(
                `${item.name}'s account is now ${nextStatus}.`
            );
        } catch (err) {
            console.error("User status update error:", err);
            setError(
                "User status could not be updated. Check Firestore permissions."
            );
        } finally {
            setUpdatingUserId("");
        }
    }

    async function handleDeleteUser(item) {
        setError("");
        setSuccess("");

        if (!isSuperAdmin(currentRole)) {
            setError("Only Super Admin can delete users.");
            return;
        }

        if (
            item.id === auth.currentUser?.uid ||
            isSuperAdmin(item.role)
        ) {
            setError("This Super Admin account is protected.");
            return;
        }

        const confirmed = window.confirm(
            `Delete ${item.name}'s account permanently? Their tracker business records will not be deleted.`
        );

        if (!confirmed) return;

        setUpdatingUserId(item.id);

        try {
            const token =
                await auth.currentUser.getIdToken();

            const response = await fetch("/api/users/delete", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ userId: item.id }),
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(
                    result.error || "Could not delete user."
                );
            }

            setSuccess(
                `${item.name}'s account was deleted successfully.`
            );
        } catch (err) {
            console.error("Delete user error:", err);
            setError(err.message || "Could not delete user.");
        } finally {
            setUpdatingUserId("");
        }
    }

    if (loading) {
        return (
            <main className="flex min-h-screen items-center justify-center bg-slate-100 text-sm text-slate-600">
                Loading users...
            </main>
        );
    }

    if (!canAccessUsers(currentRole)) {
        return (
            <main className="min-h-screen bg-slate-100 p-6">
                <div className="mx-auto max-w-3xl rounded-2xl border border-red-200 bg-white p-6">
                    <h1 className="text-xl font-bold text-slate-900">
                        Access denied
                    </h1>
                    <p className="mt-2 text-sm text-red-700">
                        {error ||
                            "Only Admin and Super Admin can access user management."}
                    </p>
                </div>
            </main>
        );
    }

    const superAdmin = isSuperAdmin(currentRole);
    const admin = isAdmin(currentRole);

    return (
        <main className="min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8">
            <div className="mx-auto max-w-[1600px]">
                <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <h1 className="text-3xl font-bold text-slate-900">
                            User Management
                        </h1>
                        <p className="mt-2 text-sm text-slate-500">
                            Manage tracker accounts, departments and access roles.
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={() => {
                            setShowForm((previous) => !previous);
                            setError("");
                            setSuccess("");
                        }}
                        className="rounded-xl bg-blue-700 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-800"
                    >
                        {showForm ? "Cancel" : "+ Add User"}
                    </button>
                </div>

                {admin && (
                    <p className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                        Admin access: you can create Viewer and Editor accounts and view the user list. Role changes, status changes and deletion are reserved for Super Admin.
                    </p>
                )}

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

                {showForm && (
                    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                        <h2 className="text-lg font-bold text-slate-900">
                            Add New User
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Create a login and assign the user's department and role.
                        </p>

                        <form
                            onSubmit={handleAddUser}
                            className="mt-5 grid gap-4 sm:grid-cols-2"
                        >
                            <label className="text-sm font-medium text-slate-700">
                                Full Name
                                <input
                                    name="name"
                                    value={form.name}
                                    onChange={updateForm}
                                    required
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-blue-500"
                                    placeholder="Enter full name"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Email
                                <input
                                    name="email"
                                    type="email"
                                    value={form.email}
                                    onChange={updateForm}
                                    required
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-blue-500"
                                    placeholder="name@company.com"
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Department
                                <input
                                    name="department"
                                    value={form.department}
                                    onChange={updateForm}
                                    required
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-blue-500"
                                    placeholder="IT, HR, Accounts..."
                                />
                            </label>

                            <label className="text-sm font-medium text-slate-700">
                                Role
                                <select
                                    name="role"
                                    value={form.role}
                                    onChange={updateForm}
                                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-blue-500"
                                >
                                    <option value="Viewer">
                                        Viewer — View records
                                    </option>
                                    <option value="Editor">
                                        Editor — Add and edit records
                                    </option>

                                    {superAdmin && (
                                        <option value="Admin">
                                            Admin — Manage records and view users
                                        </option>
                                    )}
                                </select>
                            </label>

                            <label className="text-sm font-medium text-slate-700 sm:col-span-2">
                                Temporary Password
                                <input
                                    name="password"
                                    type="password"
                                    value={form.password}
                                    onChange={updateForm}
                                    required
                                    minLength={6}
                                    autoComplete="new-password"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-blue-500"
                                    placeholder="At least 6 characters"
                                />
                                <span className="mt-1 block text-xs font-normal text-slate-500">
                                    Share this password securely. The user should change it after signing in.
                                </span>
                            </label>

                            <div className="flex flex-wrap gap-3 sm:col-span-2">
                                <button
                                    type="submit"
                                    disabled={saving}
                                    className="rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    {saving ? "Creating User..." : "Create User"}
                                </button>

                                <button
                                    type="button"
                                    onClick={() => setShowForm(false)}
                                    disabled={saving}
                                    className="rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                            </div>
                        </form>
                    </section>
                )}

                <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
                        <div>
                            <h2 className="font-bold text-slate-900">
                                Registered Users
                            </h2>
                            <p className="mt-1 text-sm text-slate-500">
                                {users.length} user account(s)
                            </p>
                        </div>
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[1100px] text-left text-sm">
                            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                <tr>
                                    <th className="px-5 py-4">S. No.</th>
                                    <th className="px-5 py-4">Name</th>
                                    <th className="px-5 py-4">Email</th>
                                    <th className="px-5 py-4">Department</th>
                                    <th className="px-5 py-4">Role</th>
                                    <th className="px-5 py-4">Status</th>
                                    <th className="px-5 py-4">Actions</th>
                                </tr>
                            </thead>

                            <tbody className="divide-y divide-slate-100">
                                {users.map((item, index) => {
                                    const isSelf =
                                        item.id === auth.currentUser?.uid;
                                    const isProtectedAdmin =
                                        isSuperAdmin(item.role);
                                    const isUpdating =
                                        updatingUserId === item.id;

                                    return (
                                        <tr
                                            key={item.id}
                                            className="hover:bg-slate-50"
                                        >
                                            <td className="px-5 py-4 text-slate-500">
                                                {index + 1}
                                            </td>

                                            <td className="px-5 py-4 font-medium text-slate-900">
                                                {item.name}
                                                {isSelf && (
                                                    <span className="ml-2 text-xs text-blue-600">
                                                        You
                                                    </span>
                                                )}
                                            </td>

                                            <td className="px-5 py-4 text-slate-600">
                                                {item.email}
                                            </td>

                                            <td className="px-5 py-4 text-slate-600">
                                                {item.department}
                                            </td>

                                            <td className="px-5 py-4">
                                                {isProtectedAdmin ? (
                                                    <span className="inline-flex rounded-full bg-purple-50 px-3 py-1 text-xs font-semibold text-purple-700">
                                                        Super Admin
                                                    </span>
                                                ) : (
                                                    <span className="text-sm font-medium text-slate-700">
                                                        {item.role}
                                                    </span>
                                                )}
                                            </td>

                                            <td className="px-5 py-4">
                                                <span
                                                    className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
                                                        item.status === "Active"
                                                            ? "bg-emerald-50 text-emerald-700"
                                                            : "bg-red-50 text-red-700"
                                                    }`}
                                                >
                                                    {item.status}
                                                </span>
                                            </td>

                                            <td className="px-5 py-4">
                                                {!superAdmin ||
                                                isProtectedAdmin ||
                                                isSelf ? (
                                                    <span className="text-xs text-slate-400">
                                                        {isProtectedAdmin || isSelf
                                                            ? "Protected"
                                                            : "View only"}
                                                    </span>
                                                ) : (
                                                    <div className="flex items-center gap-2">
                                                        <select
                                                            value={item.role}
                                                            disabled={isUpdating}
                                                            onChange={(event) =>
                                                                handleRoleChange(
                                                                    item.id,
                                                                    event.target.value
                                                                )
                                                            }
                                                            className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"
                                                            aria-label={`Change role for ${item.name}`}
                                                        >
                                                            <option value="Viewer">
                                                                Viewer
                                                            </option>
                                                            <option value="Editor">
                                                                Editor
                                                            </option>
                                                            <option value="Admin">
                                                                Admin
                                                            </option>
                                                        </select>

                                                        <button
                                                            type="button"
                                                            disabled={isUpdating}
                                                            onClick={() =>
                                                                handleStatusToggle(item)
                                                            }
                                                            className={`whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50 ${
                                                                item.status === "Active"
                                                                    ? "border border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                                                                    : "border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                                                            }`}
                                                        >
                                                            {isUpdating
                                                                ? "Please wait..."
                                                                : item.status === "Active"
                                                                  ? "Deactivate"
                                                                  : "Activate"}
                                                        </button>

                                                        <button
                                                            type="button"
                                                            disabled={isUpdating}
                                                            onClick={() =>
                                                                handleDeleteUser(item)
                                                            }
                                                            className="whitespace-nowrap rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
                                                        >
                                                            {isUpdating
                                                                ? "Please wait..."
                                                                : "Delete"}
                                                        </button>
                                                    </div>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}

                                {!users.length && (
                                    <tr>
                                        <td
                                            colSpan={7}
                                            className="px-5 py-10 text-center text-slate-500"
                                        >
                                            No registered users found.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </section>

                <p className="mt-4 text-xs leading-5 text-slate-500">
                    Note: Role and status changes depend on published Firestore security rules. Users who are already signed in may need to refresh the app for UI changes to appear.
                </p>
            </div>
        </main>
    );
}