
"use client";
import { getIdToken } from "firebase/auth";
import { auth } from "@/app/lib/firebase";

/**
 * Shared OCR.Space recognition and common form-field extractor.
 *
 * Recognition:
 *   OCR.Space API -> /api/ocr
 *
 * Extraction:
 *   Actual form controls + data-ocr-* configuration.
 *
 * Supports:
 *   JPG, JPEG, PNG and PDF
 *
 * Module-specific document values are not hardcoded here.
 */

const MAX_FILE_SIZE = 500 * 1024;
const ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "pdf"];

/* -------------------------------------------------------
   COMMON TEXT UTILITIES
------------------------------------------------------- */

function normalizeLabel(value) {
    return String(value ?? "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]/g, "");
}

function getLines(text) {
    return String(text ?? "")
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeAliasPattern(alias) {
    return String(alias ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(escapeRegExp)
        .join("\\s+");
}

function getLabelRegex(alias) {
    const pattern = makeAliasPattern(alias);

    if (!pattern) return null;

    return new RegExp(
        `(^|[^a-z0-9])(${pattern})(?=\\s*[:：=]|\\s|$)`,
        "i"
    );
}

/* -------------------------------------------------------
   LABEL MATCHING
------------------------------------------------------- */

function findLabelSegment(line, alias) {
    const sourceLine = String(line ?? "");
    const regex = getLabelRegex(alias);

    if (!regex) return null;

    const match = regex.exec(sourceLine);

    if (!match) return null;

    const labelStart = match.index + match[1].length;
    const labelEnd = labelStart + match[2].length;

    const beforeLabel = sourceLine.slice(0, labelStart).trim();
    const afterLabel = sourceLine.slice(labelEnd);

    const hasExplicitSeparator = /^\s*[:：=]/.test(afterLabel);

    // Avoid matching generic words inside unrelated paragraphs.
    // Labels later in a line are accepted when explicitly separated.
    if (beforeLabel && !hasExplicitSeparator) {
        return null;
    }

    const value = afterLabel
        .replace(/^\s*[:：=]\s*/, "")
        .trim();

    return {
        start: labelStart,
        end: labelEnd,
        value,
    };
}

function truncateAtNextLabel(value, aliases, ignoredAlias = "") {
    const source = String(value ?? "");
    let endIndex = source.length;

    const ignored = normalizeLabel(ignoredAlias);

    for (const alias of aliases || []) {
        if (!alias || normalizeLabel(alias) === ignored) continue;

        const pattern = makeAliasPattern(alias);

        if (!pattern) continue;

        const regex = new RegExp(
            `(?:^|\\s)${pattern}(?=\\s*[:：=])`,
            "i"
        );

        const match = regex.exec(source);

        if (match && match.index < endIndex) {
            const boundaryLength =
                match[0].match(/^\s+/)?.[0].length || 0;

            endIndex = match.index + boundaryLength;
        }
    }

    return source.slice(0, endIndex).trim();
}

function isLikelyLabelLine(line) {
    const value = String(line ?? "").trim();

    if (!value) return true;

    // A short line ending with a field separator is likely another label.
    return /^[^:：=]{1,70}[:：=]\s*$/.test(value);
}

function getNextOcrLine(lines, index, allAliases) {
    const nextLine = lines[index + 1]?.trim();

    if (!nextLine) return "";

    if (isLikelyLabelLine(nextLine)) return "";

    const normalizedNextLine = normalizeLabel(nextLine);

    const isKnownLabel = (allAliases || []).some(
        (alias) => normalizeLabel(alias) === normalizedNextLine
    );

    return isKnownLabel ? "" : nextLine;
}

/* -------------------------------------------------------
   STANDARD FIELD EXTRACTION
------------------------------------------------------- */

function findValueAfterLabel(lines, aliases, allAliases) {
    for (const alias of aliases || []) {
        if (!alias) continue;

        for (let index = 0; index < lines.length; index += 1) {
            const segment = findLabelSegment(lines[index], alias);

            if (!segment) continue;

            if (segment.value) {
                const value = truncateAtNextLabel(
                    segment.value,
                    allAliases,
                    alias
                );

                if (value) return value;
            }

            const nextValue = getNextOcrLine(
                lines,
                index,
                allAliases
            );

            if (nextValue) return nextValue;
        }
    }

    return "";
}

/* -------------------------------------------------------
   DATE EXTRACTION
------------------------------------------------------- */

function findDateText(value) {
    const text = String(value ?? "");

    // YYYY-MM-DD, YYYY/MM/DD, DD/MM/YYYY, DD-MM-YY etc.
    const numericDate = text.match(
        /\b(?:\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/
    );

    if (numericDate) return numericDate[0];

    // 21 Oct 2026, 21st October 2026
    const dayMonthYear = text.match(
        /\b\d{1,2}(?:st|nd|rd|th)?[\s,./-]+[a-z]{3,9}[\s,./-]+\d{2,4}\b/i
    );

    if (dayMonthYear) return dayMonthYear[0];

    // October 21, 2026
    const monthDayYear = text.match(
        /\b[a-z]{3,9}[\s,./-]+\d{1,2}(?:st|nd|rd|th)?[\s,./-]+\d{2,4}\b/i
    );

    return monthDayYear ? monthDayYear[0] : "";
}

/* -------------------------------------------------------
   DATE RANGE EXTRACTION
------------------------------------------------------- */

function findRangePart(lines, control) {
    const rangeLabel = control.getAttribute(
        "data-ocr-range-label"
    );

    const rangePart = (
        control.getAttribute("data-ocr-range-part") || ""
    ).toLowerCase();

    if (!rangeLabel || !["start", "end"].includes(rangePart)) {
        return "";
    }

    const startMarker =
        control.getAttribute("data-ocr-range-start-marker") || "FROM";

    const endMarker =
        control.getAttribute("data-ocr-range-end-marker") || "TO";

    const selectedMarker =
        rangePart === "start" ? startMarker : endMarker;

    const otherMarker =
        rangePart === "start" ? endMarker : startMarker;

    const selectedPattern = makeAliasPattern(selectedMarker);
    const otherPattern = makeAliasPattern(otherMarker);

    if (!selectedPattern || !otherPattern) return "";

    const markerRegex = new RegExp(
        `\\b${selectedPattern}\\b([\\s\\S]*?)(?=\\b${otherPattern}\\b|$)`,
        "i"
    );

    for (let index = 0; index < lines.length; index += 1) {
        const segment = findLabelSegment(
            lines[index],
            rangeLabel
        );

        if (!segment) continue;

        let rangeText = segment.value;

        if (!rangeText) {
            rangeText = [
                lines[index + 1] || "",
                lines[index + 2] || "",
            ].join(" ");
        }

        const markerMatch = markerRegex.exec(rangeText);

        if (!markerMatch) continue;

        const dateText = findDateText(markerMatch[1]);

        if (dateText) return dateText;
    }

    return "";
}

/* -------------------------------------------------------
   CONTEXTUAL EXTRACTION
------------------------------------------------------- */

function findContextualValue(lines, control, allAliases) {
    const contextLabel = control.getAttribute(
        "data-ocr-context-label"
    );

    const targetLabel = control.getAttribute(
        "data-ocr-context-target-label"
    );

    if (!contextLabel || !targetLabel) return "";

    const requestedDistance = Number(
        control.getAttribute("data-ocr-context-max-lines") || 3
    );

    const maxDistance = Number.isFinite(requestedDistance)
        ? Math.min(Math.max(requestedDistance, 0), 10)
        : 3;

    for (let index = 0; index < lines.length; index += 1) {
        const contextSegment = findLabelSegment(
            lines[index],
            contextLabel
        );

        const contextIsPresent =
            Boolean(contextSegment) ||
            normalizeLabel(lines[index]).includes(
                normalizeLabel(contextLabel)
            );

        if (!contextIsPresent) continue;

        const sameLineTarget = findLabelSegment(
            lines[index],
            targetLabel
        );

        if (
            sameLineTarget &&
            (!contextSegment ||
                sameLineTarget.start >= contextSegment.end)
        ) {
            if (sameLineTarget.value) {
                return truncateAtNextLabel(
                    sameLineTarget.value,
                    allAliases,
                    targetLabel
                );
            }
        }

        for (
            let distance = 1;
            distance <= maxDistance && index + distance < lines.length;
            distance += 1
        ) {
            const targetIndex = index + distance;

            const targetSegment = findLabelSegment(
                lines[targetIndex],
                targetLabel
            );

            if (targetSegment?.value) {
                return truncateAtNextLabel(
                    targetSegment.value,
                    allAliases,
                    targetLabel
                );
            }

            if (targetSegment && !targetSegment.value) {
                const nextValue = lines[targetIndex + 1] || "";

                if (
                    nextValue &&
                    !isLikelyLabelLine(nextValue)
                ) {
                    return nextValue;
                }
            }
        }
    }

    return "";
}

/* -------------------------------------------------------
   CONFIGURED TABLE EXTRACTION
------------------------------------------------------- */

function findConfiguredTableValue(lines, control) {
    const anchor = control.getAttribute(
        "data-ocr-table-anchor"
    );

    const valuesAfter = control.getAttribute(
        "data-ocr-table-values-after"
    );

    const indexText = control.getAttribute(
        "data-ocr-table-value-index"
    );

    if (!anchor || !valuesAfter || indexText === null) {
        return "";
    }

    const valueIndex = Number(indexText);

    if (
        !Number.isInteger(valueIndex) ||
        valueIndex < 0 ||
        valueIndex > 100
    ) {
        return "";
    }

    let anchorIndex = -1;

    for (let index = 0; index < lines.length; index += 1) {
        if (
            normalizeLabel(lines[index]).includes(
                normalizeLabel(anchor)
            )
        ) {
            anchorIndex = index;
            break;
        }
    }

    if (anchorIndex < 0) return "";

    for (
        let index = anchorIndex + 1;
        index < lines.length;
        index += 1
    ) {
        if (
            !normalizeLabel(lines[index]).includes(
                normalizeLabel(valuesAfter)
            )
        ) {
            continue;
        }

        const valueLine = lines[index + 1 + valueIndex];

        if (!valueLine || isLikelyLabelLine(valueLine)) {
            return "";
        }

        return valueLine;
    }

    return "";
}

/* -------------------------------------------------------
   FORM CONTROL ALIASES
------------------------------------------------------- */

function getControlAliases(control) {
    const aliases = [];

    const dataAliases =
        control.getAttribute("data-ocr-aliases") || "";

    aliases.push(
        ...dataAliases
            .split("|")
            .map((item) => item.trim())
            .filter(Boolean)
    );

    if (control.labels) {
        aliases.push(
            ...Array.from(control.labels)
                .map((label) => label.textContent?.trim() || "")
                .filter(Boolean)
        );
    }

    const parentLabel =
        control.parentElement?.querySelector("label");

    if (parentLabel?.textContent) {
        aliases.push(parentLabel.textContent.trim());
    }

    const ariaLabel = control.getAttribute("aria-label");

    if (ariaLabel) {
        aliases.push(ariaLabel.trim());
    }

    const seen = new Set();

    return aliases.filter((alias) => {
        const normalized = normalizeLabel(alias);

        if (!normalized || seen.has(normalized)) {
            return false;
        }

        seen.add(normalized);
        return true;
    });
}

/* -------------------------------------------------------
   OCR.SPACE RECOGNITION
------------------------------------------------------- */

export async function recognizeDocumentImage(file, options = {}) {
    if (!file) {
        throw new Error("Please select a document.");
    }

    const extension = String(file.name || "")
        .split(".")
        .pop()
        ?.toLowerCase();

    if (!ALLOWED_EXTENSIONS.includes(extension)) {
        throw new Error(
            "OCR supports JPG, JPEG, PNG and PDF documents."
        );
    }

    if (file.size > MAX_FILE_SIZE) {
        throw new Error("Document must be 500 KB or less.");
    }

    if (file.size === 0) {
        throw new Error("The selected document is empty.");
    }

    const formData = new FormData();
    formData.append("file", file);

    const currentUser = auth.currentUser;

    if (!currentUser) {
        throw new Error("Please sign in before processing a document.");
    }

    let idToken;

    try {
        idToken = await getIdToken(currentUser);
    } catch {
        throw new Error("Authentication failed. Please sign in again.");
    }

    let response;

    try {
        response = await fetch("/api/ocr", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${idToken}`,
            },
            body: formData,
            signal: AbortSignal.timeout(130000),
        });
    } catch (error) {
        if (error.name === "TimeoutError") {
            throw new Error("OCR processing timed out. Please try again.");
        }

        throw new Error(
            "Could not connect to the OCR service. Please try again."
        );
    }

    let data;

    try {
        data = await response.json();
    } catch {
        throw new Error(
            "The OCR service returned an invalid response."
        );
    }

    if (!response.ok || !data?.success) {
        throw new Error(
            data?.error || "OCR could not read the document."
        );
    }

    console.log("OCR.Space Engine:", data.engine);
    console.log("OCR.Space Pages:", data.pageCount);
    console.log("OCR.Space RAW TEXT:", data.text);

    return String(data.text || "");
}

/* -------------------------------------------------------
   EXPLICIT ALIAS EXTRACTION
------------------------------------------------------- */

export function extractFieldsByAliases(text, definitions) {
    const lines = getLines(text);
    const result = {};

    const allAliases = Object.values(definitions || {}).flatMap(
        (item) =>
            Array.isArray(item)
                ? item
                : item?.aliases || []
    );

    for (const [fieldName, definition] of Object.entries(
        definitions || {}
    )) {
        const aliases = Array.isArray(definition)
            ? definition
            : definition?.aliases || [];

        const value = findValueAfterLabel(
            lines,
            aliases,
            allAliases
        );

        const parsedValue =
            typeof definition?.parse === "function"
                ? definition.parse(value, { text, lines })
                : value;

        if (
            parsedValue !== null &&
            parsedValue !== undefined &&
            String(parsedValue).trim() !== ""
        ) {
            result[fieldName] = parsedValue;
        }
    }

    return result;
}

/* -------------------------------------------------------
   DATE NORMALIZATION
------------------------------------------------------- */

function parseOcrDate(value) {
    const text = String(value ?? "").trim();

    let match = text.match(
        /\b(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})\b/
    );

    if (match) {
        return makeIsoDate(
            Number(match[1]),
            Number(match[2]),
            Number(match[3])
        );
    }

    match = text.match(
        /\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/
    );

    if (match) {
        let year = Number(match[3]);

        if (year < 100) {
            year += year <= 49 ? 2000 : 1900;
        }

        // Indian numeric date convention: DD/MM/YYYY.
        return makeIsoDate(
            year,
            Number(match[2]),
            Number(match[1])
        );
    }

    const months = {
        jan: 1, january: 1,
        feb: 2, february: 2,
        mar: 3, march: 3,
        apr: 4, april: 4,
        may: 5,
        jun: 6, june: 6,
        jul: 7, july: 7,
        aug: 8, august: 8,
        sep: 9, sept: 9, september: 9,
        oct: 10, october: 10,
        nov: 11, november: 11,
        dec: 12, december: 12,
    };

    match = text.match(
        /\b(\d{1,2})(?:st|nd|rd|th)?[\s,./-]+([a-z]+)[\s,./-]+(\d{2,4})\b/i
    );

    if (match && months[match[2].toLowerCase()]) {
        let year = Number(match[3]);

        if (year < 100) {
            year += year <= 49 ? 2000 : 1900;
        }

        return makeIsoDate(
            year,
            months[match[2].toLowerCase()],
            Number(match[1])
        );
    }

    match = text.match(
        /\b([a-z]+)[\s,./-]+(\d{1,2})(?:st|nd|rd|th)?[\s,./-]+(\d{2,4})\b/i
    );

    if (match && months[match[1].toLowerCase()]) {
        let year = Number(match[3]);

        if (year < 100) {
            year += year <= 49 ? 2000 : 1900;
        }

        return makeIsoDate(
            year,
            months[match[1].toLowerCase()],
            Number(match[2])
        );
    }

    return "";
}

function makeIsoDate(year, month, day) {
    if (
        !Number.isInteger(year) ||
        !Number.isInteger(month) ||
        !Number.isInteger(day)
    ) {
        return "";
    }

    const date = new Date(
        Date.UTC(year, month - 1, day)
    );

    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return "";
    }

    return [
        String(year).padStart(4, "0"),
        String(month).padStart(2, "0"),
        String(day).padStart(2, "0"),
    ].join("-");
}

/* -------------------------------------------------------
   VALUE FORMATTING
------------------------------------------------------- */

function formatValueForControl(value, control) {
    const cleaned = String(value ?? "")
        .replace(/^[\s:;|,]+/, "")
        .replace(/\s+/g, " ")
        .trim();

    if (!cleaned) return "";

    const type = (
        control.getAttribute("type") || ""
    ).toLowerCase();

    if (type === "date") {
        return parseOcrDate(findDateText(cleaned) || cleaned);
    }

    if (type === "number") {
        const numberText = cleaned.replace(/,/g, "");
        const match = numberText.match(/-?\d+(?:\.\d+)?/);

        return match ? match[0] : "";
    }

    return cleaned;
}

/* -------------------------------------------------------
   GENERIC INSURER HEADING DETECTION
------------------------------------------------------- */

function findInsurerHeading(lines) {
    for (const line of lines) {
        const cleaned = String(line || "")
            .replace(/\s+/g, " ")
            .trim();

        if (!cleaned || cleaned.length > 100) continue;

        if (
            /\binsurance\s+company\b/i.test(cleaned) &&
            !/[:：=]/.test(cleaned)
        ) {
            return cleaned;
        }
    }

    return "";
}

/* -------------------------------------------------------
   COMMON FORM-DRIVEN EXTRACTION
------------------------------------------------------- */

export function extractDocumentFields(rawText, formElement) {
    if (
        !formElement ||
        typeof formElement.querySelectorAll !== "function"
    ) {
        console.warn("OCR: Form element was not provided.");
        return {};
    }

    const lines = getLines(rawText);

    if (!lines.length) return {};

    const controls = Array.from(
        formElement.querySelectorAll(
            "input[name], select[name], textarea[name]"
        )
    ).filter((control) => {
        if (control.disabled) return false;

        const type = (
            control.getAttribute("type") || "text"
        ).toLowerCase();

        return ![
            "hidden",
            "file",
            "button",
            "submit",
            "reset",
            "image",
            "checkbox",
            "radio",
        ].includes(type);
    });

    const controlDefinitions = controls
        .map((control) => ({
            control,
            fieldName: control.name,
            aliases: getControlAliases(control),
        }))
        .filter((item) => item.fieldName);

    const allAliases = controlDefinitions.flatMap(
        (item) => item.aliases
    );

    const extracted = {};

    for (const definition of controlDefinitions) {
        const { control, fieldName, aliases } = definition;

        let rawValue = "";

        // 1. Configured date range.
        rawValue = findRangePart(lines, control);

        // 2. Context-specific extraction.
        if (!rawValue) {
            rawValue = findContextualValue(
                lines,
                control,
                allAliases
            );
        }

        // 3. Configured table extraction.
        if (!rawValue) {
            rawValue = findConfiguredTableValue(
                lines,
                control
            );
        }

        // 4. Explicit first-line source.
        if (!rawValue) {
            const source = control.getAttribute(
                "data-ocr-source"
            );

            if (source === "first-line") {
                rawValue = lines[0] || "";
            }
        }

        // 5. Standard form-label extraction.
        if (!rawValue && aliases.length) {
            rawValue = findValueAfterLabel(
                lines,
                aliases,
                allAliases
            );
        }

        // 6. Conservative insurer heading fallback.
        if (
            !rawValue &&
            aliases.some((alias) =>
                /insurance company|insurer/i.test(alias)
            )
        ) {
            rawValue = findInsurerHeading(lines);
        }

        if (!rawValue) continue;

        const formattedValue = formatValueForControl(
            rawValue,
            control
        );

        if (formattedValue) {
            extracted[fieldName] = formattedValue;
        }
    }

    const missingFields = controlDefinitions
        .map((item) => item.fieldName)
        .filter(
            (fieldName) =>
                !Object.prototype.hasOwnProperty.call(
                    extracted,
                    fieldName
                )
        );

    console.log("COMMON OCR EXTRACTED FIELDS:", extracted);
    console.warn("COMMON OCR FIELDS NOT FOUND:", missingFields);

    return extracted;
}

/* -------------------------------------------------------
   SAFE MERGE
------------------------------------------------------- */

export function mergeExtractedFields(currentForm, extracted) {
    const form = {
        ...(currentForm || {}),
    };

    let filledCount = 0;

    for (const [fieldName, value] of Object.entries(
        extracted || {}
    )) {
        if (!Object.prototype.hasOwnProperty.call(form, fieldName)) {
            continue;
        }

        const currentValue = form[fieldName];

        // Never overwrite a manually entered value.
        if (
            currentValue !== null &&
            currentValue !== undefined &&
            String(currentValue).trim() !== ""
        ) {
            continue;
        }

        const cleanedValue = String(value ?? "").trim();

        if (!cleanedValue) continue;

        form[fieldName] = cleanedValue;
        filledCount += 1;
    }

    return {
        form,
        filledCount,
    };
}
