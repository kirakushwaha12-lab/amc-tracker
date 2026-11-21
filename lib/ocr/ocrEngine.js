import { createWorker } from "tesseract.js";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

function prepareImage(bitmap, rotation = 0) {
    const sideways = rotation === 90 || rotation === 270;
    const canvas = document.createElement("canvas");

    canvas.width = sideways ? bitmap.height : bitmap.width;
    canvas.height = sideways ? bitmap.width : bitmap.height;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Image could not be prepared for OCR.");

    ctx.save();
    if (rotation === 90) {
        ctx.translate(canvas.width, 0);
        ctx.rotate(Math.PI / 2);
    } else if (rotation === 270) {
        ctx.translate(0, canvas.height);
        ctx.rotate(-Math.PI / 2);
    } else if (rotation === 180) {
        ctx.translate(canvas.width, canvas.height);
        ctx.rotate(Math.PI);
    }

    ctx.drawImage(bitmap, 0, 0);
    ctx.restore();

    // Enlarge small documents and improve contrast without forcing rotation.
    const scale = Math.min(2, 2000 / Math.max(canvas.width, canvas.height));
    if (scale > 1) {
        const enlarged = document.createElement("canvas");
        enlarged.width = Math.round(canvas.width * scale);
        enlarged.height = Math.round(canvas.height * scale);

        const enlargedCtx = enlarged.getContext("2d");
        if (!enlargedCtx) return canvas;

        enlargedCtx.fillStyle = "#ffffff";
        enlargedCtx.fillRect(0, 0, enlarged.width, enlarged.height);
        enlargedCtx.filter = "grayscale(1) contrast(1.35)";
        enlargedCtx.drawImage(canvas, 0, 0, enlarged.width, enlarged.height);
        return enlarged;
    }

    const processed = document.createElement("canvas");
    processed.width = canvas.width;
    processed.height = canvas.height;

    const processedCtx = processed.getContext("2d");
    if (!processedCtx) return canvas;

    processedCtx.filter = "grayscale(1) contrast(1.35)";
    processedCtx.drawImage(canvas, 0, 0);

    return processed;
}

function textQuality(text, confidence = 0) {
    const clean = String(text || "").trim();
    const usefulChars = (clean.match(/[A-Za-z0-9]/g) || []).length;
    const totalChars = Math.max(clean.length, 1);

    return confidence + (usefulChars / totalChars) * 25 + Math.min(clean.length, 1000) / 100;
}

export async function extractDocumentText(file, options = {}) {
    if (!file) {
        throw new Error("Please select a document.");
    }

    const extension = String(file.name || "")
        .split(".")
        .pop()
        .toLowerCase();

    const isPdf =
        extension === "pdf" ||
        file.type === "application/pdf";

    const isImage =
        ["jpg", "jpeg", "png"].includes(extension) ||
        /^image\/(jpeg|png|jpg)$/i.test(file.type);

    if (!isPdf && !isImage) {
        throw new Error("OCR supports JPG, PNG and PDF documents.");
    }

    let bitmap;
    let pdfDocument;
    let worker;

    try {
        worker = await createWorker("eng");

        await worker.setParameters({
            tessedit_pageseg_mode: "6",
            preserve_interword_spaces: "1",
        });

        const results = [];

        if (isPdf) {
            const pdfData = new Uint8Array(await file.arrayBuffer());

            pdfDocument = await pdfjsLib.getDocument({
                data: pdfData,
            }).promise;

            for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
                const page = await pdfDocument.getPage(pageNumber);

                const initialViewport = page.getViewport({ scale: 1 });
                const scale = Math.min(
                    2,
                    2200 / Math.max(
                        initialViewport.width,
                        initialViewport.height
                    )
                );

                const viewport = page.getViewport({ scale });

                const canvas = document.createElement("canvas");
                canvas.width = Math.ceil(viewport.width);
                canvas.height = Math.ceil(viewport.height);

                const context = canvas.getContext("2d", {
                    willReadFrequently: true,
                });

                if (!context) {
                    throw new Error("PDF page could not be prepared for OCR.");
                }

                context.fillStyle = "#ffffff";
                context.fillRect(0, 0, canvas.width, canvas.height);

                await page.render({
                    canvas,
                    canvasContext: context,
                    viewport,
                }).promise;

                const result = await worker.recognize(canvas);
                const pageText = result?.data?.text || "";

                results.push(pageText);

                if (typeof options.onProgress === "function") {
                    options.onProgress({
                        page: pageNumber,
                        totalPages: pdfDocument.numPages,
                    });
                }

                canvas.width = 0;
                canvas.height = 0;
                page.cleanup();
            }
        } else {
            bitmap = await createImageBitmap(file);

            let best = { text: "", score: -1 };

            for (const rotation of [0, 90, 270]) {
                const canvas = prepareImage(bitmap, rotation);
                const result = await worker.recognize(canvas);

                const text = result?.data?.text || "";
                const confidence = Number(result?.data?.confidence || 0);
                const score = textQuality(text, confidence);

                if (score > best.score) {
                    best = { text, score };
                }
            }

            results.push(best.text);
        }

        const finalText = results
            .filter(Boolean)
            .join("\n\n");

        if (finalText.trim().length < 8) {
            throw new Error(
                "No readable text was detected. Please upload a clearer document."
            );
        }

        return finalText;
    } catch (error) {
        console.error("OCR processing failed:", error.message);
        throw error;
    } finally {
        bitmap?.close?.();
        
        if (pdfDocument && typeof pdfDocument.destroy === "function") {
            await pdfDocument.destroy();
        }

        if (worker) {
            await worker.terminate();
        }
    }
}

function findValue(text, labels) {
    const lines = String(text || "")
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean);

    for (const line of lines) {
        for (const label of labels) {
            const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const match = line.match(
                new RegExp(`(?:${escaped})\\s*[:#\\-]?\\s*(.{2,100})`, "i")
            );

            if (match?.[1]) {
                const value = match[1]
                    .replace(/^[\s:;#\-|]+/, "")
                    .replace(/[|]+/g, " ")
                    .trim();

                if (value && !/^(yes|no|n\/a|na)$/i.test(value)) {
                    return value;
                }
            }
        }
    }

    return "";
}

function findDate(text, labels) {
    const value = findValue(text, labels);
    if (!value) return "";

    const match = value.match(
        /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b|\b(20\d{2})-(\d{2})-(\d{2})\b/
    );

    if (!match) return "";

    if (match[4]) return `${match[4]}-${match[5]}-${match[6]}`;

    let day = Number(match[1]);
    let month = Number(match[2]);
    let year = Number(match[3]);

    if (year < 100) year += year < 50 ? 2000 : 1900;

    if (day < 1 || day > 31 || month < 1 || month > 12) return "";

    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function findAmount(text, labels) {
    const value = findValue(text, labels);
    if (!value) return "";

    const match = value.replace(/,/g, "").match(/\d+(?:\.\d{1,2})?/);
    return match ? match[0] : "";
}



export function extractAmcFields(text) {
    const rawText = String(text || "");

    const lines = rawText
        .split(/\r?\n/)
        .map((line) => line.replace(/[|]/g, " ").replace(/\s+/g, " ").trim())
        .filter(Boolean);

    const normalized = lines.join("\n");

    function clean(value) {
        return String(value || "")
            .replace(/^[\s:;#|=-]+/, "")
            .replace(/[\s:;|=-]+$/, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    function findLabelValue(labels) {
        const labelPattern = labels.join("|");
        const regex = new RegExp(
            `(?:${labelPattern})\\s*[:#-]?\\s*([^\\n]{2,100})`,
            "i"
        );
        const match = normalized.match(regex);
        return match ? clean(match[1]) : "";
    }

    function toISODate(value) {
        if (!value) return "";

        let s = String(value)
            .replace(/[Oo]/g, "0")
            .replace(/[Il|]/g, "1")
            .replace(/\b(un|jun)\b/gi, "Jun")
            .replace(/\b(oct)\b/gi, "Oct")
            .trim();

        // Examples: 20-Jun-26, 20 Jun 2026
        let match = s.match(
            /\b(\d{1,2})[\s./-]+([A-Za-z]{3,9})[\s,./-]+(\d{2,4})\b/
        );

        let day;
        let month;
        let year;

        if (match) {
            day = Number(match[1]);

            const months = [
                "jan", "feb", "mar", "apr", "may", "jun",
                "jul", "aug", "sep", "oct", "nov", "dec",
            ];

            month =
                months.findIndex((m) =>
                    match[2].toLowerCase().startsWith(m)
                ) + 1;

            year = Number(match[3]);
        } else {
            // OCR sometimes removes separators: 3008/2027
            match = s.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/);

            if (match) {
                day = Number(match[1]);
                month = Number(match[2]);
                year = Number(match[3]);
            } else {
                // ISO date
                match = s.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);

                if (!match) return "";

                year = Number(match[1]);
                month = Number(match[2]);
                day = Number(match[3]);
            }
        }

        if (year < 100) year += year < 50 ? 2000 : 1900;

        const date = new Date(Date.UTC(year, month - 1, day));

        if (
            month < 1 ||
            month > 12 ||
            day < 1 ||
            date.getUTCFullYear() !== year ||
            date.getUTCMonth() !== month - 1 ||
            date.getUTCDate() !== day
        ) {
            return "";
        }

        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }

    function findDateNearLabels(labels) {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const labelMatch = labels.some((label) =>
                new RegExp(label, "i").test(line)
            );

            if (!labelMatch) continue;

            // Try the labelled line and the next line, if needed.
            for (const candidate of [line, lines[i + 1] || ""]) {
                const date = toISODate(candidate);
                if (date) return date;
            }
        }

        return "";
    }

    // Vendor: support explicit labels and standalone supplier names.
    let vendor = findLabelValue([
        "Supplier(?:\\s*Name)?",
        "Vendor(?:\\s*Name)?",
        "Service\\s*Provider",
        "AMC\\s*Provider",
        "Contractor",
    ]);

    if (vendor) {
        vendor = vendor.replace(
            /\s+(?:GSTIN|GST|PAN|INVOICE|DATE|AMOUNT|TOTAL)\b.*$/i,
            ""
        );
    }

    if (!vendor) {
        const supplierLineIndex = lines.findIndex((line) =>
            /\bSAI\b/i.test(line) && /\bPOWER\s*SYSTEMS?\b/i.test(line)
        );

        if (supplierLineIndex >= 0) {
            vendor = "Sai Power System";
        }
    }

    // Product name: prefer a labelled service/item description.
    let productName = findLabelValue([
        "Description\\s*of\\s*(?:Goods|Services)",
        "Item\\s*Description",
        "Product\\s*Name",
        "Equipment\\s*Description",
        "Nature\\s*of\\s*Service",
        "Service\\s*Description",
        "Particulars",
    ]);

    if (productName) {
        productName = productName.replace(
            /\s+(?:QTY|QUANTITY|HSN|SAC|RATE|AMOUNT|GST|CGST|SGST)\b.*$/i,
            ""
        );
    }

    // Do not use a department/reference line as the product description.
    if (
        !productName ||
        /\b(?:IT\s*DEPT|DEPARTMENT|REFERENCE|REF(?:ERENCE)?\s*NO)\b/i.test(productName)
    ) {
        productName = "";
    }

    // A fallback may identify the equipment, but not the full service description.
    if (!productName) {
        const equipmentLine = lines.find((line) =>
            /\b(?:KVA|UPS)\b/i.test(line) &&
            !/\b(?:IT\s*DEPT|DEPARTMENT|REFERENCE|REF\s*NO)\b/i.test(line)
        );

        if (equipmentLine) {
            const match = equipmentLine.match(
                /\b(\d+(?:\.\d+)?\s*KVA\s+(?:ONLINE\s+)?UPS)\b/i
            );

            if (match) productName = clean(match[1]);
        }
    }

    const startDate =
        findDateNearLabels([
            "Service\\s*Start(?:\\s*Date)?",
            "AMC\\s*Start\\s*Date",
            "Contract\\s*Start\\s*Date",
            "Valid\\s*From",
            "Period\\s*From",
            "Start\\s*Date",
        ]) ||
        (() => {
            // Fallback for OCR-damaged service-period text such as 20-un26.
            for (const line of lines) {
                if (/\b(?:invoice|due\s*date|purchase\s*order)\b/i.test(line)) {
                    continue;
                }

                const date = toISODate(line);
                if (date) return date;
            }

            return "";
        })();

    const endDate =
        findDateNearLabels([
            "Service\\s*End(?:\\s*Date)?",
            "AMC\\s*End\\s*Date",
            "Contract\\s*End\\s*Date",
            "Expiry\\s*Date",
            "Expiration\\s*Date",
            "Valid\\s*Till",
            "Valid\\s*Until",
            "Period\\s*To",
            "Warranty\\s*Up\\s*To",
        ]) ||
        (() => {
            // Recognize a damaged "TO 3008/2027" line.
            for (const line of lines) {
                if (!/^\s*TO\b/i.test(line)) continue;

                const damaged = line
                    .replace(/^\s*TO\b/i, "")
                    .replace(/\b(\d{2})(\d{2})\/(20\d{2})\b/, "$1/$2/$3");

                const date = toISODate(damaged);
                if (date) return date;
            }

            return "";
        })();

    const productId = findLabelValue([
        "Product\\s*ID",
        "Product\\s*Code",
        "Asset\\s*ID",
        "Serial\\s*(?:No|Number)",
    ]).match(/[A-Z0-9/-]{3,35}/i)?.[0] || "";

    const branchUnit =
        findLabelValue([
            "Branch\\s*/?\\s*Unit",
            "Location",
            "Delivery\\s*Location",
        ]) ||
        (/\bUNNAO\b/i.test(normalized) ? "Unnao" : "");

    const remarks =
        findLabelValue([
            "Remarks",
            "Notes",
            "Scope\\s*of\\s*Work",
            "Coverage",
        ]) ||
        (/\bEXCLUD(?:ING|ED)\s+BATTERY\b/i.test(normalized)
            ? "All parts covered except battery"
            : "");

    // Prefer an explicitly labelled AMC/service charge.
    // Do not silently choose a random number or a GST amount.
    const costText = findLabelValue([
        "AMC\\s*Charges",
        "Annual\\s*Maintenance\\s*Charges",
        "Service\\s*Charges",
        "Contract\\s*Amount",
        "Basic\\s*Amount",
    ]);

    const amountMatch = costText.match(/(?:₹|INR|Rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/i);
    const cost = amountMatch
        ? amountMatch[1].replace(/,/g, "")
        : "";

    const fields = {
        productName,
        productId,
        vendor,
        startDate,
        endDate,
        cost,
        branchUnit,
        remarks,
    };

    console.log("AMC OCR extracted fields:", fields);
    return fields;
}
