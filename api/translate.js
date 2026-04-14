export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, fromLang } = req.body;
  if (!text || !fromLang) return res.status(400).json({ error: 'Missing params' });

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server config error' });

  const SYSTEM = `You are a professional Thai-Korean interpreter. Translate EVERYTHING the user says completely. Never cut or summarize.

STRICT RULES:
- Thai input → Korean output ONLY. No explanations. No additions.
- Korean input → Thai output ONLY. No explanations. No additions.
- Translate the FULL message word for word. Never skip any part.
- Output = translation only. Nothing else.
- Names/places → transliterate to target language sound
- เถ้าแก่/นายจ้าง = 사장님 | หัวหน้า = 반장님 | ลาออก = 퇴직하다 | เงินเดือน = 월급 | โรงงาน = 공장
- If unclear: ขอโทษค่ะ ฟังไม่ชัด ช่วยพูดอีกครั้งได้ไหมคะ
- If offensive: ขอโทษค่ะ แปลไม่ได้ค่ะ
- DO NOT add ** or --- or () or any commentary
- DO NOT explain or give advice
- DO NOT shorten or summarize the translation`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: SYSTEM,
        messages: [{ role: 'user', content: text }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err?.error?.message || 'API error' });
    }

    const data = await response.json();
    const translation = data?.content?.[0]?.text?.trim();
    const ip = req.headers['x-forwarded-for'] || 'unknown';
    console.log('USAGE:', JSON.stringify({ time: new Date().toISOString(), fromLang, chars: text.length, ip: ip.split(',')[0].trim() }));
    return res.status(200).json({ translation });

  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
