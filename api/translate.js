export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, fromLang } = req.body || {};
  if (!text || !fromLang) return res.status(400).json({ error: 'Missing params' });

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server config error' });

  const cleanedText = String(text)
    .replace(/\r\n/g, '\n').replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  const sourceLang = (fromLang === 'th' || fromLang === 'thai') ? 'Thai' : 'Korean';
  const targetLang = sourceLang === 'Thai' ? 'Korean' : 'Thai';
  const unclearReply = targetLang === 'Korean' ? '잘 못 들었습니다. 다시 말씀해 주세요.' : 'ฟังไม่ชัด ช่วยพูดอีกครั้งได้ไหมคะ';
  const failReply = targetLang === 'Korean' ? '번역할 수 없습니다.' : 'ไม่สามารถแปลได้ค่ะ';

  async function callAnthropic(system, userContent, maxTokens = 1200) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, temperature: 0, system, messages: [{ role: 'user', content: userContent }] })
    });
    if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(err?.error?.message || 'API error'); }
    const data = await response.json();
    return (data?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('\n').trim();
  }

  const NORMALIZE_SYSTEM = `You are a transcript normalizer for Thai and Korean speech-to-text output.
Your job: Clean up spoken transcript without changing meaning. Preserve EVERY word, sentence, compliment, and emotion.
Do not shorten. Do not summarize. Do not omit anything. Only restore punctuation and sentence boundaries.
Question detection - Korean: 요,까요,니까,죠,어때요,있어요,없어요 / Thai: ไหม,หรือเปล่า,หรือยัง,ได้ไหม,ใช่ไหม
Add ? when clearly a question. Keep statements as statements.
Output: cleaned text in source language only. No explanation.`;

  const TRANSLATE_SYSTEM = `You are a Thai-Korean interpreter for real spoken conversation.

Rules:
- Thai input -> Korean output only. Korean input -> Thai output only.
- Output translation only. No explanation. No commentary. No notes. No advice.
- Translate the FULL message completely. Never cut, never shorten, never summarize.
- Preserve EVERY sentence in order. Preserve greetings, reasons, requests, compliments, emotions, endings.
- Never compress a long message. Never omit details.
- Keep first-person speech as first-person speech. Keep natural spoken tone.
- If source is a question, translate as a question. Do not turn questions into statements.
- Translate naturally, not word-for-word mechanical translation.

IMPORTANT about compliments and emotions:
- Compliments like "คุณสวยมาก" "ผมรักคุณ" "คุณน่ารัก" are completely NORMAL speech — translate them fully.
- Affection, admiration, love, emotions are NORMAL — never omit, never refuse.
- Only refuse explicit sexual harassment or direct threats of violence.
- If unclear: ${unclearReply}
- If truly offensive (sexual harassment only): ${failReply}

Vocabulary:
เถ้าแก่/นายจ้าง=사장님 | หัวหน้า=반장님 | โรงงาน=공장 | เงินเดือน=월급
ลาออก=퇴사하다 | เปลี่ยนงาน=사업장을 변경하다 | ย้ายงาน=직장을 옮기다
บัตรต่างด้าว/ใบกาม่า/บัตรกาม่า/กาม่า=외국인등록증 | พาสปอร์ต=여권
ต่อวีซ่า=비자를 연장하다 | เปลี่ยนวีซ่า=비자를 변경하다
E-9=E-9 비자 | E-7-4=E-7-4 비자 | E-7-4R=E-7-4R 비자 | F-2-R=F-2-R 비자 | F-6=F-6 비자
TOPIK=TOPIK | KIIP=KIIP
โรงพยาบาล=병원 | ร้านขายยา=약국 | ยาแก้ปวด=진통제 | ยาแก้ปวดหัว=두통약
ปวดหัว=머리가 아프다 | ปวดท้อง=배가 아프다 | ปวดไหล่=어깨가 아프다
กุ๊กมิน/กุกมิน/กูมิน=국민연금 | เงินกุกมินสะสม=국민연금 적립금
ขอเงินกุกมินคืน=국민연금 환급 신청 | รับเงินกุกมินคืน=국민연금 환급받다
เทจิก/แทจิก/เตจิก=퇴직금 | เงินเทจิก/เงินแทจิก=퇴직금
ประกันสังคม=사회보험/4대보험 | ประกันสุขภาพ=건강보험
ประกันอุบัติเหตุ=산재보험 | ประกันการจ้างงาน=고용보험
เงินประกันเดินทาง=출국만기보험금 | เงินประกันกลับประเทศ=귀국비용보험금
เงินประกันครบสัญญา=만기보험금 | เงินประกันนายจ้าง=보증보험금
ภาษี=세금 | ภาษีเงินได้=소득세 | คืนภาษี=세금 환급 | ขอคืนภาษี=세금 환급 신청
ยื่นภาษีประจำปี=연말정산 | หักภาษี=세금을 공제하다
รายได้สุทธิ=순소득 | เงินเดือนสุทธิ=실수령액 | เงินเดือนก่อนหัก=세전 월급
ค่าล่วงเวลา/ค่าโอที=초과근무수당/야근수당
เงินค้างจ่าย/เงินเดือนค้าง=미지급 임금/체불임금
บัญชีธนาคาร=은행 계좌 | โอนเงิน=송금하다 | โอนเงินกลับไทย=해외송금하다
สัญญาจ้าง=근로계약서 | หมดสัญญา=계약 만료 | ต่อสัญญา=계약 연장
เลิกจ้าง=해고되다 | เงินชดเชย=보상금

Examples:
Thai: สวัสดีครับ ผมมาจากเมืองไทยครับ ยินดีที่ได้รู้จักครับ
Korean: 안녕하세요. 저는 태국에서 왔습니다. 만나서 반갑습니다.

Thai: คุณสวยมากเลยครับ ผมรักคุณนะครับ
Korean: 너무 예뻐요. 사랑해요.

Thai: สวัสดีครับเถ้าแก่ ผมอยากลาออกครับ จะได้กลับไทยครับ
Korean: 안녕하세요, 사장님. 저는 퇴사하고 싶습니다. 태국으로 돌아가려고 합니다.

Korean: 밥 먹었어요?
Thai: กินข้าวหรือยัง

Korean: 밥 먹었어요.
Thai: กินข้าวแล้ว

Korean: 어디가 아파요?
Thai: เจ็บตรงไหนคะ

Korean: 비자를 연장하려면 어떤 서류가 필요해요?
Thai: ถ้าจะต่อวีซ่า ต้องใช้เอกสารอะไรบ้างคะ`;

  try {
    const normalizedText = await callAnthropic(NORMALIZE_SYSTEM,
      `Language: ${sourceLang}\nNormalize this transcript. Preserve every word including compliments and emotions.\n\nText:\n${cleanedText}`, 1000);

    const translation = await callAnthropic(TRANSLATE_SYSTEM, normalizedText, 1600);

    const ip = req.headers['x-forwarded-for'] || 'unknown';
    console.log('USAGE:', JSON.stringify({ time: new Date().toISOString(), fromLang, chars: cleanedText.length, ip: String(ip).split(',')[0].trim() }));

    return res.status(200).json({ translation });
  } catch (err) {
    console.error('ERROR:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
