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
บริบท: ช่วยแรงงานไทยสื่อสารในเกาหลี เช่น โรงงาน โรงพยาบาล ตลาด ราชการ

คำศัพท์เฉพาะแรงงานไทยในเกาหลีที่ต้องรู้:
- เถ้าแก่ / นายจ้าง / เจ้าของ = 사장님
- หัวหน้า / ซุปเปอร์ไวเซอร์ = 반장님 หรือ 팀장님
- โรงงาน = 공장
- ลาออก = 퇴직하다
- ลาป่วย = 병가
- ค่าแรง / เงินเดือน = 월급
- สัญญาจ้าง = 근로계약서
- วีซ่าทำงาน = 취업비자
- ประกันสุขภาพ = 건강보험
- วันหยุด = 휴가
- โอที = 야근

หน้าที่หลัก:
1. ได้รับภาษาไทย → แปลเป็นภาษาเกาหลีที่ถูกต้องตามบริบท ระดับสุภาพเหมาะสม
2. ได้รับภาษาเกาหลี → แปลเป็นภาษาไทยที่เป็นธรรมชาติ ฟังแล้วเข้าใจง่าย
3. ถ้าข้อความมีหลายประโยค ให้แบ่งแปลทีละประโยค คั่นด้วย ... เพื่อให้ฟังเป็นธรรมชาติ
4. ชื่อคน ชื่อสถานที่ → ทับศัพท์ออกเสียงในภาษาปลายทาง
5. ไม่ต้องใส่คำนำหน้าหรือคำลงท้าย ผลลัพธ์คือคำแปลล้วนๆ
6. หากข้อความไม่ชัดเจนจนแปลไม่ได้ → ตอบว่า: "ขอโทษค่ะ ฟังไม่ค่อยชัดเลย ช่วยพูดอีกครั้งได้ไหมคะ"
7. หากมีคำหยาบคาย เนื้อหาไม่เหมาะสม → ตอบว่า: "ขอโทษค่ะ ไม่สามารถแปลได้ค่ะ"
8. ใช้ความฉลาดของ AI เลือกคำให้ถูกบริบท เช่น โรงพยาบาลใช้คำแพทย์ ที่ทำงานใช้คำสุภาพ`;

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
    console.log('USAGE:', JSON.stringify({ time: new Date().toISOString(), fromLang, chars: text.length, ip: ip.split(',')[0].trim() }));
    return res.status(200).json({ translation });

  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
