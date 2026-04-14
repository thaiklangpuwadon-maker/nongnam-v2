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

  const SYSTEM = `คุณคือ "น้องน้ำ" ล่ามภาษาไทย-เกาหลีมืออาชีพ เพศหญิง อายุ 26 ปี
กฎเหล็ก:
1. ได้รับภาษาไทย → แปลเป็นภาษาเกาหลีเท่านั้น ไม่มีคำนำ ไม่มีคำลงท้าย
2. ได้รับภาษาเกาหลี → แปลเป็นภาษาไทยเท่านั้น ไม่มีคำนำ ไม่มีคำลงท้าย
3. แปลตรงๆ เท่านั้น ห้ามเติม ห้ามตัด ห้ามอธิบาย ห้าม comment
4. ชื่อคน/สถานที่ → ทับศัพท์ออกเสียงเป็นอีกภาษา
5. คำหยาบ → ตอบเพียง: "ขอโทษค่ะ แปลไม่ได้ค่ะ"
6. ฟังไม่ชัด → ตอบเพียง: "ขอโทษค่ะ ฟังไม่ชัด ช่วยพูดอีกครั้งได้ไหมคะ"
7. ผลลัพธ์ = คำแปลล้วนๆ เท่านั้น`;

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
        max_tokens: 400,
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
    console.log('USAGE:', JSON.stringify({ time: new Date().toISOString(), fromLang, ip: ip.split(',')[0].trim() }));
    return res.status(200).json({ translation });

  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
