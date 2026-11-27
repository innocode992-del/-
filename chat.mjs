/**
 * Hafazni - AI Yaseen bin Mohammed
 * POST /api/chat
 * Gemini Developer API. Keep GEMINI_API_KEY in Vercel Environment Variables.
 */

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const MAX_BODY_BYTES = 32_000;
const MAX_MESSAGES = 14;
const MAX_MESSAGE_CHARS = 3_000;
const MAX_TOTAL_CHARS = 14_000;
const REQUEST_TIMEOUT_MS = 25_000;

const SYSTEM_INSTRUCTION = [
  'أنت AI ياسين بن محمد، المساعد الذكي داخل تطبيق حفظني.',
  'تحدث بلغة المستخدم. عندما يكتب بالعربية المصرية، أجب بالمصرية الطبيعية الواضحة والودودة.',
  'أنت مساعد كتابة فقط؛ لا تدّعِ أنك ترسل صوتًا أو تنفّذ أفعالًا على جهاز المستخدم.',
  'ساعد في استخدام تطبيق حفظني، وحفظ القرآن ومراجعته، والتجويد، والأذكار، ومواقيت الصلاة، والأسئلة العامة.',
  'في المسائل القرآنية والدينية: لا تخترع آيات أو أحاديث أو أحكامًا أو نسبًا للمصادر. إذا لم تكن متأكدًا فقل ذلك بوضوح، وميّز بين المعلومة القطعية والشرح أو الرأي، وانصح بالرجوع إلى مصحف موثوق أو عالم مؤهل عند الحاجة.',
  'لا تزعم أنك ترى بيانات التطبيق أو تعرف موقع المستخدم أو صلاته أو تقدمه في الحفظ إلا إذا ذكر المستخدم ذلك في المحادثة.',
  'أجب مباشرة وبشكل مفيد، واستخدم تنسيقًا بسيطًا مناسبًا للهاتف.'
].join('\n');

function sendJson(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(status).json(payload);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('BODY_TOO_LARGE');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n').trim();
}

function mapHistory(rawMessages) {
  const messages = rawMessages.slice(-MAX_MESSAGES).map(item => {
    const role = item?.role === 'assistant' || item?.role === 'model' ? 'model'
      : item?.role === 'user' ? 'user' : null;
    const text = typeof item?.content === 'string' ? item.content.trim().slice(0, MAX_MESSAGE_CHARS)
      : typeof item?.text === 'string' ? item.text.trim().slice(0, MAX_MESSAGE_CHARS) : '';
    return role && text ? { role, parts: [{ text }] } : null;
  }).filter(Boolean);

  // Gemini requires the conversation to begin with a user turn and alternate roles.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  const normalized = [];
  for (const message of messages) {
    const previous = normalized[normalized.length - 1];
    if (previous && previous.role === message.role) {
      previous.parts[0].text += '\n\n' + message.parts[0].text;
    } else {
      normalized.push(message);
    }
  }
  return normalized;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'الطريقة دي مش مدعومة.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.includes('PASTE_') || apiKey === 'your_api_key_here') {
    return sendJson(res, 503, { error: 'مفتاح Gemini مش متضاف في إعدادات Environment Variables على Vercel.' });
  }

  const contentLength = Number(req.headers?.['content-length'] || 0);
  if (contentLength > MAX_BODY_BYTES) return sendJson(res, 413, { error: 'حجم المحادثة كبير جدًا.' });

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return sendJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, {
      error: error?.code === 'BODY_TOO_LARGE' ? 'حجم المحادثة كبير جدًا.' : 'بيانات الطلب غير سليمة.'
    });
  }

  if (!Array.isArray(body?.messages) || !body.messages.length) {
    return sendJson(res, 400, { error: 'مفيش رسائل للإرسال.' });
  }

  const contents = mapHistory(body.messages);
  if (!contents.length || contents[contents.length - 1].role !== 'user') {
    return sendJson(res, 400, { error: 'آخر رسالة لازم تكون من المستخدم.' });
  }

  let totalChars = 0;
  for (const item of contents) totalChars += item.parts[0].text.length;
  while (contents.length > 1 && totalChars > MAX_TOTAL_CHARS) {
    totalChars -= contents.shift().parts[0].text.length;
  }

  const profileName = typeof body.profileName === 'string' ? body.profileName.trim().slice(0, 60) : '';
  const systemInstruction = profileName
    ? `${SYSTEM_INSTRUCTION}\nاسم المستخدم الذي ذكره بنفسه في التطبيق: ${profileName}. استخدم الاسم باعتدال عند ملاءمة الرد.`
    : SYSTEM_INSTRUCTION;
  const model = (process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 1200 }
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') return sendJson(res, 504, { error: 'Gemini اتأخر في الرد. جرّب تاني بعد شوية.' });
    return sendJson(res, 502, { error: 'تعذر الوصول إلى Gemini من خادم الموقع. جرّب تاني.' });
  } finally {
    clearTimeout(timeout);
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    return sendJson(res, 502, { error: 'وصل رد غير مفهوم من Gemini.' });
  }

  if (!upstream.ok) {
    const apiMessage = typeof data?.error?.message === 'string' ? data.error.message : '';
    let message = 'Gemini رجّع خطأ غير متوقع. جرّب تاني.';
    if (upstream.status === 400) message = 'Gemini رفض صيغة الطلب. جرّب سؤالًا أقصر.';
    else if (upstream.status === 401 || upstream.status === 403) message = 'مفتاح Gemini غير صحيح أو ليس لديه صلاحية لهذا المشروع. راجعه في Vercel.';
    else if (upstream.status === 404) message = `موديل Gemini (${model}) غير متاح لهذا المفتاح. راجع اسم GEMINI_MODEL.`;
    else if (upstream.status === 429) message = 'وصلت لحد الاستخدام المجاني في Gemini حاليًا. انتظر تجدد الحد ثم جرّب مرة أخرى.';
    else if (upstream.status === 500 || upstream.status === 503) message = 'خدمة Gemini مشغولة أو فيها عطل مؤقت. جرّب مرة تانية بعد قليل.';
    // Keep the full provider error in server logs only; never expose key or raw request data.
    console.error('Hafazni Gemini API error:', upstream.status, apiMessage.slice(0, 500));
    return sendJson(res, 502, { error: message });
  }

  const reply = extractText(data);
  if (!reply) {
    const reason = data?.promptFeedback?.blockReason;
    if (reason) return sendJson(res, 422, { error: 'Gemini لم يتمكن من الإجابة على الطلب ده بسبب سياسات السلامة.' });
    return sendJson(res, 502, { error: 'Gemini رجّع ردًا من غير نص. جرّب صياغة السؤال بطريقة مختلفة.' });
  }

  return sendJson(res, 200, { reply, model, provider: 'Gemini' });
}
