function normalizeText(text) {
    return String(text ?? "")
        .replace(/\r/g, "\n")
        .replace(/\u00a0/g, " ")
        .replace(/[：]/g, ":")
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").trim())
        .filter(Boolean)
        .join("\n");
}

function parseDate(value) {
    const text = String(value || "").trim();
    let m = text.match(/\b(\d{1,2})\s*[/. -]\s*(\d{1,2})\s*[/. -]\s*(\d{4})\b/);
    if (m) {
        const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
        const d = new Date(year, month - 1, day);
        if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day && year >= 1900 && year <= 2100) {
            return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        }
    }
    m = text.match(/\b(\d{1,2})\s*[/. -]\s*([A-Za-z]{3,9})\s*[/. -]\s*(\d{4})\b/i);
    if (m) {
        const months = { jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12 };
        const day = Number(m[1]), month = months[m[2].toLowerCase()], year = Number(m[3]);
        if (month) {
            const d = new Date(year, month - 1, day);
            if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
        }
    }
    return "";
}

function findDate(text, labelPattern) {
    const re = new RegExp(`(?:${labelPattern})[^\\n]{0,100}?(\\d{1,2}\\s*[/. -]\\s*(?:[A-Za-z]{3,9}|\\d{1,2})\\s*[/. -]\\s*\\d{4})`, "i");
    const match = text.match(re);
    if (match) return parseDate(match[1]);
    const lines = text.split("\n");
    const index = lines.findIndex((line) => new RegExp(labelPattern, "i").test(line));
    if (index >= 0) {
        const match2 = lines.slice(index, index + 3).join(" ").match(/\b\d{1,2}\s*[/. -]\s*(?:[A-Za-z]{3,9}|\d{1,2})\s*[/. -]\s*\d{4}\b/i);
        if (match2) return parseDate(match2[0]);
    }
    return "";
}

export function parsePollutionFields(rawText) {
    const text = normalizeText(rawText);
    const upper = text.toUpperCase();
    const fields = {};
    const vehicle = text.match(/\b([A-Z]{2}\s*\d{1,2}\s*[A-Z]{1,3}\s*\d{4})\b/i);
    if (vehicle) fields.vehicleNo = vehicle[1].replace(/\s+/g, "").toUpperCase();

    const fuel = upper.match(/\b(PETROL\s*\/\s*CNG|CNG\s*\/\s*PETROL|DIESEL|PETROL|CNG|LPG|ELECTRIC)\b/);
    if (fuel) {
        const f = fuel[1].replace(/\s+/g, "");
        fields.fuelType = /DIESEL/.test(f) ? "Diesel" : /ELECTRIC/.test(f) ? "Other" : /LPG/.test(f) ? "LPG" : /CNG/.test(f) ? "Petrol/CNG" : "Petrol";
    }

    const reg = findDate(text, String.raw`(?:date\s*of\s*registration|registration\s*date|regn\.?\s*date|date\s*of\s*manufacturing)`);
    if (reg) fields.registrationDate = reg;
    const expiry = findDate(text, String.raw`(?:validity\s*(?:up\s*to|upto|till|until)|valid\s*(?:up\s*to|upto|till|until)|date\s*of\s*expiry|expiry\s*date)`);
    if (expiry) fields.expiryDate = expiry;
    const certDate = findDate(text, String.raw`(?:certificate\s*date|date\s*of\s*(?:test|issue|inspection)|test\s*date|inspection\s*date|puc\s*date|testing\s*date|^date\s*:)`);
    if (certDate) fields.certificateDate = certDate;

    const pucCode = text.match(/(?:\b[PR]\s*U\s*C\s*(?:Code|No\.?|Number)\b)[\s:#-]*([A-Z0-9-]{4,28})/i);
    if (pucCode && /\d/.test(pucCode[1])) fields.pucCode = pucCode[1].replace(/[^A-Z0-9-]/gi, "").toUpperCase();

    const cert = text.match(/(?:certificate\s*(?:sl\.?\s*)?(?:no\.?|number|#)|serial\s*(?:no\.?|number|#)|puc\s*(?:certificate\s*)?(?:no\.?|number|#)|transaction\s*id|report\s*(?:no\.?|number|#))\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{4,30})/i);
    if (cert) fields.certificateNo = cert[1].replace(/[.,;:]$/, "").toUpperCase();
    if (!fields.certificateNo) {
        const candidates = text.match(/\b[A-Z0-9]{10,24}\b/gi) || [];
        const candidate = candidates.find((value) => /[A-Z]/i.test(value) && /\d/.test(value) && value.toUpperCase() !== (fields.vehicleNo || "") && value.toUpperCase() !== (fields.pucCode || ""));
        if (candidate) fields.certificateNo = candidate.toUpperCase();
    }

    const currencyAmount = text.match(/(?:fees?|testing\s*charges?|test\s*charges?|amount|total\s*charges?)[^\n]{0,35}?(?:rs\.?|inr|₹)\s*[,.:]?\s*([\d,]+(?:\.\d{1,2})?)/i)
        || text.match(/(?:rs\.?|inr|₹)\s*[,.:]?\s*([\d,]+(?:\.\d{1,2})?)/i);
    const plainAmount = text.match(/(?:^|\n)\s*(?:fees?|testing\s*charges?|test\s*charges?|amount|total\s*charges?)\s*[:=-]?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:\n|$)/im);
    const amount = currencyAmount || plainAmount;
    if (amount) fields.amount = String(Number(amount[1].replace(/,/g, "")));

    const centre = text.match(/(?:p\.?\s*u\.?\s*c\.?\s*(?:centre|center)|testing\s*(?:centre|center)|test\s*(?:centre|center)|centre\s*name|center\s*name|emission\s*testing\s*centre|pollution\s*checking\s*centre)\s*[:#-]?\s*([^\n]{3,100})/i);
    if (centre) fields.pucCentre = centre[1].split(/\s{2,}|\s+(?:PUC\s*(?:Code|No\.? )|Vehicle\s*(?:No\.?|Number)|Fuel\s*Type|Registration\s*Date|Certificate\s*No\.?|Validity|Fees?|Amount)\s*[:#-]?/i)[0].trim().replace(/[|;]+$/, "");
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => Boolean(value)));
}
