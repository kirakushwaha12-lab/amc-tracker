
"use client";

import { useState } from "react";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "../../../lib/firebase";

const BLUE = "#0b4da2";

function DateField({ name, label, value, onChange, min }) {
    return (
        <label className="text-sm font-medium text-slate-700">
            {label} *
            <input
                required
                type="date"
                name={name}
                value={value}
                min={min}
                onChange={(event) => onChange(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
            />
        </label>
    );
}

function Field({
    label,
    name,
    placeholder,
    required = true,
    type = "text",
}) {
    return (
        <label className="text-sm font-medium text-slate-700">
            {label}{required ? " *" : ""}
            <input
                required={required}
                type={type}
                min={type === "number" ? "0" : undefined}
                step={type === "number" ? "0.01" : undefined}
                name={name}
                placeholder={placeholder}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
            />
        </label>
    );
}

export default function RecordForm({
    type = "IT Devices",
    onClose,
    onSaved,
}) {
    const [startDate, setStartDate] = useState("");
    const [expiryDate, setExpiryDate] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const isVehicle = type === "Vehicles";

    async function handleSubmit(event) {
        event.preventDefault();
        setError("");

        const formData = new FormData(event.currentTarget);

        const start = formData.get("startDate");
        const expiry = formData.get("expiryDate");

        if (start && expiry && expiry < start) {
            setError("Expiry Date cannot be before Start Date.");
            return;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const expiryDateValue = new Date(`${expiry}T00:00:00`);
        const daysRemaining = Math.ceil(
            (expiryDateValue.getTime() - today.getTime()) / 86400000
        );

        const status =
            daysRemaining < 0
                ? "Expired"
                : daysRemaining <= 10
                    ? "Expiring Soon"
                    : "Active";

        let collectionName;
        let record;

        if (!isVehicle) {
            collectionName = "it_devices";

            record = {
                productName: formData.get("productName"),
                assetId: formData.get("assetId") || "",
                category: formData.get("category"),
                vendor: formData.get("vendor"),
                startDate: start,
                endDate: expiry,
                cost: Number(formData.get("cost") || 0),
                status,
                createdAt: serverTimestamp(),
            };
        } else {
            collectionName = "vehicles";

            record = {
                policyNo: formData.get("policyNo"),
                vehicleNo: formData.get("vehicleNo"),
                type: formData.get("type"),
                personName: formData.get("personName"),
                insurerCompany: formData.get("insurerCompany"),
                startDate: start,
                expiryDate: expiry,
                amount: Number(formData.get("amount") || 0),
                noc: formData.get("noc") || "NA",
                status,
                createdAt: serverTimestamp(),
            };
        }

        setSaving(true);

        try {
            await addDoc(collection(db, collectionName), record);
            onSaved?.("Record saved successfully!");
        } catch (err) {
            console.error("Error saving record:", err);

            setError(
                err.code === "permission-denied"
                    ? "Permission denied. Please check Firestore security rules."
                    : "Record could not be saved. Please try again."
            );
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
            <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
                <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
                    <div>
                        <h2 className="text-lg font-bold text-slate-900">
                            Add {type} Record
                        </h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Enter the record details below.
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-lg px-3 py-2 text-xl text-slate-500 hover:bg-slate-100"
                        aria-label="Close form"
                    >
                        ×
                    </button>
                </div>

                <form
                    onSubmit={handleSubmit}
                    className="grid gap-4 p-6 sm:grid-cols-2"
                >
                    {!isVehicle ? (
                        <>
                            <Field
                                label="Product Name"
                                name="productName"
                                placeholder="e.g. Office Laptop"
                            />

                            <Field
                                label="Asset ID"
                                name="assetId"
                                placeholder="e.g. IT-001"
                            />

                            <label className="text-sm font-medium text-slate-700">
                                Category *
                                <select
                                    required
                                    name="category"
                                    defaultValue=""
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                >
                                    <option value="">Select category</option>
                                    <option>AMC</option>
                                    <option>Warranty</option>
                                    <option>Software License</option>
                                </select>
                            </label>

                            <Field label="Vendor" name="vendor" placeholder="Vendor name" />

                            <DateField
                                name="startDate"
                                label="Start Date"
                                value={startDate}
                                onChange={(value) => {
                                    setStartDate(value);
                                    if (expiryDate && value > expiryDate) {
                                        setExpiryDate("");
                                    }
                                }}
                            />

                            <DateField
                                name="expiryDate"
                                label="Expiry Date"
                                value={expiryDate}
                                min={startDate || undefined}
                                onChange={setExpiryDate}
                            />

                            <div className="sm:col-span-2">
                                <Field label="Cost (₹)" name="cost" type="number" />
                            </div>
                        </>
                    ) : (
                        <>
                            <Field label="Policy Number" name="policyNo" />

                            <Field
                                label="Vehicle Number"
                                name="vehicleNo"
                                placeholder="UP-78-XX-XXXX"
                            />

                            <label className="text-sm font-medium text-slate-700">
                                Type *
                                <select
                                    required
                                    name="type"
                                    defaultValue=""
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                >
                                    <option value="">Select type</option>
                                    <option>Insurance</option>
                                    <option>Pollution</option>
                                </select>
                            </label>

                            <Field label="Person Name" name="personName" />

                            <Field
                                label="Insurer / Vendor"
                                name="insurerCompany"
                            />

                            <DateField
                                name="startDate"
                                label="Start Date"
                                value={startDate}
                                onChange={(value) => {
                                    setStartDate(value);
                                    if (expiryDate && value > expiryDate) {
                                        setExpiryDate("");
                                    }
                                }}
                            />

                            <DateField
                                name="expiryDate"
                                label="Expiry Date"
                                value={expiryDate}
                                min={startDate || undefined}
                                onChange={setExpiryDate}
                            />

                            <Field
                                label="Amount (₹)"
                                name="amount"
                                type="number"
                            />

                            <label className="text-sm font-medium text-slate-700">
                                NOC
                                <select
                                    name="noc"
                                    defaultValue="NA"
                                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"
                                >
                                    <option>NA</option>
                                    <option>Yes</option>
                                    <option>No</option>
                                </select>
                            </label>
                        </>
                    )}

                    {error && (
                        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 sm:col-span-2">
                            {error}
                        </p>
                    )}

                    <div className="flex justify-end gap-3 border-t border-slate-100 pt-4 sm:col-span-2">
                        <button
                            type="button"
                            onClick={onClose}
                            disabled={saving}
                            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                        >
                            Cancel
                        </button>

                        <button
                            type="submit"
                            disabled={saving}
                            className="rounded-lg px-5 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
                            style={{ backgroundColor: BLUE }}
                        >
                            {saving ? "Saving..." : "Save Record"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
