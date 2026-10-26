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
    throw new Error(
        "Missing EMAIL_FROM. Configure a verified sender address in GitHub Secrets."
    );
}

// Safety: test mode is ON unless TEST_MODE is explicitly set to "false".
const TEST_MODE =
    String(process.env.TEST_MODE || "true").toLowerCase() !== "false";

const TEST_EMAIL = String(process.env.TEST_EMAIL || "")
    .trim()
    .toLowerCase();

const FORCE_TEST_EMAIL =
    String(process.env.FORCE_TEST_EMAIL || "false").toLowerCase() === "true";

const EMAIL_FROM = process.env.EMAIL_FROM;
const TIME_ZONE = "Asia/Kolkata";

if (TEST_MODE && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(TEST_EMAIL)) {
    throw new Error(
        "Test mode is ON. Add your own test address as the TEST_EMAIL GitHub Secret."
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
    for (const part of parts) values[part.type] = part.value;

    return `${values.year}-${values.month}-${values.day}`;
}

function getTodayInIndia() {
    return dateInIndia(new Date());
}

function toDateString(value) {
    if (!value) return "";

    if (typeof value === "string") {
        const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
        if (match) return match[1];

        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? "" : dateInIndia(parsed);
    }

    if (value && typeof value.toDate === "function") {
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
        Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)
    ) / 86400000;
}

function firstValue(data, keys) {
    for (const key of keys) {
        const value = data[key];
        if (value !== undefined && value !== null && value !== "") {
            return value;
        }
    }
    return "";
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

async function readRecords(
    collectionName,
    moduleName,
    allowedTypes,
    expiryFields
) {
    const snapshot = await db.collection(collectionName).get();
    const today = getTodayInIndia();

    return snapshot.docs
        .map((document) => {
            const data = document.data();

            // Check both type and category because modules may store
            // their module name in either field.
            const recordTypes = [
                data.type,
                data.category,
                data.module,
                data.recordType,
            ]
                .filter(Boolean)
                .map((value) => String(value).trim().toLowerCase());

            if (!recordTypes.some((type) => allowedTypes.includes(type))) {
                return null;
            }

            const expiryDate = toDateString(
                firstValue(data, expiryFields)
            );

            if (!expiryDate) return null;

            const daysLeft = daysBetween(today, expiryDate);

            // Reminders: 10, 3, 1 and 0 days before/on expiry;
            // overdue records are included every day.
            if (![10, 3, 1, 0].includes(daysLeft) && daysLeft >= 0) {
                return null;
            }

            const title = firstValue(data, [
                "productName",
                "product",
                "item",
                "vehicleNo",
                "vehicleNumber",
                "policyNo",
                "documentName",
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
                "partnerCompany",
            ]);

            return {
                id: document.id,
                module: moduleName,
                title: String(title || "Record"),
                company: String(company || "Not specified"),
                expiryDate,
                daysLeft,
            };
        })
        .filter(Boolean);
}

async function getAllExpiryRecords() {
    const [amc, warranty, insurance, pollution, compliance] =
        await Promise.all([
            readRecords(
                "it_devices",
                "AMC",
                ["amc"],
                ["endDate", "expiryDate"]
            ),
            readRecords(
                "it_devices",
                "Warranty",
                ["warranty"],
                ["endDate", "expiryDate"]
            ),
            readRecords(
                "vehicles",
                "Insurance",
                ["insurance"],
                ["expiryDate", "endDate"]
            ),
            readRecords(
                "vehicles",
                "Pollution",
                ["pollution"],
                ["expiryDate", "endDate"]
            ),
            readRecords(
                "compliance_records",
                "Compliance",
                ["compliance"],
                ["validTill", "validTillDate", "expiryDate"]
            ),
        ]);

    return [...amc, ...warranty, ...insurance, ...pollution, ...compliance]
        .sort((a, b) => a.daysLeft - b.daysLeft);
}

function buildEmailHtml(records, today, isTest) {
    const rows = records.map((record) => {
        let timing;

        if (record.daysLeft < 0) {
            timing = `OVERDUE by ${Math.abs(record.daysLeft)} day(s)`;
        } else if (record.daysLeft === 0) {
            timing = "EXPIRES TODAY";
        } else {
            timing = `Expires in ${record.daysLeft} day(s)`;
        }

        return `
            <tr>
                <td>${escapeHtml(record.module)}</td>
                <td>${escapeHtml(record.title)}</td>
                <td>${escapeHtml(record.company)}</td>
                <td>${displayDate(record.expiryDate)}</td>
                <td>${escapeHtml(timing)}</td>
            </tr>`;
    }).join("");

    return `
        <div style="font-family:Arial,sans-serif;color:#1f2937">
            <h2>AMIN INTERNATIONAL LIMITED</h2>
            <h3>Expiry &amp; Renewal Reminder</h3>
            ${isTest
                ? "<p><strong>TEST EMAIL:</strong> This message is for testing only.</p>"
                : ""}
            <p>Date: ${displayDate(today)}</p>
            <p>${records.length
                ? "The following records require your attention:"
                : "This is a test email. No reminders are due today."}</p>
            ${records.length ? `
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
                </table>` : ""}
            <p>Please review the Expiry &amp; Renewal Tracker as needed.</p>
        </div>`;
}

function getSendLogId(date, email) {
    return crypto
        .createHash("sha256")
        .update(`${date}_${email}`)
        .digest("hex");
}

// Claim one daily email per recipient. Sent emails are not sent again
// on a manual rerun. A stale "sending" claim can be retried after 30 minutes.
async function claimDailySend(date, email) {
    const logId = getSendLogId(date, email);
    const logRef = db.collection("email_reminder_logs").doc(logId);

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

                const ageMinutes = (Date.now() - updatedAt.getTime()) / 60000;

                if (ageMinutes < 30) {
                    return { allowed: false, logRef };
                }
            }
        }

        transaction.set(logRef, {
            date,
            email,
            status: "sending",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        return { allowed: true, logRef };
    });
}

async function sendOneEmail(email, subject, html, date) {
    const claim = await claimDailySend(date, email);

    if (!claim.allowed) {
        console.log(`Skipped already-sent or in-progress email for ${email}.`);
        return false;
    }

    try {
        const { error } = await resend.emails.send({
            from: EMAIL_FROM,
            to: [email],
            subject,
            html,
        });

        if (error) {
            throw new Error(error.message || "Resend rejected the email.");
        }

        await claim.logRef.update({
            status: "sent",
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`Email accepted by Resend for ${email}.`);
        return true;
    } catch (error) {
        await claim.logRef.set({
            status: "failed",
            error: String(error.message || "Email send failed").slice(0, 500),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        throw error;
    }
}

async function main() {
    const today = getTodayInIndia();
    const records = await getAllExpiryRecords();

    let recipients;

    if (TEST_MODE) {
        // Test mode can only send to this single configured address.
        recipients = [TEST_EMAIL];
        console.log("SAFE TEST MODE is ON. Company-wide emails are disabled.");
    } else {
        const usersSnapshot = await db.collection("users").get();

        const activeEmails = usersSnapshot.docs
            .map((document) => document.data())
            .filter((user) => user.active !== false)
            .map((user) => String(user.email || "").trim().toLowerCase())
            .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));

        const extraEmails = String(process.env.EXTRA_EMAILS || "")
            .split(",")
            .map((email) => email.trim().toLowerCase())
            .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));

        recipients = [...new Set([...activeEmails, ...extraEmails])];
    }

    if (recipients.length === 0) {
        throw new Error("No valid email recipients configured.");
    }

    if (records.length === 0 && !(TEST_MODE && FORCE_TEST_EMAIL)) {
        console.log(`No reminders due on ${today}. No email sent.`);
        return;
    }

    const html = buildEmailHtml(records, today, TEST_MODE);
    const subject = TEST_MODE
        ? `TEST — Expiry Reminder (${today})`
        : `Expiry Reminder: ${records.length} record(s) require attention`;

    let sentCount = 0;

    for (const email of recipients) {
        const sent = await sendOneEmail(email, subject, html, today);
        if (sent) sentCount++;
    }

    console.log(
        `Finished. Due records: ${records.length}; recipients: ${recipients.length}; new emails accepted: ${sentCount}.`
    );
}

main().catch((error) => {
    console.error("Expiry reminder job failed:", error.message);
    process.exitCode = 1;
});
