function parseDate(value) {
    const text = String(value || "").trim();
    const m = text.match(/\b(\d{1,2})\s*[/. -]\s*(\d{1,2})\s*[/. -]\s*(\d{4})\b/);
    if (!m) return "";
    const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || year < 1900 || year > 2100) return "";
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function findDate(text, pattern) {
    const match = text.match(new RegExp(`(?:${pattern})[^\\n]{0,100}?(\\d{1,2}[/. -]\\d{1,2}[/. -]\\d{4})`, "i"));
    return match ? parseDate(match[1]) : "";
}

export function parseInsuranceFields(rawText) {
    const text = String(rawText || "")
        .replace(/\r/g, "\n")
        .replace(/\u00a0/g, " ")
        .replace(/[：]/g, ":");
    const compact = text.replace(/[ \t]+/g, " ");
    const fields = {};

    const insurer = compact.match(/(?:The\s+)?([A-Z][A-Za-z&.' -]{2,80}Insurance\s+Company(?:\s+Limited|\s+Ltd\.?)?)/i);
    if (insurer) fields.insuranceCompany = insurer[1].trim().replace(/\s+/g, " ");
    else if (/oriental/i.test(compact) && /insurance/i.test(compact)) fields.insuranceCompany = "The Oriental Insurance Company Limited";
    else if (/new india assurance/i.test(compact)) fields.insuranceCompany = "The New India Assurance Company Limited";
    else if (/united india insurance/i.test(compact)) fields.insuranceCompany = "United India Insurance Company Limited";
    else if (/national insurance company/i.test(compact)) fields.insuranceCompany = "National Insurance Company Limited";

    // Choose the current Policy No., not a nearby Previous Policy No.
    const lines = text.split("\n");
    let policyValue = "";
    for (let i = 0; i < lines.length; i++) {
        if (/\bpolicy\s*(?:no\.?|number|#)/i.test(lines[i]) && !/prev(?:ious)?\s+policy/i.test(lines[i])) {
            const nearby = lines.slice(i, i + 3).join(" ");
            const ids = [...nearby.matchAll(/\b[A-Z0-9]{4,}(?:\/[A-Z0-9-]+){1,5}\b/gi)].map((m) => m[0]);
            policyValue = ids.find((id) => /\d{4}/.test(id)) || "";
            if (policyValue) break;
        }
    }
    if (!policyValue) {
        const policy = compact.match(/(?:^|\n)\s*policy\s*(?:no\.?|number|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/.-]{4,40})/im);
        if (policy && !/prev/i.test(policy[0])) policyValue = policy[1];
    }
    if (policyValue) fields.policyNo = policyValue.replace(/[.,;:]$/, "").trim();

    const vehicle = compact.match(/(?:registration\s*mark(?:\s*&\s*place)?|vehicle\s*(?:registration\s*)?(?:no\.?|number|regn\.?))\s*[:#-]?\s*([A-Z]{2}\s*\d{1,2}\s*[A-Z]{1,3}\s*\d{3,4})/i)
        || compact.match(/\b([A-Z]{2}\s*\d{1,2}\s*[A-Z]{1,3}\s*\d{3,4})\b/i);
    if (vehicle) fields.productId = vehicle[1].replace(/\s+/g, "").toUpperCase();

    const policyType = compact.match(/(MOTOR\s+INSURANCE\s+CERTIFICATE[^\n]{0,100}|PRIVATE\s+CAR\s+PACKAGE\s+POLICY[^\n]{0,50}|COMMERCIAL\s+VEHICLE\s+POLICY[^\n]{0,50})/i);
    if (policyType) fields.productName = policyType[1].trim().replace(/\s+/g, " ");
    else if (fields.productId) fields.productName = `Vehicle Insurance - ${fields.productId}`;

    // Prefer the explicit policy period over unrelated invoice/signing dates.
    const period = compact.match(/(?:period\s+of\s+insurance|insurance\s+period)[^\n]{0,180}?from\s+\d{1,2}:\d{2}\s*(?:am|pm)?\s*on\s*(\d{1,2}[/. -]\d{1,2}[/. -]\d{4})\s+to\s+(?:midnight\s+of\s*)?(\d{1,2}[/. -]\d{1,2}[/. -]\d{4})/i)
        || compact.match(/(?:period\s+of\s+insurance|insurance\s+period)[^\n]{0,120}?(\d{1,2}[/. -]\d{1,2}[/. -]\d{4})\s*(?:to|through|[-–])\s*(\d{1,2}[/. -]\d{1,2}[/. -]\d{4})/i);
    if (period) {
        fields.periodDate = parseDate(period[1]);
        fields.expiryDate = parseDate(period[2]);
    }

    // Renewal/issue date is secondary to the actual coverage period.
    const issueDate = findDate(text, String.raw`(?:issue\s*date|date\s*of\s*issue|renewal\s*date|collection\s*no\s*&\s*dt|^date\s*:)`);
    if (issueDate) fields.date = issueDate;

    const total = compact.match(/\btotal\s*[:=]?\s*(?:rs\.?|inr|₹)?\s*[,.:]?\s*([\d,]+(?:\.\d{1,2})?)/i)
        || compact.match(/(?:amount\s+payable|premium\s+payable|total\s+premium)\s*[:=]?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (total) fields.amount = String(Number(total[1].replace(/,/g, "")));
    else {
        const premium = compact.match(/gross\s+premium\s*[:=]?\s*(?:rs\.?|inr|₹)?\s*[,.:]?\s*([\d,]+(?:\.\d{1,2})?)/i);
        if (premium) fields.amount = String(Number(premium[1].replace(/,/g, "")));
    }

    return Object.fromEntries(Object.entries(fields).filter(([, value]) => Boolean(value)));
}
