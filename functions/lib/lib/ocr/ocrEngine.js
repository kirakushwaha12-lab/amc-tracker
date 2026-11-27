"use client";

/**
 * Shared browser OCR/document text engine for AIL Expiry Tracker.
 * Supports: JPG/JPEG, PNG, WEBP, BMP, GIF, scanned/text PDF, DOCX, and TXT.
 * Legacy .DOC is retained for upload/storage but cannot be reliably parsed in-browser;
 * convert it to DOCX or PDF before OCR.
 */

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|bmp|gif)$/i;
const PDF_EXTENSION = /\.pdf$/i;
const DOCX_EXTENSION = /\.docx$/i;
const TXT_EXTENSION = /\.txt$/i;

function extensionOf(file) {
    return String(file?.name || "").toLowerCase();
}

function isImageFile(file) {
    return String(file?.type || "").startsWith("image/") || IMAGE_EXTENSIONS.test(extensionOf(file));
}

function createEnhancedCanvas(source, rotation = 0) {
    const sourceWidth = source.width || source.videoWidth;
    const sourceHeight = source.height || source.videoHeight;
    if (!sourceWidth || !sourceHeight) throw new Error("Image dimensions could not be read.");

    const maxDimension = 2400;
    const scale = Math.min(1.5, maxDimension / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const sideways = rotation === 90 || rotation === 270;
    const canvas = document.createElement("canvas");
    canvas.width = sideways ? height : width;
    canvas.height = sideways ? width : height;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not prepare image for OCR.");
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.filter = "grayscale(1) contrast(1.35)";
    ctx.drawImage(source, -width / 2, -height / 2, width, height);
    ctx.restore();
    return canvas;
}

async function recognizeCanvas(worker, canvas, tryAllRotations = false) {
    const rotations = tryAllRotations ? [0, 90, 270, 180] : [0];
    let best = { text: "", confidence: -1 };

    for (const rotation of rotations) {
        const candidate = rotation === 0 && !tryAllRotations
            ? canvas
            : createEnhancedCanvas(canvas, rotation);
        const result = await worker.recognize(candidate);
        const data = result?.data || {};
        const text = String(data.text || "").trim();
        const confidence = Number(data.confidence || 0);
        // Confidence is the main signal; text length breaks close ties.
        const score = confidence + Math.min(text.length / 500, 4);
        const bestScore = best.confidence + Math.min(best.text.length / 500, 4);
        if (text && score > bestScore) best = { text, confidence, score };
        if (!tryAllRotations && text.length > 30) break;
        // If the first orientation is clear enough, avoid expensive rotations.
        if (tryAllRotations && rotation === 0 && confidence >= 58 && text.length > 100) break;
    }

    return { text: best.text, confidence: Math.max(0, best.confidence) };
}

async function imageFileToCanvas(file) {
    if (typeof createImageBitmap === "function") {
        const bitmap = await createImageBitmap(file);
        try {
            return createEnhancedCanvas(bitmap, 0);
        } finally {
            bitmap.close();
        }
    }

    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        img.src = url;
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject(new Error("Image could not be opened."));
        });
        return createEnhancedCanvas(img, 0);
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function getPdfJs() {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // Copy node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs to public/pdf.worker.min.mjs.
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    return pdfjs;
}

async function extractPdfText(file, worker, onProgress) {
    const pdfjs = await getPdfJs();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data: bytes }).promise;
    const pageTexts = [];
    const maxPages = Math.min(pdf.numPages, 20);

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
        onProgress?.({ phase: "pdf", current: pageNumber, total: maxPages });
        const page = await pdf.getPage(pageNumber);
        const textContent = await page.getTextContent();
        const embeddedText = (textContent.items || [])
            .map((item) => item.str || "")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();

        if (embeddedText.length >= 40) {
            pageTexts.push(embeddedText);
            continue;
        }

        const viewport = page.getViewport({ scale: 1.7 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Could not render scanned PDF page.");
        await page.render({ canvasContext: context, viewport }).promise;
        const ocr = await recognizeCanvas(worker, canvas, true);
        if (ocr.text) pageTexts.push(ocr.text);
    }

    if (pdf.numPages > maxPages) {
        pageTexts.push(`Note: OCR processed the first ${maxPages} pages of ${pdf.numPages}.`);
    }
    return pageTexts.join("\n\n").trim();
}

async function extractDocxText(file, worker, onProgress) {
    const mammothModule = await import("mammoth/mammoth.browser");
    const mammoth = mammothModule.default || mammothModule;
    const arrayBuffer = await file.arrayBuffer();
    const htmlResult = await mammoth.convertToHtml(
        { arrayBuffer },
        {
            convertImage: mammoth.images.imgElement((image) =>
                image.read("base64").then((base64) => ({
                    src: `data:${image.contentType};base64,${base64}`,
                }))
            ),
        }
    );
    const wrapper = document.createElement("div");
    wrapper.innerHTML = htmlResult.value || "";
    const documentText = String(wrapper.innerText || wrapper.textContent || "").trim();
    const images = Array.from(wrapper.querySelectorAll("img[src^='data:image/']"));
    const imageTexts = [];

    for (let index = 0; index < images.length; index++) {
        onProgress?.({ phase: "docx-image", current: index + 1, total: images.length });
        const response = await fetch(images[index].src);
        const blob = await response.blob();
        const canvas = await imageFileToCanvas(blob);
        const result = await recognizeCanvas(worker, canvas, true);
        if (result.text) imageTexts.push(result.text);
    }

    return [documentText, ...imageTexts].filter(Boolean).join("\n\n").trim();
}

export async function extractDocumentText(file, onProgress) {
    if (!file) throw new Error("Please select a document first.");

    const name = extensionOf(file);
    if (TXT_EXTENSION.test(name) || file.type === "text/plain") {
        return { text: await file.text(), sourceType: "text", confidence: 100 };
    }

    const { createWorker } = await import("tesseract.js");
    onProgress?.({ phase: "starting", current: 0, total: 1 });
    const worker = await createWorker("eng");

    try {
        await worker.setParameters({
            tessedit_pageseg_mode: "6",
            preserve_interword_spaces: "1",
        });

        if (PDF_EXTENSION.test(name) || file.type === "application/pdf") {
            const text = await extractPdfText(file, worker, onProgress);
            return { text, sourceType: "pdf", confidence: null };
        }

        if (DOCX_EXTENSION.test(name) || file.type.includes("wordprocessingml")) {
            const text = await extractDocxText(file, worker, onProgress);
            return {
                text,
                sourceType: "docx-text",
                confidence: text ? 100 : 0,
                note: text ? "Word text extracted. Scanned pictures embedded inside Word may need a separate image upload." : "No selectable text found in DOCX.",
            };
        }

        if (/\.doc$/i.test(name) || file.type === "application/msword") {
            throw new Error("Legacy .DOC files cannot be reliably OCR-processed in the browser. Please save as .DOCX or PDF; the original file can still be uploaded and stored.");
        }

        if (!isImageFile(file)) {
            throw new Error("Unsupported OCR format. Use JPG, PNG, WEBP, PDF, DOCX, or TXT. Legacy DOC can be stored but should be converted for OCR.");
        }

        const canvas = await imageFileToCanvas(file);
        const result = await recognizeCanvas(worker, canvas, true);
        return { ...result, sourceType: "image" };
    } finally {
        await worker.terminate();
    }
}
