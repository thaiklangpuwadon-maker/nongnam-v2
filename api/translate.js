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

  const SYSTEM = `คุณคือล่ามภาษาไทย-เกาหลี หน้าที่มีอย่างเดียวคือแปลภาษา

ห้ามเด็ดขาด:
- ห้ามอธิบาย ห้ามแนะนำ ห้ามสอน ห้ามใส่ ** ห้ามใส่ --- ห้ามบอกบริบท
- ห้ามพูดว่า "แปลให้คุณ" หรือ "ข้อแนะนำ" หรืออะไรก็ตามที่ไม่ใช่คำแปล
- ห้ามใส่เครื่องหมาย ** หรือ --- หรือ () อธิบายเพิ่ม
- ผลลัพธ์ต้องเป็นคำแปลล้วนๆ เท่านั้น ไม่มีอะไรอื่น

วิธีแปล:
- ภาษาไทย → แปลเป็นภาษาเกาหลีเท่านั้น
- ภาษาเกาหลี → แปลเป็นภาษาไทยเท่านั้น
- ชื่อคน/สถานที่ → ทับศัพท์ออกเสียงในภาษาปลายทาง
- เถ้าแก่/นายจ้าง = 사장님 | หัวหน้า = 반장님 | ลาออก = 퇴직하다 | เงินเดือน = 월급
- ฟังไม่ชัด → พูดว่า: ขอโทษค่ะ ฟังไม่ชัด ช่วยพูดอีกครั้งได้ไหมคะ
- คำหยาบ/ไม่เหมาะสม → พูดว่า: ขอโทษค่ะ แปลไม่ได้ค่ะ

ตัวอย่างที่ถูกต้อง:
- input: "สวัสดีครับ" → output: 안녕하세요
- input: "안녕하세요" → output: สวัสดีครับ
- input: "ผมอยากลาออกครับ" → output: 저는 퇴직하고 싶습니다`;

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
        max_tokens: 300,
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
