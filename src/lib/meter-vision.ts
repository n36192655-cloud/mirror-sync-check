/**
 * طبقة الرؤية المشتركة لمنظومة قراءة عدادات MIZAN.
 *
 * تحتوي على:
 *  - عقد بيانات موحّد (Data Contract) لنتيجة القراءة أياً كان المحرك (Gemini أو OCR محلي).
 *  - فحوصات جودة محلية للصورة (بلا استهلاك رصيد) تمنع إرسال صورة رديئة إلى Gemini.
 *  - معالجة مسبقة للقصاصة (grayscale / contrast / threshold / scaling) لمحرك OCR المحلي.
 *  - قواعد تحقق MIZAN المستقلة — النموذج يستخرج، وMIZAN هو من يحكم.
 */

/** عقد النتيجة الموحّد — Gemini و OCR المحلي يُنتجان نفس البنية. */
export interface MeterVisionResult {
  meterNumber: string | null;
  currentReading: number | null;
  readingDigits: string | null;
  confidence: number; // 0..1 — إشارة فقط، ليست دليلاً
  ambiguous: boolean;
  source: "gemini" | "local_ocr";
  capturedAt: string; // ISO
  reason: string | null;
}

export type VerdictState = "VALID" | "AMBIGUOUS" | "INVALID" | "REJECTED";

export interface MeterVerdict {
  state: VerdictState;
  message: string;
  /** القراءة المعتمدة للعرض/التعبئة — تُملأ فقط عند VALID. */
  value: number | null;
  consumption: number | null;
  meterMatch: "match" | "mismatch" | "unknown";
}

/* ------------------------------------------------------------------ */
/*                      فحص جودة الصورة محلياً                        */
/* ------------------------------------------------------------------ */

export interface QualityMetrics {
  brightness: number; // 0..255
  contrast: number; // انحراف معياري 0..~128
  sharpness: number; // تباين لابلاسيان
  inkRatio: number; // نسبة البكسلات الداكنة داخل ROI (وجود محتوى)
  width: number;
  height: number;
}

export interface QualityVerdict {
  ok: boolean;
  /** رسالة توجيه واحدة للمستخدم بالعربية. */
  hint: string;
  level: "good" | "warn" | "bad";
  metrics: QualityMetrics;
}

/** عتبات مضبوطة على قصاصات ROI لعدادات المياه (تجريبية ومحافظة). */
const T = {
  minWidth: 160,
  minHeight: 48,
  darkMin: 45,
  darkMax: 215,
  contrastMin: 16,
  sharpnessMin: 45,
  sharpnessGood: 110,
  inkMin: 0.015,
  inkMax: 0.85,
} as const;

/** حساب مقاييس الجودة من ImageData (لقطة ROI). */
export function measureQuality(img: ImageData): QualityMetrics {
  const { data, width, height } = img;
  const n = width * height;
  const gray = new Float32Array(n);
  let sum = 0;
  let dark = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const g = 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
    gray[i] = g;
    sum += g;
    if (g < 90) dark++;
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = gray[i]! - mean;
    varSum += d * d;
  }
  const contrast = Math.sqrt(varSum / n);

  // تباين لابلاسيان (مؤشر الحدة) — على عيّنة منتظمة لتقليل الكلفة.
  const step = Math.max(1, Math.floor(Math.sqrt(n / 40000)));
  let lSum = 0;
  let lSq = 0;
  let lCount = 0;
  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const i = y * width + x;
      const lap =
        4 * gray[i]! - gray[i - 1]! - gray[i + 1]! - gray[i - width]! - gray[i + width]!;
      lSum += lap;
      lSq += lap * lap;
      lCount++;
    }
  }
  const lMean = lCount ? lSum / lCount : 0;
  const sharpness = lCount ? Math.sqrt(Math.max(0, lSq / lCount - lMean * lMean)) : 0;

  return { brightness: mean, contrast, sharpness, inkRatio: dark / n, width, height };
}

/** ترجمة المقاييس إلى توجيه ميداني واحد واضح. */
export function judgeQuality(m: QualityMetrics): QualityVerdict {
  const bad = (hint: string): QualityVerdict => ({ ok: false, hint, level: "bad", metrics: m });
  const warn = (hint: string): QualityVerdict => ({ ok: false, hint, level: "warn", metrics: m });

  if (m.width < T.minWidth || m.height < T.minHeight) return bad("اقترب من العداد");
  if (m.brightness < T.darkMin) return bad("الإضاءة غير كافية — قرّب مصدر إضاءة");
  if (m.brightness > T.darkMax) return bad("انعكاس قوي — غيّر زاوية التصوير");
  if (m.inkRatio < T.inkMin) return bad("ضع أرقام القراءة داخل الإطار");
  if (m.inkRatio > T.inkMax) return bad("الإطار مظلم — حرّك الكاميرا قليلاً");
  if (m.contrast < T.contrastMin) return warn("القراءة غير واضحة — حرّك الكاميرا قليلاً");
  if (m.sharpness < T.sharpnessMin) return bad("ثبّت الهاتف — الصورة ضبابية");
  if (m.sharpness < T.sharpnessGood) return warn("ثبّت الهاتف قليلاً لزيادة الوضوح");
  return { ok: true, hint: "جاهز للتصوير", level: "good", metrics: m };
}

/** فحص جودة مباشر من عنصر/قصاصة مصدر داخل canvas مؤقت. */
export function analyzeRoiCanvas(canvas: HTMLCanvasElement): QualityVerdict | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || canvas.width < 8 || canvas.height < 8) return null;
  try {
    return judgeQuality(measureQuality(ctx.getImageData(0, 0, canvas.width, canvas.height)));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*                    معالجة مسبقة لقصاصة OCR المحلي                  */
/* ------------------------------------------------------------------ */

/**
 * تحضير قصاصة ROI لمحرك OCR المحلي: تدرّج رمادي + تمديد التباين + شحذ خفيف
 * + عتبة Otsu + تكبير. لا تمسّ الصورة الأصلية إطلاقاً.
 */
export async function preprocessRoiForOcr(roiDataUrl: string): Promise<Blob> {
  const img = await loadImage(roiDataUrl);
  const scale = Math.min(3, Math.max(1, 900 / Math.max(1, img.naturalWidth)));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("تعذّر تجهيز الصورة للتحليل المحلي");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);

  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;
  const n = w * h;

  // 1) رمادي + هيستوغرام
  const gray = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const g = Math.round(0.299 * d[o]! + 0.587 * d[o + 1]! + 0.114 * d[o + 2]!);
    gray[i] = g;
    hist[g]!++;
  }

  // 2) تمديد التباين على 2%..98%
  const lo = percentile(hist, n, 0.02);
  const hi = percentile(hist, n, 0.98);
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < n; i++) {
    gray[i] = Math.max(0, Math.min(255, Math.round(((gray[i]! - lo) * 255) / span)));
  }

  // 3) عتبة Otsu
  const th = otsu(gray, n);
  for (let i = 0; i < n; i++) {
    const v = gray[i]! > th ? 255 : 0;
    const o = i * 4;
    d[o] = v;
    d[o + 1] = v;
    d[o + 2] = v;
    d[o + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("تعذّر إنتاج صورة التحليل المحلي"))),
      "image/png",
    );
  });
}

function percentile(hist: Uint32Array, total: number, p: number): number {
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i]!;
    if (acc >= target) return i;
  }
  return 255;
}

function otsu(gray: Uint8ClampedArray, n: number): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[gray[i]!]!++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let th = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      th = t;
    }
  }
  return th;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("تعذّر تحميل الصورة"));
    img.src = src;
  });
}

/* ------------------------------------------------------------------ */
/*                        قواعد تحقق MIZAN                            */
/* ------------------------------------------------------------------ */

export const normalizeSerial = (v: string | null | undefined): string =>
  (v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export interface ValidationInput {
  result: MeterVisionResult;
  expectedMeterNumber: string;
  previousReading: number | null;
  avgConsumption: number;
  /** الحد الأدنى للثقة المقبولة من المحرك (إشارة مساعدة فقط). */
  minConfidence?: number;
}

/**
 * الحَكَم المستقل: لا يختار رقماً ولا يخمّن — يقبل أو يرفض فقط.
 * أي شك ⇒ AMBIGUOUS/INVALID ⇒ إعادة التصوير.
 */
export function validateMeterReading(input: ValidationInput): MeterVerdict {
  const { result, expectedMeterNumber, previousReading, avgConsumption } = input;
  const minConf = input.minConfidence ?? (result.source === "gemini" ? 0.75 : 0.6);

  const expected = normalizeSerial(expectedMeterNumber);
  const detected = normalizeSerial(result.meterNumber);
  const meterMatch: MeterVerdict["meterMatch"] = !expected
    ? "unknown"
    : !detected
      ? "unknown"
      : detected === expected ||
          detected.endsWith(expected) ||
          expected.endsWith(detected) ||
          (detected.length >= 4 && expected.includes(detected))
        ? "match"
        : "mismatch";

  const fail = (state: VerdictState, message: string): MeterVerdict => ({
    state,
    message,
    value: null,
    consumption: null,
    meterMatch,
  });

  if (meterMatch === "mismatch") {
    return fail(
      "REJECTED",
      `رقم العداد الملتقط (${result.meterNumber}) لا يطابق عداد المشترك (${expectedMeterNumber}) — تأكد أنك تصوّر العداد الصحيح`,
    );
  }

  if (result.currentReading === null || !Number.isFinite(result.currentReading)) {
    return fail("INVALID", result.reason ?? "لم تُقرأ أرقام الاستهلاك — أعد التصوير");
  }
  if (result.ambiguous) {
    return fail("AMBIGUOUS", result.reason ?? "القراءة غير محسومة — أعد التصوير");
  }
  if (result.confidence < minConf) {
    return fail(
      "AMBIGUOUS",
      `ثقة القراءة منخفضة (${Math.round(result.confidence * 100)}%) — أعد التصوير`,
    );
  }

  const value = result.currentReading;
  if (value < 0 || value > 9_999_999) {
    return fail("INVALID", `القراءة المستخرجة (${value}) خارج المدى المنطقي — أعد التصوير`);
  }

  const digits = (result.readingDigits ?? "").replace(/[^\d]/g, "");
  if (digits.length > 8) {
    return fail("INVALID", "عدد الخانات المستخرجة غير منطقي لعداد مياه — أعد التصوير");
  }

  const prev = previousReading;
  let consumption: number | null = null;
  if (prev !== null) {
    if (value < prev) {
      return fail(
        "INVALID",
        `القراءة المستخرجة (${value}) أقل من القراءة السابقة (${prev}) — أعد التصوير`,
      );
    }
    consumption = +(value - prev).toFixed(3);
    if (avgConsumption > 0 && consumption > avgConsumption * 3) {
      return fail(
        "AMBIGUOUS",
        `الاستهلاك المستخرج (${consumption} م³) يتجاوز ثلاثة أضعاف المتوسط — أعد التصوير للتأكد`,
      );
    }
    if (avgConsumption === 0 && consumption > 1000) {
      return fail("AMBIGUOUS", `الاستهلاك المستخرج (${consumption} م³) غير منطقي — أعد التصوير`);
    }
  }

  return {
    state: "VALID",
    message:
      meterMatch === "match"
        ? "تم التحقق من هوية العداد والقراءة"
        : "تم التحقق من القراءة (رقم العداد غير مقروء في الصورة)",
    value,
    consumption,
    meterMatch,
  };
}
