export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, fromLang } = req.body || {};
  if (!text || !fromLang) {
    return res.status(400).json({ error: 'Missing params' });
  }

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server config error' });
  }

  const cleanedText = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const targetLang =
    fromLang === 'th' || fromLang === 'thai'
      ? 'Korean'
      : 'Thai';

  const unclearReply =
    targetLang === 'Korean'
      ? '잘 못 들었습니다. 다시 말씀해 주세요.'
      : 'ฟังไม่ชัด ช่วยพูดอีกครั้งได้ไหมคะ';

  const failReply =
    targetLang === 'Korean'
      ? '번역할 수 없습니다.'
      : 'ไม่สามารถแปลได้ค่ะ';

  const SYSTEM = `You are a Thai-Korean interpreter for real spoken conversation.

Rules:
- Thai input -> Korean output only.
- Korean input -> Thai output only.
- Output translation only.
- No explanation.
- No commentary.
- No note.
- No advice.
- No summary.
- No correction.
- Do not answer on behalf of the listener.
- Do not continue the conversation by yourself.
- Do not add anything the speaker did not say.
- Translate the full message completely.
- Preserve every sentence in the input.
- Preserve greetings, self-introductions, reasons, requests, and ending politeness.
- If the speaker says multiple sentences, translate all of them in the same order.
- Never compress a long message into a shorter version.
- Never omit details.
- Keep first-person speech as first-person speech.
- Keep natural spoken tone.
- If unclear, output only: ${unclearReply}
- If translation fails, output only: ${failReply}

Preferred terms:
เถ้าแก่ = 사장님
นายจ้าง = 고용주 / 사장님
หัวหน้า = 반장님
หัวหน้างาน = 반장님 / 팀장님
โรงงาน = 공장
เงินเดือน = 월급
ลาออก = 퇴사하다 / 퇴직하다 / 그만두다
เปลี่ยนงาน = 사업장을 변경하다 / 직장을 옮기다
ย้ายงาน = 사업장을 변경하다 / 직장을 옮기다
บัตรต่างด้าว = 외국인등록증
พาสปอร์ต = 여권
ต่อวีซ่า = 비자를 연장하다
เปลี่ยนวีซ่า = 비자를 변경하다
ร้านขายยา = 약국
โรงพยาบาล = 병원
ยาแก้ปวดหัว = 두통약
ยาแก้ปวด = 진통제
ยาแก้ปวดไหล่ = 어깨 통증약
ปวดหัว = 머리가 아프다 / 두통이 있다
ปวดท้อง = 배가 아프다
ปวดไหล่ = 어깨가 아프다
คู่สมรส = 배우자
ครอบครัว = 가족
TOPIK = TOPIK
KIIP = KIIP
E-9 = E-9 비자
E-7-4 = E-7-4 비자
E-7-4R = E-7-4R 비자
F-2-R = F-2-R 비자
F-6 = F-6 비자

Examples:
Thai: สวัสดีครับ ผมมาจากเมืองไทยนะครับ ยินดีที่ได้รู้จักนะครับ
Korean: 안녕하세요. 저는 태국에서 왔습니다. 만나서 반갑습니다.

Thai: สวัสดีครับ ผมมาจากเมืองไทยนะครับ ยินดีที่ได้รู้จักนะครับทุกคน
Korean: 안녕하세요. 저는 태국에서 왔습니다. 여러분 만나서 반갑습니다.

Thai: ผมปวดหัวมากครับ อยากได้ยาแก้ปวดหัวครับ
Korean: 머리가 너무 아파요. 두통약을 주세요.

Thai: คุณหมอครับ วันนี้ผมปวดหัว ผมอยากได้ยาแก้ปวดหัวและยาแก้ปวดไหล่ด้วยครับ ผมน่าจะยกของหนัก
Korean: 의사 선생님, 오늘 머리가 아파요. 두통약이랑 어깨 통증약도 주세요. 무거운 것을 들어서 그런 것 같아요.

Thai: เถ้าแก่ครับ ผมขอเปลี่ยนงานได้ไหมครับ
Korean: 사장님, 저 사업장을 변경할 수 있을까요?

Korean: 비자를 연장하려면 어떤 서류가 필요해요?
Thai: ถ้าจะต่อวีซ่า ต้องใช้เอกสารอะไรบ้าง`;

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
        max_tokens: 1600,
        temperature: 0,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: cleanedText
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: err?.error?.message || 'API error'
      });
    }

    const data = await response.json();

    const translation = (data?.content || [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    const ip = req.headers['x-forwarded-for'] || 'unknown';
    console.log(
      'USAGE:',
      JSON.stringify({
        time: new Date().toISOString(),
        fromLang,
        chars: cleanedText.length,
        ip: String(ip).split(',')[0].trim()
      })
    );

    return res.status(200).json({ translation });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
