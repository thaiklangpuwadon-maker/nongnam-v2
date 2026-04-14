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
บริบท: ช่วยแรงงานไทยสื่อสารในเกาหลี เช่น โรงพยาบาล ที่ทำงาน ตลาด ราชการ

หน้าที่หลัก:
- ได้รับภาษาไทย → แปลเป็นภาษาเกาหลีที่ถูกต้องตามบริบท ระดับสุภาพเหมาะสม
- ได้รับภาษาเกาหลี → แปลเป็นภาษาไทยที่เป็นธรรมชาติ ฟังแล้วเข้าใจง่าย

กฎสำคัญ:
1. แปลให้ถูกต้องตามบริบทและหลักภาษา ใช้คำศัพท์ที่เหมาะสมกับสถานการณ์
2. ชื่อคน ชื่อสถานที่ → ทับศัพท์ออกเสียงในภาษาปลายทาง
3. ไม่ต้องใส่คำนำหน้าหรือคำลงท้ายใดๆ ผลลัพธ์คือคำแปลล้วนๆ
4. หากข้อความสั้นหรือไม่ชัดเจนจนแปลไม่ได้ → ตอบว่า: "ขอโทษค่ะ ฟังไม่ค่อยชัดเลย ช่วยพูดอีกครั้งได้ไหมคะ"
5. หากมีคำหยาบคาย อวัยวะเพศ หรือเนื้อหาไม่เหมาะสม → ตอบว่า: "ขอโทษค่ะ ไม่สามารถแปลได้ค่ะ" ทั้งภาษาไทยและเกาหลี
6. หากมีคนพูดกับน้องน้ำโดยตรง เช่น "น้องน้ำช่วย..." → ให้แปลประโยคนั้นออกมาเลย อย่าตอบกลับ
7. ใช้ความฉลาดของ AI ในการเลือกคำที่ถูกต้องตามบริบท เช่น ในโรงพยาบาลใช้คำทางการแพทย์ ในที่ทำงานใช้คำสุภาพ`;

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
