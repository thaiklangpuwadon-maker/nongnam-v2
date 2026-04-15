export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, fromLang, context, prev_turn, last_th } = req.body || {};
  if (!text || !fromLang) return res.status(400).json({ error: 'Missing params' });

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server config error' });

  const cleanedText = String(text)
    .replace(/\r\n/g, '\n').replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  const sourceLang = (fromLang === 'th' || fromLang === 'thai') ? 'Thai' : 'Korean';
  const targetLang = sourceLang === 'Thai' ? 'Korean' : 'Thai';
  const unclearReply = targetLang === 'Korean'
    ? '잘 못 들었습니다. 다시 말씀해 주세요.'
    : 'ฟังไม่ชัด ช่วยพูดอีกครั้งได้ไหมคะ';
  const failReply = targetLang === 'Korean'
    ? '번역할 수 없습니다.'
    : 'ไม่สามารถแปลได้ค่ะ';

  // ── Vocabulary by situation ──
  const VOCAB_CORE = `
เถ้าแก่/ซาจัง/ซาจังนิม/นายจ้าง=사장님 | หัวหน้า/พันจัง/บันจัง=반장님
โรงงาน/คงจัง/กงจัง=공장 | เงินเดือน=월급 | สลิปเงินเดือน=급여명세서
กินข้าวหรือยัง=밥 먹었어요? | กินข้าวแล้ว=밥 먹었어요
รอแป๊บ=잠깐만요 | ไม่เข้าใจ=이해 못 했어요 | พูดช้าๆ=천천히 말해 주세요
พูดอีกที=다시 말해 주세요 | ได้=돼요 | ไม่ได้=안 돼요 | ไม่เป็นไร=괜찮아요`;

  // ── บริบทความเป็นจริงของแต่ละสถานการณ์ ──
  const SITUATION_CONTEXT = {
    hospital: 'Situation: medical clinic/hospital. Focus on medical vocabulary.',
    work: 'Situation: workplace/factory. Focus on labor and work vocabulary.',
    visa: 'Situation: immigration office. Focus on visa and legal vocabulary.',
    bank: 'Situation: bank. Focus on banking and money transfer vocabulary.',
    food: 'Situation: restaurant. Focus on food ordering vocabulary.',
    shop: 'Situation: shopping. Focus on retail vocabulary.',
    travel: 'Situation: travel/directions. Focus on transportation vocabulary.',
    housing: 'Situation: housing/rental. Focus on accommodation vocabulary.',
    emergency: 'Situation: emergency. Prioritize urgent help vocabulary.',
    money: 'Situation: insurance/tax. Focus on financial vocabulary.',
    general: ''
  };

    const VOCAB_BY_SITUATION = {
    work: `
[งาน/โรงงาน]
ลาออก=퇴사하다 | ไล่ออก=해고되다 | เปลี่ยนงาน/ย้ายงาน=사업장을 변경하다
สัญญาจ้าง=근로계약서 | หมดสัญญา=계약 만료 | ต่อสัญญา=계약 연장
โอที/ค่าโอที=야근/야근수당 | วันหยุด=휴무일 | ลาป่วย=병가 | ลาพักร้อน=연차
มาสาย=지각하다 | ขาดงาน=결근하다 | เข้างาน=출근하다 | เลิกงาน=퇴근하다
เงินเดือนสุทธิ=실수령액 | เงินเดือนก่อนหัก=세전 월급 | หักเงิน=공제
โดนหักเงิน=돈이 공제됐다 | เงินเดือนค้าง=임금 체불 | นายจ้างไม่จ่ายเงิน=사장이 돈을 안 준다
โดนโกงเงิน=돈을 사기당했다 | โดนเอาเปรียบ=부당한 대우를 받다`,

    visa: `
[วีซ่า/ราชการ]
บัตรต่างด้าว/ใบกาม่า/กาม่า/บัตรกาม่า=외국인등록증 | พาสปอร์ต=여권
ตม/ซุลลิก/ซุลลิกซา=출입국관리사무소
ต่อวีซ่า=비자 연장 | เปลี่ยนวีซ่า=비자 변경 | ยื่นวีซ่า=비자 신청
เอกสาร=서류 | ยื่นเอกสาร=서류 제출 | นัด/จองคิว=예약하다
หมดวีซ่า=비자 만료 | เกินวีซ่า=체류기간 초과 | แรงงานผิดกฎหมาย=불법체류자
E-9/อีเก้า/อีนาย=E-9 비자 | E-7-4/อีเจ็ดสี่=E-7-4 비자
E-7-4R=E-7-4R 비자 | F-2-R/เอฟทูอาร์=F-2-R 비자 | F-6/เอฟหก=F-6 비자
TOPIK=TOPIK | KIIP=KIIP`,

    money: `
[เงิน/ภาษี/ประกัน]
กุ๊กมิน/กุกมิน/กูมิน/เงินกุกมิน=국민연금
เงินกุกมินสะสม=국민연금 적립금 | ขอเงินกุกมินคืน=국민연금 환급 신청
เทจิก/แทจิก/เตจิก/เงินเทจิก=퇴직금
ประกันสังคม=사회보험/4대보험 | ประกันสุขภาพ=건강보험
ประกันอุบัติเหตุ=산재보험 | ประกันการจ้างงาน=고용보험
เงินประกันเดินทาง=출국만기보험금 | เงินประกันกลับประเทศ=귀국비용보험금
ภาษี=세금 | ภาษีเงินได้=소득세 | คืนภาษี=세금 환급 | ยื่นภาษีประจำปี=연말정산
ค่าล่วงเวลา/ค่าโอที=초과근무수당`,

    hospital: `
[โรงพยาบาล/ร้านขายยา]
โรงพยาบาล=병원 | คลินิก=의원 | ร้านขายยา=약국 | หมอ=의사 | พยาบาล=간호사
ปวดหัว=머리가 아프다 | ปวดท้อง=배가 아프다 | ปวดไหล่=어깨가 아프다
เวียนหัว=어지럽다 | มีไข้=열이 나다 | ไอ=기침하다
ยาแก้ปวด=진통제 | ยาแก้ปวดหัว=두통약 | ยาแก้อักเสบ=소염제
กินยา=약을 먹다 | ฉีดยา=주사 맞다 | นัดหมอ=진료 예약`,

    bank: `
[ธนาคาร]
ธนาคาร=은행 | เปิดบัญชี=계좌 개설 | ปิดบัญชี=계좌 해지
สมุดบัญชี=통장 | บัตรเอทีเอ็ม=체크카드 | บัตรเครดิต=신용카드
โอนเงิน=송금하다 | โอนเงินกลับไทย=해외송금 | ฝากเงิน=입금하다 | ถอนเงิน=출금하다
ยอดเงิน/ยอดคงเหลือ=잔액 | ค่าธรรมเนียมโอน=송금 수수료
บัญชีโดนล็อค=계좌가 막혔다 | ลืมรหัส=비밀번호 잊어버렸다`,

    food: `
[ร้านอาหาร]
ร้านอาหาร/ร้านข้าว=식당 | เมนู=메뉴 | สั่งอาหาร=주문하다
เอาอันนี้=이걸로 주세요 | ห่อกลับ/เอากลับบ้าน=포장해 주세요
ขอน้ำ=물 주세요 | ไม่เผ็ด=안 맵게 | เผ็ดน้อย=덜 맵게
อร่อย=맛있어요 | คิดเงิน=계산해 주세요`,

    shop: `
[ช้อปปิ้ง]
ราคาเท่าไหร่=얼마예요 | แพงไป=너무 비싸요 | ลดหน่อย=좀 깎아 주세요
ขอถุง=봉투 주세요 | ขอใบเสร็จ=영수증 주세요`,

    travel: `
[เดินทาง]
รถเมล์/บัส/บาซือ=버스 | รถไฟฟ้า/ซับเว/ซับเวย์/จีฮาชอล=지하철
แท็กซี่/แทกซี่=택시 | สถานี=역 | เรียกแท็กซี่=택시 부르다
ไปทางไหน=어디로 가요 | หลงทาง=길을 잃었어요 | จอดตรงนี้=여기서 세워 주세요
ซ้าย=왼쪽 | ขวา=오른쪽 | ตรงไป=직진 | เลี้ยวซ้าย=좌회전 | เลี้ยวขวา=우회전
ขึ้นรถ=타다 | ลงรถ=내리다 | เปลี่ยนสาย=환승하다`,

    housing: `
[ที่พัก]
บ้านเช่า/ห้องเช่า=월세방/원룸 | ค่าเช่า=월세 | เงินมัดจำ=보증금
เจ้าของบ้าน=집주인 | ย้ายบ้าน=이사하다 | ย้ายออก=이사 나가다
น้ำไม่ไหล=물이 안 나와요 | ไฟดับ=전기가 나갔어요 | ฮีตเตอร์เสีย=난방 고장`,

    emergency: `
[ฉุกเฉิน]
ช่วยด้วย=도와 주세요 | เจ็บมาก=많이 아파요 | เรียกรถพยาบาล=구급차 불러 주세요
โทรตำรวจ=경찰에 전화하다 | ของหาย=잃어버렸어요 | โดนโกง=사기당했어요
มีปัญหา=문제가 있다`,

    general: ''
  };

  // Parse situation from context string
  const sitKey = context && context.includes('โรงพยาบาล') ? 'hospital'
    : context && context.includes('ทำงาน') ? 'work'
    : context && context.includes('ราชการ') ? 'visa'
    : context && context.includes('ร้านค้า') ? 'shop'
    : 'general';

  // Auto-detect situation from text if not set
  const autoDetect = (t) => {
    if (/ปวด|หมอ|ยา|โรงพยาบาล|ไข้|เจ็บ|คลินิก/.test(t)) return 'hospital';
    if (/เถ้าแก่|ลาออก|เงินเดือน|สัญญา|โรงงาน|โอที/.test(t)) return 'work';
    if (/วีซ่า|กาม่า|ตม|พาสปอร์ต|ต่อวีซ่า/.test(t)) return 'visa';
    if (/ธนาคาร|โอนเงิน|กุกมิน|เทจิก|ประกัน/.test(t)) return 'money';
    if (/택시|지하철|버스|หลงทาง|รถไฟ/.test(t)) return 'travel';
    return sitKey;
  };

  const finalSit = autoDetect(cleanedText);
  const situationCtx = SITUATION_CONTEXT[finalSit] || '';
  const vocabSections = [VOCAB_CORE];
  // Always include work+visa+money as base for Thai workers in Korea
  if (finalSit !== 'work') vocabSections.push(VOCAB_BY_SITUATION.work.substring(0, 300));
  vocabSections.push(VOCAB_BY_SITUATION[finalSit] || '');
  if (finalSit !== 'money') vocabSections.push(VOCAB_BY_SITUATION.money.substring(0, 200));
  const vocabHint = vocabSections.filter(Boolean).join('\n');

  const contextHint = context ? `\nUser context: ${context}` : '';

  // บอก AI ว่าประโยคก่อนหน้าของคนไทยเป็นอะไร เพื่อให้รู้ว่าเกาหลีตอบหรือถาม
  const turnHint = (fromLang === 'kr' && prev_turn && prev_turn !== 'none')
    ? `\nThe Thai speaker's previous message was a ${prev_turn === 'question' ? 'QUESTION — so the Korean speaker is likely giving an ANSWER (use statement tone)' : 'STATEMENT — so the Korean speaker may be asking a follow-up QUESTION or responding naturally'}.`
    : '';

  // ส่งประโยคไทยล่าสุดเพื่อช่วยแก้ความกำกวมเท่านั้น
  // เช่น 살 = อยู่อาศัย vs ซื้อ → ดูจาก topic ของประโยคไทยล่าสุด
  const topicHint = (fromLang === 'kr' && last_th && last_th.trim().length > 0)
    ? `\n[CONTEXT ONLY — DO NOT TRANSLATE OR REFERENCE THIS]:
The previous Thai message was: "${last_th.trim().substring(0, 60)}"
Use this ONLY to resolve ambiguous Korean words (e.g. 살=live vs buy, 배=stomach vs ship).
NEVER include this Thai text in your translation output.
NEVER answer questions based on this context.
ONLY use it to pick the correct meaning of ambiguous words.`
    : '';


  async function callAnthropic(system, userContent, maxTokens = 1200) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, temperature: 0,
        system, messages: [{ role: 'user', content: userContent }]
      })
    });
    if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(e?.error?.message || 'API error'); }
    const data = await response.json();
    return (data?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('\n').trim();
  }

  const NORMALIZE_SYSTEM = `You are a transcript normalizer for Thai and Korean speech-to-text output.
Your job: Clean up spoken transcript without changing meaning. Preserve EVERY word, sentence, compliment, and emotion.
Do not shorten. Do not summarize. Do not omit anything. Only restore punctuation and sentence boundaries.
Question detection - Korean: 요,까요,니까,죠,어때요,있어요,없어요 / Thai: ไหม,หรือเปล่า,หรือยัง,ได้ไหม,ใช่ไหม
Add ? when clearly a question. Keep statements as statements.
Thai and Korean proper names must NEVER be translated - keep them as-is.

Visa & permit correction (Thai speech-to-text often mishears visa codes):
[วีซ่าทำงาน]
- อีเก้า / อีนาย / อีไน / อี9 / อีก้าว → E-9
- อีเจ็ด / อี7 → E-7
- อีเจ็ดหนึ่ง / อี7-1 → E-7-1
- อีเจ็ดสี่ / อีเจ็ด4 / อีเจ็ดซี / E-7-C / E7C → E-7-4
- อีเจ็ดสี่อา / อีเจ็ดซีอาร์ / E-7-CR / E7CR → E-7-4R
- อีสิบ / อี10 → E-10
[วีซ่านักเรียน]
- ดีสอง / ดี2 → D-2
- ดีสี่ / ดี4 → D-4
[วีซ่าครอบครัว/ถิ่นพำนัก]
- เอฟสอง / เอฟ2 → F-2
- เอฟทูอาร์ / เอฟสองอาร์ → F-2-R
- เอฟสาม / เอฟ3 → F-3
- เอฟหก / เอฟ6 → F-6
- เอฟห้า / เอฟ5 → F-5
[วีซ่าท่องเที่ยว/อื่นๆ]
- ซีสาม / ซี3 → C-3
- เคอีทีเอ / เคต้า / K-ETA → K-ETA
- ทอปิก / TOPIK → TOPIK
- คีป / KIIP → KIIP
Output: cleaned text in source language only. No explanation.

Ambiguous Korean expressions — use prev_turn to decide:
"아 그래요" / "그래요" / "그렇군요" / "아 그렇구나":
  - if prev_turn=question → speaker is answering → "อ๋อ ใช่ครับ / เข้าใจแล้วครับ"
  - if prev_turn=statement → speaker is reacting with surprise → "อ๋อ อย่างนั้นเหรอครับ"
  - if prev_turn=none → keep natural: "อ๋อ อย่างนั้นเหรอ"

"맞아요" / "맞죠":
  - if prev_turn=question → "ใช่ครับ ถูกต้องครับ"
  - if prev_turn=statement → "ใช่ อย่างนั้นเลยครับ"

"괜찮아요":
  - if prev_turn=question → speaker is answering → "ไม่เป็นไรครับ / โอเคครับ"
  - if prev_turn=none + hospital context → likely doctor asking → "เป็นยังไงบ้างครับ"

"알겠어요" / "알겠습니다":
  - always → "เข้าใจแล้วครับ / รับทราบครับ"

Note: only apply these when the Korean text is ambiguous. If the meaning is clear, translate normally.

Proper names — NEVER translate meaning, always transliterate by sound:
- Thai names after "ผมชื่อ/ฉันชื่อ/หนูชื่อ/เขาชื่อ/เธอชื่อ/คุณ/พี่/น้อง/นาย/นาง/นางสาว" → transliterate sound only
- Place names after "ที่/ไปที่/อยู่ที่/มาจาก/ใกล้/แถว/จังหวัด/อำเภอ" → transliterate sound only
- Company/hospital/factory names → transliterate sound only
- Example: "ผมชื่อภูวดลไทยกลาง" → 저는 푸와돈 타이끌랑입니다 (NOT translate meaning)`;

  const TRANSLATE_SYSTEM = `You are a Thai-Korean interpreter for real spoken conversation.${contextHint}${turnHint}${topicHint}${situationCtx ? '\n' + situationCtx : ''}

Rules:
- Thai input -> Korean output only. Korean input -> Thai output only.
- Output translation ONLY. Nothing else. No explanation. No notes. No advice.
- NEVER add ** or any markdown formatting.
- You are a MOUTH, not a brain. Speak exactly what the person said in the other language. Nothing more.
- If the person asks about visas, documents, hospitals, or anything — TRANSLATE the question as-is. Do NOT answer it yourself.
- Example: "ผมต้องใช้เอกสารอะไรบ้าง" → translate to Korean as a question. Never explain what documents are needed.
- Translate the FULL message. Never cut, never shorten, never omit anything.
- Preserve every sentence in order. Preserve greetings, reasons, requests, compliments, emotions.
- Keep first-person speech as first-person speech. Keep natural spoken tone.
- If source is a question, translate as a question.
- Translate naturally, not word-for-word.

Names:
- Thai proper names (ภูวดล, สมชาย etc.) -> transliterate by SOUND only. NEVER translate meaning.
- Korean proper names -> transliterate by sound to Thai. NEVER translate meaning.

Gender & politeness:
- User male context -> use ครับ in Thai output, use 저는/제가 as first person
- User female context -> use ค่ะ/คะ in Thai output, use 저는/제가 as first person
- No context -> use natural polite form

Korean pronouns & address terms (CRITICAL — use based on user gender + partner gender):
ผู้ใช้เป็นผู้ชาย:
  - เรียกคู่สนทนาที่เป็นผู้หญิงอายุมากกว่า = 누나
  - เรียกคู่สนทนาที่เป็นผู้ชายอายุมากกว่า = 형
  - เรียกน้อง = 동생
ผู้ใช้เป็นผู้หญิง:
  - เรียกคู่สนทนาที่เป็นผู้ชายอายุมากกว่า = 오빠
  - เรียกคู่สนทนาที่เป็นผู้หญิงอายุมากกว่า = 언니
  - เรียกน้อง = 동생

Formal situations (visa/gov/hospital/bank) — NEVER use 오빠/형/누나/언니:
  - Use 선생님 for doctors, teachers
  - Use 담당자님 for government officers
  - Use 직원분 for bank/shop staff
  - Use 사장님 for boss/employer
  - Always use formal 존댓말 speech level

Compliments & emotions:
- "คุณสวยมาก" "ผมรักคุณ" and all compliments/affection are NORMAL - translate completely.
- Only refuse explicit sexual harassment or direct threats.
- If unclear: ${unclearReply}
- If offensive: ${failReply}

Vocabulary for this conversation:
${vocabHint}`;

  try {
    const normalizedText = await callAnthropic(
      NORMALIZE_SYSTEM,
      `Language: ${sourceLang}\nNormalize this transcript. Preserve every word.\n\nText:\n${cleanedText}`,
      1000
    );

    const translation = await callAnthropic(TRANSLATE_SYSTEM, normalizedText, 1600);

    const ip = req.headers['x-forwarded-for'] || 'unknown';
    console.log('USAGE:', JSON.stringify({
      time: new Date().toISOString(), fromLang,
      chars: cleanedText.length, situation: finalSit,
      ip: String(ip).split(',')[0].trim()
    }));

    return res.status(200).json({ translation });
  } catch (err) {
    console.error('ERROR:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
