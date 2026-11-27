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
const APP_URL = String(process.env.APP_URL || "").trim();
const TIME_ZONE = "Asia/Kolkata";
const DEFAULT_REMINDER_DAYS = [10, 3, 1, 0];
const DEFAULT_EMAIL_TIME = "09:30";
// Alternate-day email schedule
const ALTERNATE_DAY_START_DATE = "2026-11-25";

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
        requiredCategory: "Compliance",
        requiredType: "Compliance",
        expiryFields: [
            "validTill",
            "validUntil",
            "validTillDate",
            "expiryDate",
            "endDate",
        ],
    },
    {
        name: "Machinery",
        collection: "machinery_records",
        requiredCategory: "Machinery",
        requiredType: "Machinery",
        expiryFields: ["nextDueDate"],
        extraExpiryField: "amcEndDate",
    },
    {
        name: "Service",
        collection: "vehicles",
        requiredCategory: "Vehicles",
        requiredType: "Service",
        expiryFields: ["nextServiceDueDate"],
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

// -------------------- DATE / VALUE HELPERS --------------------

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

    if (typeof value.toDate === "function") {
        return dateInIndia(value.toDate());
    }

    if (value instanceof Date) {
        return dateInIndia(value);
    }

    if (typeof value === "object" && Number.isFinite(value.seconds)) {
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
        if (
            data[key] !== undefined &&
            data[key] !== null &&
            data[key] !== ""
        ) {
            return data[key];
        }
    }

    return "";
}

function firstValidDate(data, keys) {
    for (const key of keys) {
        const date = toDateString(data[key]);

        if (date) {
            return {
                date,
                field: key,
            };
        }
    }

    return {
        date: "",
        field: "",
    };
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
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    })[c]);
}

// -------------------- SETTINGS / TIME --------------------

function getLegacyReminderDays(settings) {
    if (!Array.isArray(settings?.reminderDays)) {
        return DEFAULT_REMINDER_DAYS;
    }

    const valid = settings.reminderDays
        .map(Number)
        .filter(
            (day) =>
                Number.isInteger(day) &&
                day >= 0 &&
                day <= 365
        );

    return [...new Set(valid)].sort((a, b) => b - a);
}

function getEmailTime(settings) {
    const value = String(
        settings?.emailTime || DEFAULT_EMAIL_TIME
    ).trim();

    const match = value.match(
        /^([01]\d|2[0-3]):([0-5]\d)$/
    );

    if (!match) return DEFAULT_EMAIL_TIME;

    const [hours, minutes] = value.split(":").map(Number);
    const totalMinutes = hours * 60 + minutes;

    // Match Reminder Settings UI: 06:00 AM to 10:00 PM
    // at 15-minute intervals.
    const minimum = 6 * 60;
    const maximum = 22 * 60;

    if (
        totalMinutes < minimum ||
        totalMinutes > maximum ||
        minutes % 15 !== 0
    ) {
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

// -------------------- MODULE SCHEDULES --------------------

function getModuleSchedule(settings, moduleName) {
    const moduleSchedules =
        settings?.moduleSchedules &&
            typeof settings.moduleSchedules === "object"
            ? settings.moduleSchedules
            : {};

    const schedule = moduleSchedules[moduleName];

    if (!Array.isArray(schedule)) {
        return [];
    }

    return schedule
        .map((item) => ({
            daysBefore: Number(item?.daysBefore),
            recipients: Array.isArray(item?.recipients)
                ? [...new Set(item.recipients.map(String))]
                : [],
        }))
        .filter(
            (item) =>
                Number.isInteger(item.daysBefore) &&
                item.daysBefore >= 0 &&
                item.daysBefore <= 365
        );
}

function getAllConfiguredDays(settings) {
    const allDays = new Set();

    for (const config of MODULE_CONFIG) {
        const schedule = getModuleSchedule(settings, config.name);

        for (const item of schedule) {
            allDays.add(item.daysBefore);
        }
    }

    return [...allDays].sort((a, b) => b - a);
}

// -------------------- USERS --------------------

async function getUserDirectory() {
    const snapshot = await db.collection("users").get();

    const usersByUid = new Map();

    for (const document of snapshot.docs) {
        const data = document.data();

        const email = String(data.email || "")
            .trim()
            .toLowerCase();

        const active = data.active === true;

        const user = {
            uid: document.id,
            name: String(data.name || data.displayName || ""),
            email,
            role: String(data.role || ""),
            normalizedRole: normalize(data.role),
            active,
        };

        usersByUid.set(document.id, user);
    }

    return usersByUid;
}

function getConfiguredUsers(uids, usersByUid) {
    return [...new Set((uids || []).map(String))]
        .map((uid) => usersByUid.get(uid))
        .filter(
            (user) =>
                user &&
                user.active === true &&
                isValidEmail(user.email)
        );
}

// -------------------- MODULE MATCHING --------------------

function matchesModuleRecord(data, config) {
    if (config.requiredCategory || config.requiredType) {
        const categoryMatches =
            !config.requiredCategory ||
            normalize(data.category) === normalize(config.requiredCategory);

        const typeMatches =
            !config.requiredType ||
            normalize(data.type) === normalize(config.requiredType);

        return categoryMatches && typeMatches;
    }

    const recordTypes = [
        data.type,
        data.category,
        data.module,
        data.recordType,
    ]
        .filter(Boolean)
        .map(normalize);

    return recordTypes.some((type) =>
        config.allowedTypes.includes(type)
    );
}

// -------------------- READ RECORDS --------------------

async function readModuleRecords(
    config,
    today,
    configuredDays,
    includeOverdue = true
) {
    const snapshot = await db.collection(config.collection).get();
    const records = [];

    const daySet = new Set(configuredDays);

    for (const document of snapshot.docs) {
        const data = document.data();

        if (!matchesModuleRecord(data, config)) {
            continue;
        }

        const primary = firstValidDate(
            data,
            config.expiryFields || []
        );

        const expiryCandidates = [];

        if (primary.date) {
            expiryCandidates.push({
                expiryDate: primary.date,
                expiryField: primary.field,
            });
        }

        // Machinery AMC end date is a separate reminder.
        // Consider it only when AMC Applicable is Yes.
        if (
            config.extraExpiryField &&
            normalize(data.amcApplicable) === "yes"
        ) {
            const extraDate = toDateString(
                data[config.extraExpiryField]
            );

            if (extraDate && extraDate !== primary.date) {
                expiryCandidates.push({
                    expiryDate: extraDate,
                    expiryField: config.extraExpiryField,
                });
            }
        }

        if (!expiryCandidates.length) {
            console.log(
                `Skipped ${config.name} record ${document.id}: no valid expiry/due date.`
            );

            continue;
        }

        const title = firstValue(data, [
            "productName",
            "licenseName",
            "product",
            "item",
            "machineryName",
            "machineName",
            "vehicleName",
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
            "serviceCentre",
            "serviceCenter",
            "unit",
        ]);

        for (const candidate of expiryCandidates) {
            const daysLeft = daysBetween(
                today,
                candidate.expiryDate
            );

            // Include overdue only when requested.
            // Test Mode requests overdue so they can be tested.
            const isOverdue = daysLeft < 0;

            const isConfiguredDay = daySet.has(daysLeft);

            if (
                (isOverdue && includeOverdue) ||
                (!isOverdue && isConfiguredDay)
            ) {
                records.push({
                    id: document.id,
                    recordKey: `${config.name}_${document.id}_${candidate.expiryField}`,
                    module: config.name,
                    title: String(title || "Record"),
                    company: String(company || "Not specified"),
                    expiryDate: candidate.expiryDate,
                    expiryField: candidate.expiryField,
                    daysLeft,
                });
            }
        }
    }

    return records;
}

async function getModuleExpiryRecords(
    config,
    today,
    settings,
    includeOverdue = true
) {
    const moduleSettings = settings?.moduleSettings?.[config.name];

    if (moduleSettings?.enabled === false) {
        console.log(`Reminders disabled for module: ${config.name}`);
        return [];
    }

    const schedule = getModuleSchedule(settings, config.name);

    const configuredDays = schedule.map(
        (item) => item.daysBefore
    );

    // Fallback for old settings before moduleSchedules exists.
    // This fallback is used only if moduleSchedules is absent.
    const hasNewSettings =
        settings?.moduleSchedules &&
        typeof settings.moduleSchedules === "object";

    const daysToCheck = hasNewSettings
        ? configuredDays
        : getLegacyReminderDays(settings);

    return readModuleRecords(
        config,
        today,
        daysToCheck,
        includeOverdue
    );
}

async function getAllExpiryRecords(
    today,
    settings,
    includeOverdue = true
) {
    const results = await Promise.all(
        MODULE_CONFIG.map((config) =>
            getModuleExpiryRecords(
                config,
                today,
                settings,
                includeOverdue
            )
        )
    );

    return results
        .flat()
        .sort((a, b) => a.daysLeft - b.daysLeft);
}

// -------------------- EMAIL CONTENT --------------------

function getReminderLabel(record) {
    if (record.daysLeft < 0) {
        return `OVERDUE by ${Math.abs(record.daysLeft)} day(s)`;
    }

    if (record.daysLeft === 0) {
        return "EXPIRES / DUE TODAY";
    }

    return `Due in ${record.daysLeft} day(s)`;
}

function buildEmailHtml(records, today, isTest) {
    const rows = records
        .map(
            (record) => `
                <tr>
                    <td style="padding:12px;border:1px solid #e5e7eb;">
                        ${escapeHtml(record.module)}
                    </td>
                    <td style="padding:12px;border:1px solid #e5e7eb;">
                        ${escapeHtml(record.title)}
                    </td>
                    <td style="padding:12px;border:1px solid #e5e7eb;white-space:nowrap;">
                        ${escapeHtml(displayDate(record.expiryDate))}
                    </td>
                    <td style="padding:12px;border:1px solid #e5e7eb;">
                        ${escapeHtml(getReminderLabel(record))}
                    </td>
                </tr>
            `
        )
        .join("");

    const appLinkIsValid =
        /^https:\/\/.+/i.test(APP_URL) ||
        /^http:\/\/localhost(?::\d+)?(?:\/.*)?$/i.test(APP_URL);

    const appButton = appLinkIsValid
        ? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
                <tr>
                    <td bgcolor="#0b4da2" style="background-color:#0b4da2;border-radius:5px;text-align:center;">
                        <a href="${escapeHtml(APP_URL)}"
                           target="_blank"
                           style="display:inline-block;padding:12px 24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:5px;">
                            Open AIL Tracker
                        </a>
                    </td>
                </tr>
            </table>
        `
        : `
            <p style="margin:24px 0;color:#6b7280;font-size:13px;">
                Please open the Company Records &amp; Expiry Tracker to review the records.
            </p>
        `;

    const testBanner = isTest
        ? `
            <div style="
                background:#fff7ed;
                border:1px solid #fed7aa;
                padding:10px 12px;
                margin:14px 0;
                font-size:13px;
                color:#9a3412;
                line-height:1.6;
            ">
                <strong>TEST EMAIL -</strong>
                This email was sent only to the configured test email address.
                No actual reminder routing was used.
            </div>
        `
        : "";

    const introText = records.length
        ? "This is a reminder to review the following records that are approaching their expiry or due date:"
        : isTest
            ? "This is a test email to verify the automated email notification system. No actual expiry reminder is being sent."
            : "No configured expiry reminders are due today.";

    const recordsTable = records.length
        ? `
            <table style="
                width:100%;
                border-collapse:collapse;
                font-size:13px;
            ">
                <thead>
                    <tr style="
                        background:#f1f5f9;
                        color:#1f2937;
                        text-align:left;
                    ">
                        <th style="padding:11px;border:1px solid #e5e7eb;">
                            Module
                        </th>
                        <th style="padding:11px;border:1px solid #e5e7eb;">
                            Record
                        </th>
                        <th style="padding:11px;border:1px solid #e5e7eb;">
                            Expiry / Due Date
                        </th>
                        <th style="padding:11px;border:1px solid #e5e7eb;">
                            Reminder
                        </th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>

            <p style="
                font-size:14px;
                line-height:1.7;
                margin:22px 0 0;
            ">
                Please review the above records and take the necessary action as required.
            </p>
        `
        : "";

    return `
        <div style="
            background:#f4f6f8;
            padding:24px 10px;
            font-family:Arial,Helvetica,sans-serif;
            color:#1f2937;
        ">
            <div style="
                max-width:700px;
                margin:0 auto;
                background:#ffffff;
                border:1px solid #e5e7eb;
            ">
                <div style="padding:24px 28px 18px;">
                    <div style="
                        font-size:20px;
                        font-weight:bold;
                        color:#0b4da2;
                        letter-spacing:0.3px;
                    ">
                        AMIN INTERNATIONAL LIMITED
                    </div>

                    <div style="
                        height:3px;
                        background:#0b4da2;
                        margin-top:14px;
                    "></div>

                    <h2 style="
                        font-size:19px;
                        font-weight:600;
                        margin:22px 0 8px;
                        color:#1f2937;
                    ">
                        Company Records &amp; Expiry Tracker
                    </h2>

                    <p style="
                        font-size:14px;
                        color:#64748b;
                        margin:0 0 12px;
                    ">
                        Company Records &amp; Expiry Tracker
                    </p>

                    ${testBanner}

                    <p style="font-size:14px;margin:22px 0 12px;">
                        Dear User,
                    </p>

                    <p style="
                        font-size:14px;
                        line-height:1.7;
                        margin:0 0 18px;
                    ">
                        ${introText}
                    </p>

                    <div style="
                        font-size:13px;
                        color:#6b7280;
                        margin-bottom:16px;
                    ">
                        Date: ${escapeHtml(displayDate(today))}
                    </div>

                    ${recordsTable}

                    ${appButton}

                    <p style="
                        font-size:14px;
                        line-height:1.6;
                        margin:24px 0 0;
                    ">
                        Regards,<br>
                        <strong>AMIN INTERNATIONAL LIMITED</strong>
                    </p>
                </div>

                <div style="
                    background:#f8fafc;
                    border-top:1px solid #e5e7eb;
                    padding:14px 28px;
                    font-size:11px;
                    color:#6b7280;
                    line-height:1.6;
                ">
                    This is an automated notification from the
                    Company Records &amp; Expiry Tracker.
                    Please do not reply to this email.
                </div>
            </div>
        </div>
    `;
}

// -------------------- DUPLICATE PREVENTION --------------------

function getSendLogId(date, email) {
    return crypto
        .createHash("sha256")
        .update(`${date}_${email}`)
        .digest("hex");
}

async function claimDailySend(date, email, records) {
    const logRef = db
        .collection("email_reminder_logs")
        .doc(getSendLogId(date, email));

    return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(logRef);

        if (snapshot.exists) {
            const existing = snapshot.data();

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
                modules: [
                    ...new Set(records.map((record) => record.module)),
                ],
                recordCount: records.length,
                updatedAt:
                    admin.firestore.FieldValue.serverTimestamp(),
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

async function markEmailFailed(logRef, error) {
    try {
        await logRef.set(
            {
                status: "failed",
                error: String(
                    error?.message || "Email send failed"
                ).slice(0, 500),
                updatedAt:
                    admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );
    } catch (logError) {
        console.error(
            "Could not update failed email log:",
            logError.message
        );
    }

    console.error("Email send failed:", error?.message || error);
}

async function sendOneEmail(email, records, today, isTest) {
    const claim = await claimDailySend(
        today,
        email,
        records
    );

    if (!claim.allowed) {
        console.log(
            `Skipped email for ${email}. Existing log status: ${claim.status}.`
        );

        return false;
    }

    const subject = isTest
        ? `TEST - Company Records & Expiry Tracker (${today})`
        : `Company Records & Expiry Tracker - ${records.length} record(s) require attention`;
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
            sentAt:
                admin.firestore.FieldValue.serverTimestamp(),
            updatedAt:
                admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`Email accepted by Resend for ${email}.`);

        return true;
    } catch (error) {
        console.error(
            `Email was accepted by Resend for ${email}, but the Firestore sent-log update failed. Manual log inspection is required:`,
            error.message
        );

        return false;
    }
}

// -------------------- ROUTING --------------------

function addRecordToRecipient(
    recipientMap,
    email,
    record
) {
    const normalizedEmail = String(email || "")
        .trim()
        .toLowerCase();

    if (!isValidEmail(normalizedEmail)) {
        return;
    }

    if (!recipientMap.has(normalizedEmail)) {
        recipientMap.set(normalizedEmail, []);
    }

    const list = recipientMap.get(normalizedEmail);

    const key =
        record.recordKey ||
        `${record.module}_${record.id}`;

    if (
        !list.some(
            (item) =>
                (item.recordKey ||
                    `${item.module}_${item.id}`) === key
        )
    ) {
        list.push(record);
    }
}

function getScheduleRecipientsForDay(
    schedule,
    daysLeft
) {
    const matching = schedule.filter(
        (item) => item.daysBefore === daysLeft
    );

    return [
        ...new Set(
            matching.flatMap((item) => item.recipients || [])
        ),
    ];
}

async function buildProductionRecipients(
    records,
    settings,
    usersByUid
) {
    const recipientMap = new Map();

    for (const config of MODULE_CONFIG) {
        const moduleRecords = records.filter(
            (record) => record.module === config.name
        );

        if (!moduleRecords.length) {
            continue;
        }

        const schedule = getModuleSchedule(
            settings,
            config.name
        );

        for (const record of moduleRecords) {
            // Production overdue reminders are currently disabled.
            if (record.daysLeft < 0) {
                console.log(
                    `Overdue production routing disabled: ${config.name} / ${record.title}`
                );

                continue;
            }

            const recipientUids =
                getScheduleRecipientsForDay(
                    schedule,
                    record.daysLeft
                );

            if (!recipientUids.length) {
                console.log(
                    `No recipients configured for ${config.name}, ${record.daysLeft} day(s).`
                );

                continue;
            }

            const users = getConfiguredUsers(
                recipientUids,
                usersByUid
            );

            if (!users.length) {
                console.log(
                    `No active users with valid emails for ${config.name}, ${record.daysLeft} day(s).`
                );

                continue;
            }

            for (const user of users) {
                addRecordToRecipient(
                    recipientMap,
                    user.email,
                    record
                );
            }
        }
    }

    return recipientMap;
}

// -------------------- MAIN --------------------

async function main() {
    const today = getTodayInIndia();
    const settings = await getReminderSettings();

    const emailTime = getEmailTime(settings);
    const timeCheck = isEmailTimeReached(emailTime);

    if (!timeCheck.reached) {
        console.log(`Email time not reached (${timeCheck.currentTime} IST).`);
        return;
    }

    const regularFrequencyDays = Number(settings.regularFrequencyDays) || 2;
    const daysSinceStart = daysBetween(ALTERNATE_DAY_START_DATE, today);

    const isRegularSendDay =
        daysSinceStart >= 0 &&
        daysSinceStart % regularFrequencyDays === 0;

    console.log(`India date: ${today}`);
    console.log(`Regular frequency: every ${regularFrequencyDays} day(s).`);
    console.log(`Regular reminders today: ${isRegularSendDay ? "YES" : "NO"}`);

    // Regular reminders: only on configured regular frequency days.
    const regularRecords = isRegularSendDay
        ? await getAllExpiryRecords(today, settings, false)
        : [];

    // Overdue records: independently controlled per module.
    const allOverdueRecords = await getAllExpiryRecords(today, settings, true);

    const overdueRecords = allOverdueRecords.filter((record) => {
        if (record.daysLeft >= 0) return false;

        const moduleSettings = settings?.moduleSettings?.[record.module];

        if (moduleSettings?.enabled === false) return false;
        if (moduleSettings?.overdueEnabled !== true) return false;

        const interval = Number(moduleSettings.overdueIntervalDays) || 2;
        const daysOverdue = Math.abs(record.daysLeft);

        return daysOverdue % interval === 0;
    });

    console.log(`Regular records: ${regularRecords.length}`);
    console.log(`Overdue records eligible today: ${overdueRecords.length}`);

    const combinedRecords = [...regularRecords, ...overdueRecords];

    // SAFE TEST MODE: all eligible records go only to TEST_EMAIL.
    if (TEST_MODE && !ROUTING_DRY_RUN) {
        console.log("SAFE TEST MODE active. Sending only to TEST_EMAIL.");

        if (!combinedRecords.length && !FORCE_TEST_EMAIL) {
            console.log("No eligible records. Test email skipped.");
            return;
        }

        await sendOneEmail(TEST_EMAIL, combinedRecords, today, true);
        return;
    }

    const usersByUid = await getUserDirectory();
    const recipientMap = await buildProductionRecipients(
        regularRecords,
        settings,
        usersByUid
    );

    // Route overdue reminders only to the module's selected overdue recipients.
    for (const record of overdueRecords) {
        const moduleSettings = settings?.moduleSettings?.[record.module];
        const recipientUids = Array.isArray(moduleSettings?.overdueRecipients)
            ? moduleSettings.overdueRecipients
            : [];

        const users = getConfiguredUsers(recipientUids, usersByUid);

        for (const user of users) {
            addRecordToRecipient(recipientMap, user.email, record);
        }
    }

    console.log("\n========== ROUTING PREVIEW ==========");

    for (const [email, recipientRecords] of recipientMap.entries()) {
        console.log(`Recipient: ${email}`);
        console.log(
            "Records:",
            recipientRecords.map(
                (record) => `${record.module}: ${record.title} (${getReminderLabel(record)})`
            ).join(", ")
        );
    }

    console.log("========== END ROUTING PREVIEW ==========\n");

    if (ROUTING_DRY_RUN) {
        console.log("ROUTING DRY RUN COMPLETE. No emails sent.");
        return;
    }

    if (!recipientMap.size) {
        console.log("No eligible recipients. Nothing to send.");
        return;
    }

    let sentCount = 0;

    for (const [email, recipientRecords] of recipientMap.entries()) {
        if (await sendOneEmail(email, recipientRecords, today, false)) {
            sentCount++;
        }
    }

    console.log(
        `Finished. Regular records: ${regularRecords.length}; overdue records: ${overdueRecords.length}; recipients: ${recipientMap.size}; emails accepted: ${sentCount}.`
    );
}
main().catch((error) => {
    console.error(
        "Expiry reminder job failed:",
        error
    );

    process.exitCode = 1;
});




