
const admin = require("firebase-admin");
const { Resend } = require("resend");
const crypto = require("node:crypto");

const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}"
);

if (!serviceAccount.project_id) {
    throw new Error("Missing Firebase service account configuration.");
}

if (!process.env.RESEND_API_KEY) {
    throw new Error("Missing RESEND_API_KEY.");
}

if (!process.env.EMAIL_FROM) {
    throw new Error("Missing EMAIL_FROM.");
}

const TEST_MODE =
    String(process.env.TEST_MODE || "true").toLowerCase() !== "false";

const TEST_EMAIL = String(process.env.TEST_EMAIL || "")
    .trim()
    .toLowerCase();

const FORCE_TEST_EMAIL =
    String(process.env.FORCE_TEST_EMAIL || "false").toLowerCase() === "true";

const EMAIL_FROM = process.env.EMAIL_FROM;
const TIME_ZONE = "Asia/Kolkata";

const SUPER_ADMIN_UID = "gm7L9ZxaqOUIm9qBP9Lf2sxDLh92";
const DEFAULT_REMINDER_DAYS = [10, 3, 1, 0];

const MODULE_CONFIG = [
    {
        name: "AMC",
        collection: "it_devices",
        allowedTypes: ["amc"],
        expiryFields: ["endDate", "expiryDate"],
    },
    {
        name: "Warranty",
        collection: "it_devices",
        allowedTypes: ["warranty"],
        expiryFields: ["endDate", "expiryDate"],
    },
    {
        name: "Insurance",
        collection: "vehicles",
        allowedTypes: ["insurance"],
        expiryFields: ["expiryDate", "endDate"],
    },
    {
        name: "Pollution",
        collection: "vehicles",
        allowedTypes: ["pollution"],
        expiryFields: ["expiryDate", "endDate"],
    },
    {
        name: "Compliance",
        collection: "compliance_records",
        allowedTypes: ["compliance"],
        expiryFields: ["validTill", "validTillDate", "expiryDate"],
    },
];

if (
    TEST_MODE &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(TEST_EMAIL)
) {
    throw new Error(
        "TEST_MODE is ON. Configure a valid TEST_EMAIL GitHub Secret."
    );
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const resend = new Resend(process.env.RESEND_API_KEY);

function dateInIndia(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);

    const values = {};

    for (const part of parts) {
        values[part.type] = part.value;
    }

    return `${values.year}-${values.month}-${values.day}`;
}

function getTodayInIndia() {
    return dateInIndia(new Date());
}

function toDateString(value) {
    if (!value) return "";

    // Date-only strings must not shift because of timezone conversion.
    if (typeof value === "string") {
        const match = value.match(/^(\d{4}-\d{2}-\d{2})/);

        if (match) return match[1];

        const parsed = new Date(value);

        return Number.isNaN(parsed.getTime())
            ? ""
            : dateInIndia(parsed);
    }

    if (value && typeof value.toDate === "function") {
        return dateInIndia(value.toDate());
    }

    if (value instanceof Date) {
        return dateInIndia(value);
    }

    if (
        typeof value === "object" &&
        Number.isFinite(value.seconds)
    ) {
        return dateInIndia(new Date(value.seconds * 1000));
    }

    return "";
}

function daysBetween(from, to) {
    const [fy, fm, fd] = from.split("-").map(Number);
    const [ty, tm, td] = to.split("-").map(Number);

    return (
        Date.UTC(ty, tm - 1, td) -
        Date.UTC(fy, fm - 1, fd)
    ) / 86400000;
}

function firstValue(data, keys) {
    for (const key of keys) {
        const value = data[key];

        if (
            value !== undefined &&
            value !== null &&
            value !== ""
        ) {
            return value;
        }
    }

    return "";
}

function normalize(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[_-]/g, " ")
        .replace(/\s+/g, " ");
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        String(email || "").trim()
    );
}

function displayDate(value) {
    if (!value) return "Not available";

    const [year, month, day] = value.split("-");

    return `${day}-${month}-${year}`;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    })[character]);
}

function getReminderDays(settings) {
    const configured = settings?.reminderDays;

    if (!Array.isArray(configured)) {
        return DEFAULT_REMINDER_DAYS;
    }

    const valid = configured
        .map(Number)
        .filter(
            (day) =>
                Number.isInteger(day) &&
                day >= 0 &&
                day <= 365
        );

    return [...new Set([...valid, 0])]
        .sort((a, b) => b - a);
}

async function getReminderSettings() {
    try {
        const snapshot = await db
            .collection("app_settings")
            .doc("expiryReminders")
            .get();

        return snapshot.exists ? snapshot.data() : {};
    } catch (error) {
        console.error(
            "Could not read reminder settings. Using defaults:",
            error.message
        );

        return {};
    }
}

async function getUserDirectory() {
    const snapshot = await db.collection("users").get();

    const usersByUid = new Map();
    const superAdmins = [];

    for (const document of snapshot.docs) {
        const data = document.data();
        const email = String(data.email || "")
            .trim()
            .toLowerCase();

        const active = data.active !== false;

        const user = {
            uid: document.id,
            name: String(data.name || data.displayName || ""),
            email,
            role: String(data.role || ""),
            active,
        };

        usersByUid.set(document.id, user);

        const role = normalize(data.role);

        const isSuperAdmin =
            document.id === SUPER_ADMIN_UID ||
            role === "super admin" ||
            role === "superadmin";

        if (active && isSuperAdmin && isValidEmail(email)) {
            superAdmins.push(user);
        }
    }

    return { usersByUid, superAdmins };
}

async function readModuleRecords(config, today, reminderDays) {
    const snapshot = await db
        .collection(config.collection)
        .get();

    const records = [];

    for (const document of snapshot.docs) {
        const data = document.data();

        const recordTypes = [
            data.type,
            data.category,
            data.module,
            data.recordType,
        ]
            .filter(Boolean)
            .map(normalize);

        if (
            !recordTypes.some((type) =>
                config.allowedTypes.includes(type)
            )
        ) {
            continue;
        }

        const expiryDate = toDateString(
            firstValue(data, config.expiryFields)
        );

        if (!expiryDate) continue;

        const daysLeft = daysBetween(today, expiryDate);

        const isDue =
            daysLeft < 0 || reminderDays.includes(daysLeft);

        if (!isDue) continue;

        const title = firstValue(data, [
            "productName",
            "product",
            "item",
            "vehicleNo",
            "vehicleNumber",
            "policyNo",
            "certificateNo",
            "examinationType",
            "name",
            "title",
        ]);

        const company = firstValue(data, [
            "company",
            "companyName",
            "companyJisseLiHai",
            "vendor",
            "supplier",
            "insuranceCompany",
            "companyVendor",
            "partnerCompany",
            "pucCentre",
        ]);

        records.push({
            id: document.id,
            module: config.name,
            title: String(title || "Record"),
            company: String(company || "Not specified"),
            expiryDate,
            daysLeft,
        });
    }

    return records;
}

async function getAllExpiryRecords(today, reminderDays) {
    const results = await Promise.all(
        MODULE_CONFIG.map((config) =>
            readModuleRecords(config, today, reminderDays)
        )
    );

    return results
        .flat()
        .sort((a, b) => a.daysLeft - b.daysLeft);
}

function getReminderLabel(record) {
    if (record.daysLeft < 0) {
        return `OVERDUE by ${Math.abs(record.daysLeft)} day(s)`;
    }

    if (record.daysLeft === 0) {
        return "EXPIRES TODAY";
    }

    return `Expires in ${record.daysLeft} day(s)`;
}

function buildEmailHtml(records, today, isTest) {
    const rows = records.map((record) => `
        <tr>
            <td>${escapeHtml(record.module)}</td>
            <td>${escapeHtml(record.title)}</td>
            <td>${escapeHtml(record.company)}</td>
            <td>${displayDate(record.expiryDate)}</td>
            <td>${escapeHtml(getReminderLabel(record))}</td>
        </tr>
    `).join("");

    return `
        <div style="font-family:Arial,sans-serif;color:#1f2937">
            <h2>AMIN INTERNATIONAL LIMITED</h2>
            <h3>Expiry &amp; Renewal Reminder</h3>

            ${
                isTest
                    ? "<p><strong>TEST EMAIL:</strong> This message is for testing only. Actual recipient routing is not being tested.</p>"
                    : ""
            }

            <p>Date: ${displayDate(today)}</p>

            <p>
                ${
                    records.length
                        ? "The following records require your attention:"
                        : "This is a test email. No reminders are due today."
                }
            </p>

            ${
                records.length
                    ? `
                        <table cellpadding="8" cellspacing="0" border="1"
                            style="border-collapse:collapse;width:100%">
                            <thead>
                                <tr>
                                    <th>Module</th>
                                    <th>Record</th>
                                    <th>Company / Vendor</th>
                                    <th>Expiry Date</th>
                                    <th>Reminder</th>
                                </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                        </table>
                    `
                    : ""
            }

            <p>Please review the Expiry &amp; Renewal Tracker as needed.</p>
        </div>
    `;
}

function getSendLogId(date, email) {
    return crypto
        .createHash("sha256")
        .update(`${date}_${email}`)
        .digest("hex");
}

async function claimDailySend(date, email, records) {
    const logId = getSendLogId(date, email);
    const logRef = db
        .collection("email_reminder_logs")
        .doc(logId);

    return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(logRef);

        if (snapshot.exists) {
            const existing = snapshot.data();

            if (existing.status === "sent") {
                return { allowed: false, logRef };
            }

            if (existing.status === "sending" && existing.updatedAt) {
                const updatedAt = existing.updatedAt.toDate
                    ? existing.updatedAt.toDate()
                    : new Date(existing.updatedAt);

                const ageMinutes =
                    (Date.now() - updatedAt.getTime()) / 60000;

                if (ageMinutes < 30) {
                    return { allowed: false, logRef };
                }
            }
        }

        transaction.set(
            logRef,
            {
                date,
                email,
                status: "sending",
                modules: [...new Set(records.map((r) => r.module))],
                recordCount: records.length,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );

        return { allowed: true, logRef };
    });
}

async function sendOneEmail(email, records, today, isTest) {
    const claim = await claimDailySend(today, email, records);

    if (!claim.allowed) {
        console.log(
            `Skipped already-sent or in-progress email for ${email}.`
        );
        return false;
    }

    const subject = isTest
        ? `TEST — Expiry Reminder (${today})`
        : `Expiry Reminder: ${records.length} record(s) require attention`;

    try {
        const { error } = await resend.emails.send({
            from: EMAIL_FROM,
            to: [email],
            subject,
            html: buildEmailHtml(records, today, isTest),
        });

        if (error) {
            throw new Error(
                error.message || "Resend rejected the email."
            );
        }

        await claim.logRef.update({
            status: "sent",
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`Email accepted by Resend for ${email}.`);
        return true;
    } catch (error) {
        await claim.logRef.set(
            {
                status: "failed",
                error: String(
                    error.message || "Email send failed"
                ).slice(0, 500),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );

        console.error(
            `Email failed for ${email}:`,
            error.message
        );

        return false;
    }
}

function addRecordToRecipient(recipientMap, email, record) {
    const normalizedEmail = String(email || "")
        .trim()
        .toLowerCase();

    if (!isValidEmail(normalizedEmail)) return;

    if (!recipientMap.has(normalizedEmail)) {
        recipientMap.set(normalizedEmail, []);
    }

    const list = recipientMap.get(normalizedEmail);

    if (!list.some((item) =>
        item.module === record.module &&
        item.id === record.id
    )) {
        list.push(record);
    }
}

async function logMissingModuleOperators(date, moduleName, records, reason) {
    const id = crypto
        .createHash("sha256")
        .update(`${date}_${moduleName}_${reason}`)
        .digest("hex");

    await db.collection("reminder_routing_logs").doc(id).set(
        {
            date,
            module: moduleName,
            reason,
            recordIds: records.map((record) => record.id),
            recordCount: records.length,
            status: "no_operator",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
    );
}

async function buildProductionRecipients(
    records,
    settings,
    usersByUid,
    superAdmins,
    today
) {
    const recipientMap = new Map();
    const operatorsByModule =
        settings.moduleOperators &&
        typeof settings.moduleOperators === "object"
            ? settings.moduleOperators
            : {};

    for (const config of MODULE_CONFIG) {
        const moduleRecords = records.filter(
            (record) => record.module === config.name
        );

        if (!moduleRecords.length) continue;

        const configuredUids = Array.isArray(
            operatorsByModule[config.name]
        )
            ? [...new Set(operatorsByModule[config.name].map(String))]
            : [];

        const activeOperators = configuredUids
            .map((uid) => usersByUid.get(uid))
            .filter(
                (user) =>
                    user &&
                    user.active &&
                    isValidEmail(user.email)
            );

        if (!activeOperators.length) {
            await logMissingModuleOperators(
                today,
                config.name,
                moduleRecords,
                configuredUids.length
                    ? "No configured operator is currently active with a valid email."
                    : "No module operator has been configured."
            );
        }

        for (const record of moduleRecords) {
            for (const operator of activeOperators) {
                addRecordToRecipient(
                    recipientMap,
                    operator.email,
                    record
                );
            }

            // Overdue reminders go to the same module operators
            // and additionally to all active Super Admins.
            if (record.daysLeft < 0) {
                for (const superAdmin of superAdmins) {
                    addRecordToRecipient(
                        recipientMap,
                        superAdmin.email,
                        record
                    );
                }
            }
        }
    }

    return recipientMap;
}

async function main() {
    const today = getTodayInIndia();

    const settings = await getReminderSettings();
    const reminderDays = getReminderDays(settings);

    console.log(
        `India date: ${today}; reminder days: ${reminderDays.join(", ")}`
    );

    const records = await getAllExpiryRecords(
        today,
        reminderDays
    );

    console.log(`Due records found: ${records.length}`);

    if (TEST_MODE) {
        console.log(
            "SAFE TEST MODE is ON. All due records will go only to TEST_EMAIL."
        );

        if (!records.length && !FORCE_TEST_EMAIL) {
            console.log(
                "No reminders due. Set FORCE_TEST_EMAIL=true only when a blank test email is needed."
            );
            return;
        }

        await sendOneEmail(
            TEST_EMAIL,
            records,
            today,
            true
        );

        return;
    }

    const { usersByUid, superAdmins } =
        await getUserDirectory();

    const recipientMap = await buildProductionRecipients(
        records,
        settings,
        usersByUid,
        superAdmins,
        today
    );

    if (!recipientMap.size) {
        console.log(
            "No eligible recipients for today's reminders. Check reminder_routing_logs for unassigned modules."
        );
        return;
    }

    let sentCount = 0;

    for (const [email, recipientRecords] of recipientMap.entries()) {
        const sent = await sendOneEmail(
            email,
            recipientRecords,
            today,
            false
        );

        if (sent) sentCount++;
    }

    console.log(
        `Finished. Due records: ${records.length}; recipients: ${recipientMap.size}; new emails accepted: ${sentCount}.`
    );
}

main().catch((error) => {
    console.error("Expiry reminder job failed:", error);
    process.exitCode = 1;
});
