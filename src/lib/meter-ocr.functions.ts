import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** عقد نتيجة قراءة العداد بالذكاء الاصطناعي (structured JSON، بلا parsing لنص حر). */
export interface MeterOcrResult {
  roiFound: boolean;
  readingValue: number | null;
  readingDigits: string | null;
  confidence: number; // 0..1
  ambiguous: boolean;
  serial: string | null;
  reason: string | null;
}

interface OcrInput {
  /** قصاصة منطقة القراءة (ROI) كـ data URL — الأساس في التحليل. */
  roiImage: string;
  /** الصورة الكاملة كمرجع سياقي (اختياري). */
  fullImage?: string;
}

const MAX_IMAGE_CHARS = 8_000_000; // ~6MB base64

function validateOcr(input: unknown): OcrInput {
  const obj = (input ?? {}) as Record<string, unknown>;
  const roiImage = typeof obj["roiImage"] === "string" ? obj["roiImage"] : "";
  if (!roiImage.startsWith("data:image/")) throw new Error("صورة منطقة القراءة غير صالحة");
  if (roiImage.length > MAX_IMAGE_CHARS) throw new Error("حجم الصورة كبير جداً");
  const fullRaw = typeof obj["fullImage"] === "string" ? obj["fullImage"] : "";
  const fullImage =
    fullRaw.startsWith("data:image/") && fullRaw.length <= MAX_IMAGE_CHARS ? fullRaw : undefined;
  return fullImage ? { roiImage, fullImage } : { roiImage };
}

const SYSTEM = `أنت خبير قراءة عدادات المياه الميكانيكية والرقمية من الصور.
الصورة الأولى هي قصاصة منطقة القراءة (شاشة/أسطوانات الأرقام) داخل إطار وضعه القارئ الميداني.
الصورة الثانية (إن وُجدت) هي الصورة الكاملة للعداد كمرجع سياقي فقط.

مهمتك: استخراج قراءة الاستهلاك التراكمي فقط (عدّاد الأرقام الأفقي بالمتر المكعب).

قواعد صارمة:
- لا تختر «أكبر رقم في الصورة». اختر فقط الأرقام الظاهرة داخل نافذة/أسطوانات عدّاد الاستهلاك.
- استبعد تماماً: الرقم التسلسلي للعداد (serial)، رقم الموديل، سنة الصنع/التاريخ، قطر الأنبوب (مثل DN15/Q3)، الأرقام المطبوعة على جسم العداد، أرقام المعايرة، الأسعار.
- الخانات الحمراء (كسور اللتر) تُهمل ولا تُدرج في القراءة إلا إذا كانت الشاشة رقمية تعرض كسوراً عشرية صريحة.
- إذا كانت الصورة غير واضحة، أو الأرقام مقطوعة/بين خانتين، أو تحتمل أكثر من قراءة: اضبط ambiguous=true واخفض confidence.
- إذا لم تظهر منطقة قراءة الاستهلاك داخل القصاصة: roiFound=false و readingValue=null.
- لا تخمّن أرقاماً غير مرئية. لا تكمل خانات ناقصة.
- serial: أعده فقط إذا قرأته بوضوح تام من جسم العداد، وإلا null.

أعد JSON فقط بالمخطط التالي وبلا أي نص آخر:
{"roiFound":boolean,"readingValue":number|null,"readingDigits":string|null,"confidence":number,"ambiguous":boolean,"serial":string|null,"reason":string|null}
- readingDigits: الأرقام كما قرأتها نصاً (مثل "00123").
- confidence: بين 0 و1.
- reason: سبب مختصر بالعربية عند الفشل أو الغموض، وإلا null.`;

export const readMeterPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validateOcr)
  .handler(async ({ data }): Promise<MeterOcrResult> => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("خدمة تحليل الصور غير مهيأة.");

    const content: Array<Record<string, unknown>> = [
      { type: "text", text: "اقرأ قراءة الاستهلاك من قصاصة منطقة القراءة التالية." },
      { type: "image_url", image_url: { url: data.roiImage } },
    ];
    if (data.fullImage) {
      content.push({ type: "text", text: "الصورة الكاملة للعداد (سياق فقط):" });
      content.push({ type: "image_url", image_url: { url: data.fullImage } });
    }

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content },
        ],
      }),
    });

    if (res.status === 429) throw new Error("تم تجاوز حد الاستخدام مؤقتاً، أعد المحاولة بعد قليل.");
    if (res.status === 402) throw new Error("رصيد خدمة الذكاء الاصطناعي غير كافٍ.");
    if (!res.ok) {
      console.error("[meter-ocr] gateway error", res.status);
      throw new Error("تعذّر تحليل صورة العداد.");
    }

    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const raw = (payload.choices?.[0]?.message?.content ?? "").trim();
    let parsed: Record<string, unknown>;
    try {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      parsed = JSON.parse(start >= 0 ? raw.slice(start, end + 1) : raw) as Record<string, unknown>;
    } catch {
      return {
        roiFound: false,
        readingValue: null,
        readingDigits: null,
        confidence: 0,
        ambiguous: true,
        serial: null,
        reason: "استجابة غير مفهومة من محرك التحليل",
      };
    }

    const digitsRaw = parsed["readingDigits"];
    const digits = typeof digitsRaw === "string" ? digitsRaw.replace(/[^\d.]/g, "") : null;
    const valueRaw = parsed["readingValue"];
    let value: number | null =
      typeof valueRaw === "number" && Number.isFinite(valueRaw)
        ? valueRaw
        : digits && digits !== "" && Number.isFinite(Number(digits))
          ? Number(digits)
          : null;
    if (value !== null && (value < 0 || value > 9_999_999)) value = null;

    const confRaw = parsed["confidence"];
    const confidence =
      typeof confRaw === "number" && Number.isFinite(confRaw) ? Math.min(Math.max(confRaw, 0), 1) : 0;

    const serialRaw = parsed["serial"];
    const serial =
      typeof serialRaw === "string" && serialRaw.trim().length >= 3 ? serialRaw.trim().slice(0, 40) : null;

    const reasonRaw = parsed["reason"];

    return {
      roiFound: parsed["roiFound"] === true,
      readingValue: value,
      readingDigits: digits && digits !== "" ? digits : null,
      confidence,
      ambiguous: parsed["ambiguous"] === true || value === null,
      serial,
      reason: typeof reasonRaw === "string" && reasonRaw.trim() ? reasonRaw.trim().slice(0, 200) : null,
    };
  });
