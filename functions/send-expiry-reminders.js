
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
const ROUTING_DRY_RUN =
    String(process.env.ROUTING_DRY_RUN || "false").toLowerCase() === "true";
const EMAIL_FROM = process.env.EMAIL_FROM;
const TIME_ZONE = "Asia/Kolkata";

const SUPER_ADMIN_UID = "gm7L9ZxaqOUIm9qBP9Lf2sxDLh92";

const DEFAULT_REMINDER_DAYS = [10, 3, 1, 0];
const DEFAULT_EMAIL_TIME = "09:30";

const MODULE_CONFIG = [
    {
        name: "AMC",
        collection: "it_devices",
        allowedTypes: ["amc"],
        expiryFields: ["endDate"],
    },
    {
        name: "Warranty",
        collection: "it_devices",
        allowedTypes: ["warranty"],
        expiryFields: [
            "warrantyExpiry",
            "warrantyExpired",
            "endDate",
            "expiryDate",
        ],
    },
    {
        name: "Software License",
        collection: "it_devices",
        allowedTypes: ["software license"],
        expiryFields: ["expiryDate"],
    },
    {
        name: "Insurance",
        collection: "vehicles",
        allowedTypes: ["insurance"],
        expiryFields: ["expiryDate"],
    },
    {
        name: "Pollution",
        collection: "vehicles",
        allowedTypes: ["pollution"],
        expiryFields: ["expiryDate", "pollutionExpiryDate"],
    },
    {
        name: "Compliance",
        collection: "compliance_records",
        allowedTypes: ["compliance"],
        expiryFields: [
            "validTill",
            "validUntil",
            "validTillDate",
            "expiryDate",
            "endDate",
        ],
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

// --------------------------------------------------
// DATE HELPERS
// --------------------------------------------------

function dateInIndia(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return "";
    }

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

function isValidDateString(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const [year, month, day] = value.split("-").map(Number);

    const date = new Date(Date.UTC(year, month - 1, day));

    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

function getTodayInIndia() {
    return dateInIndia(new Date());
}

function toDateString(value) {
    if (!value) return "";

    if (typeof value === "string") {
        const match = value.match(/^(\d{4}-\d{2}-\d{2})/);

        if (match) {
            return isValidDateString(match[1]) ? match[1] : "";
        }

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

// Returns the first valid date, not merely the first non-empty field.
function firstValidDate(data, keys) {
    for (const key of keys) {
        const date = toDateString(data[key]);

        if (date) return date;
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
    if (!value || !isValidDateString(value)) {
        return "Not available";
    }

    const [year, month, day] = value.split("-");

    return `${day}-${month}-${year}`;
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    })[character]);
}

// --------------------------------------------------
// REMINDER SETTINGS
// --------------------------------------------------

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

function getEmailTime(settings) {
    const value = String(
        settings?.emailTime || DEFAULT_EMAIL_TIME
    ).trim();

    if (!/^([01]\d|2[0-3]):(00|15|30|45)$/.test(value)) {
        return DEFAULT_EMAIL_TIME;
    }

    return value;
}

function getCurrentTimeInIndia() {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(new Date());

    const values = {};

    for (const part of parts) {
        values[part.type] = part.value;
    }

    return `${values.hour}:${values.minute}`;
}

function isEmailTimeReached(emailTime) {
    const currentTime = getCurrentTimeInIndia();

    return {
        reached: currentTime >= emailTime,
        currentTime,
    };
}

async function getReminderSettings() {
    const snapshot = await db
        .collection("app_settings")
        .doc("expiryReminders")
        .get();

    return snapshot.exists ? snapshot.data() : {};
}

// --------------------------------------------------
// USER DIRECTORY
// --------------------------------------------------

async function getUserDirectory() {
    const snapshot = await db.collection("users").get();

    const usersByUid = new Map();
    const superAdmins = [];
    const admins = [];

    for (const document of snapshot.docs) {
        const data = document.data();

        const email = String(data.email || "")
            .trim()
            .toLowerCase();

        // The fixed Super Admin UID is a permanent trusted exception.
        const isFixedSuperAdmin = document.id === SUPER_ADMIN_UID;

        const active =
            isFixedSuperAdmin || data.active === true;

        const role = normalize(data.role);

        const isSuperAdmin =
            isFixedSuperAdmin ||
            role === "super admin" ||
            role === "superadmin";

        const isAdmin = role === "admin";

        const user = {
            uid: document.id,
            name: String(data.name || data.displayName || ""),
            email,
            role: String(data.role || ""),
            normalizedRole: role,
            active,
            isSuperAdmin,
        };

        usersByUid.set(document.id, user);

        if (active && isValidEmail(email)) {
            if (isSuperAdmin) {
                superAdmins.push(user);
            } else if (isAdmin) {
                admins.push(user);
            }
        }
    }

    return {
        usersByUid,
        superAdmins,
        admins,
    };
}

// --------------------------------------------------
// READ EXPIRY RECORDS
// --------------------------------------------------

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

        const expiryDate = firstValidDate(
            data,
            config.expiryFields
        );

        if (!expiryDate) {
            console.log(
                `Skipped ${config.name} record ${document.id}: no valid expiry date.`
            );
            continue;
        }

        const daysLeft = daysBetween(today, expiryDate);

        const isDue =
            daysLeft < 0 || reminderDays.includes(daysLeft);

        if (!isDue) continue;

        const title = firstValue(data, [
            "productName",
            "licenseName",
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
            "vendor",
            "supplier",
            "insuranceCompany",
            "insurerCompany",
            "serviceProvider",
            "companyVendor",
            "partnerCompany",
            "pucCentre",
            "pucCenter",
            "unit",
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

// --------------------------------------------------
// EMAIL CONTENT
// --------------------------------------------------

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
            <td>${escapeHtml(displayDate(record.expiryDate))}</td>
            <td>${escapeHtml(getReminderLabel(record))}</td>
        </tr>
    `).join("");

    return `
        <div style="font-family:Arial,sans-serif;color:#1f2937">
            <h2>AMIN INTERNATIONAL LIMITED</h2>
            <h3>Expiry &amp; Renewal Reminder</h3>

            ${isTest
            ? "<p><strong>TEST EMAIL:</strong> This message is for testing only. Actual recipient routing is not being tested.</p>"
            : ""
        }

            <p>Date: ${escapeHtml(displayDate(today))}</p>

            <p>
                ${records.length
            ? "The following records require your attention:"
            : "This is a test email. No reminders are due today."
        }
            </p>

            ${records.length
            ? `
                <table cellpadding="8" cellspacing="0" border="1"
                    style="border-collapse:collapse;width:100%">
                    <thead>
                        <tr>
                            <th>Module</th>
                            <th>Record</th>
                            <th>Company / Vendor / Unit</th>
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

// --------------------------------------------------
// DUPLICATE EMAIL PREVENTION
// --------------------------------------------------

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

            // Never automatically resend a previously accepted email.
            if (
                existing.status === "sent" ||
                existing.status === "sending"
            ) {
                return {
                    allowed: false,
                    logRef,
                    status: existing.status,
                };
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

        return {
            allowed: true,
            logRef,
            status: "sending",
        };
    });
}

async function sendOneEmail(email, records, today, isTest) {
    const claim = await claimDailySend(today, email, records);

    if (!claim.allowed) {
        console.log(
            `Skipped email for ${email}. Existing log status: ${claim.status}.`
        );
        return false;
    }

    const subject = isTest
        ? `TEST — Expiry Reminder (${today})`
        : `Expiry Reminder: ${records.length} record(s) require attention`;

    // Send first. If Resend accepts the email, do not mark it failed
    // merely because the subsequent Firestore update fails.
    let resendResult;

    try {
        resendResult = await resend.emails.send({
            from: EMAIL_FROM,
            to: [email],
            subject,
            html: buildEmailHtml(records, today, isTest),
        });
    } catch (error) {
        await markEmailFailed(claim.logRef, error);
        return false;
    }

    if (resendResult?.error) {
        await markEmailFailed(
            claim.logRef,
            new Error(
                resendResult.error.message ||
                "Resend rejected the email."
            )
        );
        return false;
    }

    try {
        await claim.logRef.update({
            status: "sent",
            resendId: resendResult?.data?.id || null,
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`Email accepted by Resend for ${email}.`);
        return true;
    } catch (error) {
        // Keep status as sending. A retry must not automatically
        // send a second copy when Resend may already have accepted it.
        console.error(
            `Email was accepted by Resend for ${email}, but the Firestore sent-log update failed. Manual log inspection is required:`,
            error.message
        );

        return false;
    }
}

async function markEmailFailed(logRef, error) {
    try {
        await logRef.set(
            {
                status: "failed",
                error: String(
                    error?.message || "Email send failed"
                ).slice(0, 500),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );
    } catch (logError) {
        console.error(
            "Could not update failed email log:",
            logError.message
        );
    }

    console.error(
        "Email send failed:",
        error?.message || error
    );
}

// --------------------------------------------------
// RECIPIENT HELPERS
// --------------------------------------------------

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

async function logMissingModuleOperators(
    date,
    moduleName,
    records,
    reason
) {
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
            fallback: "Super Admin",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
    );
}

// --------------------------------------------------
// PRODUCTION EMAIL ROUTING
// --------------------------------------------------

async function buildProductionRecipients(
    records,
    settings,
    usersByUid,
    superAdmins,
    admins,
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
                    user.normalizedRole === "editor" &&
                    isValidEmail(user.email)
            );

        if (!activeOperators.length) {
            await logMissingModuleOperators(
                today,
                config.name,
                moduleRecords,
                configuredUids.length
                    ? "No configured active Editor with a valid email."
                    : "No module Editor has been configured."
            );
        }

        for (const record of moduleRecords) {
            const isOverdue = record.daysLeft < 0;

            if (activeOperators.length) {
                // Upcoming, expiry-day and overdue -> assigned Editors.
                for (const operator of activeOperators) {
                    addRecordToRecipient(
                        recipientMap,
                        operator.email,
                        record
                    );
                }
            } else {
                // No valid Editor -> Super Admin fallback.
                for (const superAdmin of superAdmins) {
                    addRecordToRecipient(
                        recipientMap,
                        superAdmin.email,
                        record
                    );
                }
            }

            if (isOverdue) {
                // Overdue -> all active Admins.
                for (const adminUser of admins) {
                    addRecordToRecipient(
                        recipientMap,
                        adminUser.email,
                        record
                    );
                }

                // Overdue -> all active Super Admins.
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

// --------------------------------------------------
// MAIN
// --------------------------------------------------

async function main() {
    const today = getTodayInIndia();

    const settings = await getReminderSettings();

    const reminderDays = getReminderDays(settings);
    const emailTime = getEmailTime(settings);

    const timeCheck = isEmailTimeReached(emailTime);

    console.log(
        `India date: ${today}; reminder days: ${reminderDays.join(", ")}`
    );

    console.log(
        `Configured email time: ${emailTime} IST; current India time: ${timeCheck.currentTime} IST`
    );

    if (!timeCheck.reached) {
        console.log(
            `Email time not reached. Skipping this run. Next eligible time: ${emailTime} IST.`
        );
        return;
    }

    console.log(
        "Configured email time reached. Checking expiry records..."
    );

    const records = await getAllExpiryRecords(
        today,
        reminderDays
    );

    console.log(`Due records found: ${records.length}`);

    // SAFE TEST MODE: never sends to actual users.
    if (TEST_MODE && !ROUTING_DRY_RUN) {
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

    const {
        usersByUid,
        superAdmins,
        admins,
    } = await getUserDirectory();

    console.log("\n========== ROUTING PREVIEW ==========");

    const preview = await buildProductionRecipients(
        records,
        settings,
        usersByUid,
        superAdmins,
        admins,
        today
    );

    for (const [email, recipientRecords] of preview.entries()) {
        console.log(`Recipient: ${email}`);
        console.log(
            "Records:",
            recipientRecords.map(
                (record) => `${record.module}: ${record.title}`
            ).join(", ")
        );
    }

    console.log("========== END ROUTING PREVIEW ==========\n");
    if (ROUTING_DRY_RUN) {
        console.log("ROUTING DRY RUN COMPLETE. No emails were sent.");
        return;
    }
    console.log(
        `Active Super Admins: ${superAdmins.length}; active Admins: ${admins.length}`
    );

    const recipientMap = preview;

    if (!recipientMap.size) {
        console.log(
            "No eligible recipients for today's reminders. Check reminder_routing_logs and user/module operator settings."
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
