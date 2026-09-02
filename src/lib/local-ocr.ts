/**
 * محرك القراءة المحلي (Offline) — Tesseract.js بموارد محلية بالكامل.
 *
 * قواعد صارمة:
 *  - لا CDN إطلاقاً: worker / wasm / traineddata تُخدَم من /ocr داخل التطبيق.
 *  - يُستخدم فقط عند انقطاع الإنترنت (لا يعمل بالتوازي مع Gemini).
 *  - يعمل على قصاصة ROI بعد المعالجة المسبقة فقط — لا على الصورة الكاملة.
 *  - لا يختار «أكبر رقم»: يستخرج مرشّحين ثم يترك الحكم لقواعد MIZAN.
 */
import type { MeterVisionResult } from "./meter-vision";
import { preprocessRoiForOcr } from "./meter-vision";

const OCR_BASE = "/ocr";
const OCR_ASSETS = [
  `${OCR_BASE}/worker.min.js`,
  `${OCR_BASE}/tesseract-core-simd-lstm.wasm.js`,
  `${OCR_BASE}/tesseract-core-simd-lstm.wasm`,
  `${OCR_BASE}/eng.traineddata.gz`,
];
const OCR_CACHE = "mizan-ocr";

/** تجهيز موارد OCR مسبقاً أثناء الاتصال ليعمل القارئ لاحقاً دون إنترنت. */
export async function prefetchLocalOcrAssets(): Promise<boolean> {
  if (typeof caches === "undefined" || typeof navigator === "undefined" || !navigator.onLine) {
    return false;
  }
  try {
    const cache = await caches.open(OCR_CACHE);
    await Promise.all(
      OCR_ASSETS.map(async (url) => {
        if (await cache.match(url)) return;
        const res = await fetch(url, { credentials: "same-origin" });
        if (res.ok) await cache.put(url, res.clone());
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/** هل موارد OCR المحلي جاهزة للعمل دون إنترنت؟ */
export async function localOcrReady(): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    const cache = await caches.open(OCR_CACHE);
    const hits = await Promise.all(OCR_ASSETS.map((u) => cache.match(u)));
    return hits.every(Boolean);
  } catch {
    return false;
  }
}

type TesseractWorker = {
  setParameters: (p: Record<string, unknown>) => Promise<unknown>;
  recognize: (image: Blob | string) => Promise<{
    data: {
      text: string;
      confidence: number;
      words?: Array<{ text: string; confidence: number }>;
    };
  }>;
  terminate: () => Promise<unknown>;
};

let workerPromise: Promise<TesseractWorker> | null = null;

async function getWorker(): Promise<TesseractWorker> {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const { createWorker, PSM } = await import("tesseract.js");
    const worker = (await createWorker("eng", 1, {
      workerPath: `${OCR_BASE}/worker.min.js`,
      corePath: OCR_BASE,
      langPath: OCR_BASE,
      gzip: true,
      cacheMethod: "none",
      legacyCore: false,
      legacyLang: false,
    })) as unknown as TesseractWorker;
    await worker.setParameters({
      tessedit_char_whitelist: "0123456789.",
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      classify_bln_numeric_mode: "1",
    });
    return worker;
  })();
  try {
    return await workerPromise;
  } catch (e) {
    workerPromise = null;
    throw e;
  }
}

export async function terminateLocalOcr(): Promise<void> {
  const p = workerPromise;
  workerPromise = null;
  if (!p) return;
  try {
    (await p).terminate();
  } catch {
    /* تجاهل */
  }
}

interface Candidate {
  digits: string;
  value: number;
  confidence: number;
}

/** استخراج المرشّحين الرقميين من ناتج Tesseract — بلا اختيار «الأكبر». */
function extractCandidates(text: string, words: Array<{ text: string; confidence: number }>): Candidate[] {
  const out: Candidate[] = [];
  const push = (raw: string, conf: number) => {
    const cleaned = raw.replace(/[^\d.]/g, "").replace(/\.+/g, ".").replace(/^\.|\.$/g, "");
    if (!/^\d{1,8}(\.\d{1,3})?$/.test(cleaned)) return;
    const value = Number(cleaned);
    if (!Number.isFinite(value)) return;
    out.push({ digits: cleaned, value, confidence: Math.max(0, Math.min(1, conf / 100)) });
  };
  for (const w of words) push(w.text ?? "", w.confidence ?? 0);
  for (const tok of text.split(/\s+/)) push(tok, 0);
  // إزالة التكرار مع الاحتفاظ بأعلى ثقة
  const map = new Map<string, Candidate>();
  for (const c of out) {
    const prev = map.get(c.digits);
    if (!prev || c.confidence > prev.confidence) map.set(c.digits, c);
  }
  return [...map.values()];
}

/**
 * قراءة محلية لقصاصة ROI.
 * @param roiDataUrl قصاصة منطقة القراءة (data URL) كما التقطتها الكاميرا.
 * @param expectedDigits عدد الخانات المتوقّع (اختياري) للترجيح فقط.
 */
export async function readMeterLocally(
  roiDataUrl: string,
  expectedDigits?: number,
): Promise<MeterVisionResult> {
  const base: MeterVisionResult = {
    meterNumber: null,
    currentReading: null,
    readingDigits: null,
    confidence: 0,
    ambiguous: true,
    source: "local_ocr",
    capturedAt: new Date().toISOString(),
    reason: null,
  };

  let prepared: Blob;
  try {
    prepared = await preprocessRoiForOcr(roiDataUrl);
  } catch (e) {
    return { ...base, reason: (e as Error).message };
  }

  let worker: TesseractWorker;
  try {
    worker = await getWorker();
  } catch (e) {
    console.error("[local-ocr] worker init failed", e);
    return { ...base, reason: "محرك القراءة المحلي غير مهيأ على هذا الجهاز — أعد الاتصال مرة لتحميله" };
  }

  let data: { text: string; confidence: number; words?: Array<{ text: string; confidence: number }> };
  try {
    ({ data } = await worker.recognize(prepared));
  } catch (e) {
    return { ...base, reason: `تعذّر التحليل المحلي: ${(e as Error).message}` };
  }

  const candidates = extractCandidates(data.text ?? "", data.words ?? []);
  if (candidates.length === 0) {
    return { ...base, reason: "لم تُقرأ أرقام داخل الإطار — أعد التصوير" };
  }

  // ترجيح: الخانات المتوقّعة أولاً، ثم الثقة، ثم طول الأرقام.
  const scored = candidates
    .map((c) => {
      let score = c.confidence;
      const len = c.digits.replace(/\D/g, "").length;
      if (expectedDigits && len === expectedDigits) score += 0.25;
      if (len >= 3) score += 0.1;
      if (len <= 1) score -= 0.4;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0]!;
  const runnerUp = scored[1];
  // مرشّحان متقاربان ⇒ غموض؛ لا نخمّن.
  const ambiguous =
    top.confidence < 0.6 || (!!runnerUp && Math.abs(runnerUp.score - top.score) < 0.08);

  return {
    ...base,
    currentReading: top.value,
    readingDigits: top.digits,
    confidence: top.confidence,
    ambiguous,
    reason: ambiguous ? "أكثر من قراءة محتملة داخل الإطار — أعد التصوير" : null,
  };
}
