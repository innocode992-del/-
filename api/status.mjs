/** GET /api/status - reports only whether the server-side key exists. */
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ configured: false, error: 'الطريقة دي مش مدعومة.' });
  }

  const key = process.env.GEMINI_API_KEY;
  const configured = Boolean(key && !key.includes('PASTE_') && key !== 'your_api_key_here');
  return res.status(200).json({
    configured,
    provider: 'Gemini',
    model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
    message: configured ? 'مفتاح Gemini موجود على الخادم.' : 'أضف GEMINI_API_KEY في Vercel Environment Variables.'
  });
}
