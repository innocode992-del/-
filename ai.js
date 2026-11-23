'use strict';

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_API_REVISION = '2026-05-20';
const MAX_MESSAGE_CHARS = 3000;
const MAX_HISTORY_ITEMS = 8;
const MAX_HISTORY_ITEM_CHARS = 1800;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 15;

// Best-effort per-instance protection. Also enable Vercel Firewall / rate limiting
// for /api/ai before sharing the site widely.
const requestBuckets = new Map();

const SYSTEM_INSTRUCTION = `أنت مساعد تعليمي عربي اسمه AI داخل تطبيق حفظني لتعليم القرآن والحفظ.
- أجب بالعربية الواضحة القريبة من المستخدم، وبأسلوب لطيف ومنظم.
- ساعد في فهم المعاني العامة، وخطط الحفظ والمراجعة، ومبادئ التجويد، والتعرّف التعليمي على المقامات الصوتية.
- لا تخترع آيات قرآنية أو أحاديث أو تنسب كلامًا إلى القرآن أو السنة دون تحقق.
- إذا طُلب منك نقل آية حرفيًا أو رقم آية أو حكم تجويد دقيق ولم تكن متأكدًا، صرّح بذلك واطلب مراجعة المصحف أو مصدر موثوق، ولا تخمّن.
- لا تدّعِ أنك شيخ أو عالم أو جهة إفتاء. في الفتاوى والمسائل الشرعية الخاصة، اشرح المعلومات العامة ووجّه المستخدم إلى عالم موثوق.
- لا تزعم أنك استمعت إلى صوت المستخدم أو شاهدت ملفًا ما لم يُرسل لك فعليًا في الطلب.
- اجعل الإجابة مناسبة للمبتدئ، واستخدم أمثلة بسيطة عند الحاجة.`;

function json(res, status, payload) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.json(payload);
}

function parseBody(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch (_) { return null; }
  }
  return null;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return String(req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown');
}

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = requestBuckets.get(ip);
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    requestBuckets.set(ip, { startedAt: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

function makePrompt(message, history) {
  const safeHistory = Array.isArray(history) ? history.slice(-MAX_HISTORY_ITEMS) : [];
  const transcript = safeHistory.map(item => {
    if (!item || typeof item !== 'object') return '';
    const role = item.role === 'model' || item.role === 'assistant' ? 'المساعد' : 'المستخدم';
    const text = String(item.text || '').slice(0, MAX_HISTORY_ITEM_CHARS);
    return text ? `${role}: ${text}` : '';
  }).filter(Boolean).join('\n\n');

  return [
    transcript ? `سجل المحادثة السابقة:\n${transcript}` : '',
    `سؤال المستخدم الحالي:\n${message}`
  ].filter(Boolean).join('\n\n');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'الطلب غير مسموح. استخدم POST.' });
  }

  // Accept browser requests only from the same host as this Vercel deployment.
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (origin && host) {
    try {
      if (new URL(origin).host !== String(host).split(',')[0].trim()) {
        return json(res, 403, { error: 'مصدر الطلب غير مسموح.' });
      }
    } catch (_) {
      return json(res, 403, { error: 'تعذر التحقق من مصدر الطلب.' });
    }
  }

  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return json(res, 429, { error: 'تم الوصول إلى حد الأسئلة المؤقت. انتظر دقيقة ثم حاول مرة أخرى.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(res, 500, { error: 'مفتاح Gemini غير مضبوط بعد. تأكد من إضافة GEMINI_API_KEY إلى مشروع Vercel ثم أعد النشر.' });
  }

  const body = parseBody(req.body);
  if (!body) return json(res, 400, { error: 'تعذر قراءة السؤال. أعد المحاولة.' });

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return json(res, 400, { error: 'اكتب سؤالك أولًا.' });
  if (message.length > MAX_MESSAGE_CHARS) {
    return json(res, 413, { error: `السؤال طويل جدًا. الحد الأقصى ${MAX_MESSAGE_CHARS} حرف.` });
  }

  const prompt = makePrompt(message, body.history);

  try {
    const upstream = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Api-Revision': GEMINI_API_REVISION
      },
      body: JSON.stringify({
        model: MODEL,
        system_instruction: SYSTEM_INSTRUCTION,
        input: prompt,
        store: false,
        generation_config: {
          thinking_level: 'low',
          max_output_tokens: 1400
        }
      }),
      signal: AbortSignal.timeout(45000)
    });

    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const providerMessage = String(result?.error?.message || result?.message || '').slice(0, 350);
      console.error('Gemini API error:', upstream.status, providerMessage || '(no provider message)');

      if (upstream.status === 429) {
        return json(res, 429, { error: 'خدمة Gemini وصلت إلى حد الاستخدام الحالي. حاول لاحقًا أو راجع الحصة في Google AI Studio.' });
      }
      if (upstream.status === 401 || upstream.status === 403) {
        return json(res, 502, { error: 'Gemini رفض المفتاح أو لا يملك صلاحية الاستخدام. راجع GEMINI_API_KEY في Vercel.' });
      }
      if (upstream.status === 400) {
        return json(res, 502, {
          error: providerMessage
            ? `Gemini رفض تفاصيل الطلب (${upstream.status}): ${providerMessage}`
            : 'Gemini رفض تفاصيل الطلب (400). راجع سجل Functions في Vercel.'
        });
      }
      return json(res, 502, {
        error: providerMessage
          ? `تعذر إكمال طلب Gemini (HTTP ${upstream.status}): ${providerMessage}`
          : `تعذر إكمال طلب Gemini (HTTP ${upstream.status}). راجع سجل Functions في Vercel.`
      });
    }

    const outputText = (Array.isArray(result.steps) ? result.steps : [])
      .filter(step => step && step.type === 'model_output')
      .flatMap(step => Array.isArray(step.content) ? step.content : [])
      .filter(part => part && part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n')
      .trim();

    const reply = outputText || (typeof result.output_text === 'string' ? result.output_text.trim() : '');
    if (!reply) {
      console.error('Gemini response did not contain model output text.');
      return json(res, 502, { error: 'وصل رد غير مكتمل من Gemini. حاول مرة أخرى.' });
    }

    return json(res, 200, { reply });
  } catch (error) {
    console.error('AI route failure:', error && error.name ? error.name : 'UnknownError');
    return json(res, 504, { error: 'انتهت مهلة الاتصال بالمساعد. تحقق من الإنترنت ثم أعد المحاولة.' });
  }
};
