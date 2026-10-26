
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import {
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    setDoc,
    updateDoc,
} from "firebase/firestore";
import { auth, db } from "../../../lib/firebase";

const SUPER_ADMIN_UID = "gm7L9ZxaqOUIm9qBP9Lf2sxDLh92";

const POLLUTION_ID = "1IvBqNrEgKRiWUjXu5hl";

const INSURANCE_IDS = [
    "ZKhrXeP5qZ5J79v4vvyR",
    "k48EWCcFFe1coBaVCsGI",
];

export default function DataFixPage() {
    const router = useRouter();

    const [authorized, setAuthorized] = useState(false);
    const [loading, setLoading] = useState(true);
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState("");

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (user) => {
            if (!user) {
                router.replace("/");
                return;
            }

            setAuthorized(user.uid === SUPER_ADMIN_UID);
            setLoading(false);
        });

        return unsubscribe;
    }, [router]);

    async function migrateData() {
        if (running || !authorized) return;

        const confirmed = window.confirm(
            "Test data migration shuru karein? Pollution move hoga aur Insurance records update honge."
        );

        if (!confirmed) return;

        setRunning(true);
        setResult("");

        try {
            // 1. Pollution source aur destination check karo.
            const pollutionSourceRef = doc(
                db,
                "it_devices",
                POLLUTION_ID
            );

            const pollutionDestinationRef = doc(
                db,
                "vehicles",
                POLLUTION_ID
            );

            const pollutionSource = await getDoc(pollutionSourceRef);
            const pollutionDestination = await getDoc(
                pollutionDestinationRef
            );

            if (!pollutionSource.exists()) {
                throw new Error(
                    "Pollution source record nahi mila. Migration rok di gayi."
                );
            }

            if (pollutionDestination.exists()) {
                throw new Error(
                    "Vehicles mein same ID pehle se hai. Duplicate se bachne ke liye migration rok di."
                );
            }

            const pollutionData = pollutionSource.data();

            if (
                pollutionData.category !== "Pollution" ||
                !pollutionData.certificateNo ||
                !pollutionData.vehicleNo
            ) {
                throw new Error(
                    "Pollution record verify nahi hua. Source data change nahi kiya."
                );
            }

            // 2. Dono Insurance records ko pehle verify karo.
            const insuranceRefs = INSURANCE_IDS.map((id) =>
                doc(db, "vehicles", id)
            );

            const insuranceSnapshots = await Promise.all(
                insuranceRefs.map((ref) => getDoc(ref))
            );

            for (const snapshot of insuranceSnapshots) {
                if (!snapshot.exists()) {
                    throw new Error(
                        `Insurance record ${snapshot.id} nahi mila. Migration rok di gayi.`
                    );
                }

                const data = snapshot.data();

                if (
                    !data.productName ||
                    !data.policyNo ||
                    data.category !== "Insurance"
                ) {
                    throw new Error(
                        `Insurance record ${snapshot.id} ka format unexpected hai. Koi migration nahi ki gayi.`
                    );
                }
            }

            // 3. Pollution ko Vehicles mein copy karo.
            await setDoc(pollutionDestinationRef, {
                ...pollutionData,
                category: "Vehicles",
                type: "Pollution",
            });

            // 4. Destination verify hone ke baad source delete karo.
            const movedRecord = await getDoc(pollutionDestinationRef);

            if (
                !movedRecord.exists() ||
                movedRecord.data().certificateNo !==
                    pollutionData.certificateNo ||
                movedRecord.data().vehicleNo !== pollutionData.vehicleNo ||
                movedRecord.data().type !== "Pollution"
            ) {
                throw new Error(
                    "Pollution destination verification fail hua. Original record delete nahi kiya."
                );
            }

            await deleteDoc(pollutionSourceRef);

            // 5. Insurance records standardize karo.
            for (const ref of insuranceRefs) {
                await updateDoc(ref, {
                    category: "Vehicles",
                    type: "Insurance",
                });
            }

            // 6. Final verification.
            const [devicesFinal, vehiclesFinal] = await Promise.all([
                getDocs(collection(db, "it_devices")),
                getDocs(collection(db, "vehicles")),
            ]);

            const pollutionCount = vehiclesFinal.docs.filter((item) => {
                const data = item.data();
                return (
                    data.category === "Vehicles" &&
                    data.type === "Pollution"
                );
            }).length;

            const insuranceCount = vehiclesFinal.docs.filter((item) => {
                const data = item.data();
                return (
                    data.category === "Vehicles" &&
                    data.type === "Insurance"
                );
            }).length;

            const oldPollutionCount = devicesFinal.docs.filter((item) => {
                const data = item.data();
                return (
                    data.category === "Pollution" &&
                    data.certificateNo === pollutionData.certificateNo
                );
            }).length;

            if (
                pollutionCount < 1 ||
                insuranceCount < 2 ||
                oldPollutionCount !== 0
            ) {
                throw new Error(
                    "Migration hui hai, lekin final verification expected result se match nahi hua. Neeche diye counts check karo."
                );
            }

            setResult(
                `Migration successful!\n\nIT Devices documents: ${devicesFinal.size}\nVehicles documents: ${vehiclesFinal.size}\nPollution records: ${pollutionCount}\nInsurance records: ${insuranceCount}\n\nAMC aur Warranty ke records move nahi kiye gaye.`
            );
        } catch (error) {
            console.error("Migration error:", error);

            setResult(
                `Migration complete nahi hui:\n${error.message}\n\nFirestore mein current records verify karo. Agar beech mein error aaya, kuch changes pehle se apply ho sakte hain. Dobara run karne se pehle data check karna.`
            );
        } finally {
            setRunning(false);
        }
    }

    if (loading) {
        return <main className="p-8">Checking access...</main>;
    }

    if (!authorized) {
        return (
            <main className="p-8">
                <h1 className="text-xl font-bold">Access denied</h1>
                <p className="mt-2">
                    Ye page sirf configured Super Admin account ke liye hai.
                </p>
                <button
                    className="mt-4 text-blue-700 underline"
                    onClick={() => router.push("/dashboard")}
                >
                    Back to Dashboard
                </button>
            </main>
        );
    }

    return (
        <main className="mx-auto max-w-3xl p-6">
            <h1 className="text-2xl font-bold">
                Test Data Migration
            </h1>

            <p className="mt-3 text-slate-600">
                Pollution ko Vehicles mein move karega aur dono Insurance
                records ko standard category/type dega.
            </p>

            <ul className="mt-4 list-disc space-y-2 pl-6">
                <li>AMC aur Warranty untouched rahenge.</li>
                <li>Compliance untouched rahega.</li>
                <li>Pollution source verify hone ke baad hi delete hoga.</li>
                <li>Migration ke baad document counts verify honge.</li>
            </ul>

            <button
                type="button"
                onClick={migrateData}
                disabled={running}
                className="mt-6 rounded-lg bg-blue-700 px-5 py-3 font-semibold text-white disabled:opacity-50"
            >
                {running ? "Migrating..." : "Run Test Data Migration"}
            </button>

            {result && (
                <pre className="mt-6 whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
                    {result}
                </pre>
            )}

            <button
                type="button"
                onClick={() => router.push("/dashboard")}
                className="mt-5 block text-sm font-semibold text-blue-700"
            >
                ← Back to Dashboard
            </button>
        </main>
    );
}
