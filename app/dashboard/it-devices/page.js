
"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { collection, onSnapshot } from "firebase/firestore";
import { auth, db } from "../../../lib/firebase";
import RecordsTable from "../components/RecordsTable";

export default function ITDevicesPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const category = searchParams.get("category") || "All";
    const [records, setRecords] = useState([]);
    const filteredRecords =
        category === "All"
            ? records
            : records.filter((record) => record.category === category);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        let unsubscribeRecords;

        const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
            if (!user) {
                router.replace("/");
                setLoading(false);
                return;
            }

            unsubscribeRecords?.();

            unsubscribeRecords = onSnapshot(
                collection(db, "it_devices"),
                (snapshot) => {
                    setRecords(
                        snapshot.docs.map((doc) => ({
                            id: doc.id,
                            ...doc.data(),
                        }))
                    );
                    setError("");
                    setLoading(false);
                },
                (err) => {
                    console.error("IT Devices read error:", err);
                    setError(
                        "Records could not be loaded. Check Firestore permissions."
                    );
                    setLoading(false);
                }
            );
        });

        return () => {
            unsubscribeAuth();
            unsubscribeRecords?.();
        };
    }, [router]);

    return (
        <main className="min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8">
            <div className="mx-auto max-w-[1600px]">
                <button
                    type="button"
                    onClick={() => router.push("/dashboard")}
                    className="text-sm font-semibold text-blue-700 hover:text-blue-900"
                >
                    ← Back to Dashboard
                </button>

                <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-bold text-slate-900">
                            IT Devices
                        </h1>
                        <p className="mt-1 text-sm text-slate-500">
                            AMC, Warranty & Software License Records
                        </p>
                    </div>
                </div>

                <div className="mt-6">
                    <RecordsTable
                        title={category === "All" ? "IT Devices" : category}
                        icon="💻"
                        records={filteredRecords}
                        loading={loading}
                        error={error}
                        showHeader={false}
                        showAddButton={false}
                        showFooter={false}
                    />
                </div>
            </div>
        </main>
    );
}
