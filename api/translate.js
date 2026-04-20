export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    text,
    fromLang,
    context,
    user_gender,
    partner_gender,
  } = req.body || {};

  if (!text || !fromLang) {
    return res.status(400).json({ error: 'Missing params' });
  }

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server config error' });
  }

  const safeStr = (v, max = 500) =>
    String(v ?? '')
      .replace(/\u0000/g, '')
      .replace(/\r/g, '')
      .slice(0, max);

  const safeJson = (v, max = 500) => JSON.stringify(safeStr(v, max));

  const compact = (v) =>
    String(v ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\u00A0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  const containsThai = (s) => /[ก-๙]/.test(String(s || ''));
  const containsKorean = (s) => /[가-힣]/.test(String(s || ''));
  const englishOnlyish = (s) =>
    /^[a-zA-Z0-9\s.,!?'"():;/\\\-_[\]{}@#$%^&*+=<>|`~]+$/.test(String(s || '').trim());

  const looksLikeApiError = (s) =>
    /(error|invalid_request|authentication|overloaded|rate limit|bad request|method not allowed|server error|api)/i.test(
      String(s || '')
    );

  const cleanedText = compact(text);

  const lang = String(fromLang || '').toLowerCase();
  const isThai = ['th', 'thai'].includes(lang);
  const isKorean = ['kr', 'ko', 'korean'].includes(lang);

  if (!isThai && !isKorean) {
    return res.status(400).json({ error: 'Unsupported fromLang' });
  }

  const sourceLang = isThai ? 'Thai' : 'Korean';
  const targetLang = isThai ? 'Korean' : 'Thai';

  const unclearReply =
    targetLang === 'Korean'
      ? '잘 못 들었습니다. 다시 말씀해 주세요.'
      : 'ฟังไม่ชัด ช่วยพูดอีกครั้งได้ไหมคะ';

  const failReply =
    targetLang === 'Korean'
      ? '번역할 수 없습니다.'
      : 'ไม่สามารถแปลได้ค่ะ';

  function parseSelectedSituation(ctx = '') {
    const c = String(ctx || '');

    if (c.includes('คลินิกศัลยกรรม') || c.includes('ศัลยกรรมและความงาม') || c.includes('ศัลยกรรม')) return 'beauty';
    if (c.includes('โรงพยาบาล')) return 'hospital';
    if (c.includes('ที่ทำงาน')) return 'work';
    if (c.includes('วีซ่า') || c.includes('ราชการ')) return 'visa';
    if (c.includes('ธุรกรรมธนาคาร') || c.includes('ธนาคาร')) return 'bank';
    if (c.includes('ภาษี') || c.includes('ประกันสังคม') || c.includes('เรื่องเงิน')) return 'money';
    if (c.includes('ร้านอาหาร')) return 'food';
    if (c.includes('ช้อปปิ้ง')) return 'shop';
    if (c.includes('เดินทาง')) return 'travel';
    if (c.includes('ที่พัก')) return 'housing';
    if (c.includes('เหตุฉุกเฉิน') || c.includes('ฉุกเฉิน')) return 'emergency';

    return 'general';
  }

  function autoDetectSituation(t, fallback = 'general') {
    const s = String(t || '');

    if (/ศัลยกรรม|เสริมจมูก|ทำตา|โบทอก|ฟิลเลอร์|ดูดไขมัน|ทำนม|จัดฟัน|성형|쌍꺼풀|코 수술|보톡스|필러|지방흡입|가슴 수술/.test(s)) {
      return 'beauty';
    }
    if (/ปวด|หมอ|ยา|โรงพยาบาล|ไข้|เจ็บ|คลินิก|ตรวจเลือด|เอ็กซเรย์|อัลตราซาวด์|의사|병원|약|증상|진료|검사|수술/.test(s)) {
      return 'hospital';
    }
    if (/วีซ่า|กาม่า|บัตรต่างด้าว|ตม|พาสปอร์ต|ต่อวีซ่า|ยื่นวีซ่า|출입국|비자|여권|외국인등록/.test(s)) {
      return 'visa';
    }
    if (/ธนาคาร|เปิดบัญชี|ปิดบัญชี|โอนเงิน|ฝากเงิน|ถอนเงิน|บัญชีโดนล็อค|ลืมรหัส|은행|계좌|송금|입금|출금|통장/.test(s)) {
      return 'bank';
    }
    if (/กุกมิน|เทจิก|퇴직금|국민연금|ประกัน|ภาษี|คืนภาษี|고용보험|건강보험|세금/.test(s)) {
      return 'money';
    }
    if (/เถ้าแก่|ลาออก|เงินเดือน|สัญญา|โรงงาน|โอที|งาน|사장|공장|월급|계약|퇴사|야근|출근|퇴근/.test(s)) {
      return 'work';
    }
    if (/택시|지하철|버스|หลงทาง|รถไฟ|แท็กซี่|รถเมล์|ทางไหน|환승|역|길을 잃/.test(s)) {
      return 'travel';
    }
    if (/ร้านอาหาร|เมนู|สั่งอาหาร|เผ็ด|ไม่เผ็ด|คิดเงิน|식당|주문|메뉴|포장|계산/.test(s)) {
      return 'food';
    }
    if (/ช้อป|ลดหน่อย|ราคาเท่าไหร่|ขอถุง|ใบเสร็จ|얼마예요|깎아|영수증|봉투/.test(s)) {
      return 'shop';
    }
    if (/ค่าเช่า|มัดจำ|เจ้าของบ้าน|ย้ายบ้าน|น้ำไม่ไหล|ไฟดับ|월세|보증금|집주인|이사|난방/.test(s)) {
      return 'housing';
    }
    if (/ช่วยด้วย|เรียกรถพยาบาล|ตำรวจ|ของหาย|โดนโกง|응급|구급차|경찰|사기|잃어버렸/.test(s)) {
      return 'emergency';
    }

    return fallback;
  }

  const selectedSit = parseSelectedSituation(context);
  const detectedSit = autoDetectSituation(cleanedText, selectedSit);
  const finalSit = selectedSit !== 'general' ? selectedSit : detectedSit;

  const VOCAB_CORE = `
เถ้าแก่/ซาจัง/ซาจังนิม/นายจ้าง=사장님 | หัวหน้า/พันจัง/บันจัง=반장님
โรงงาน/คงจัง/กงจัง=공장 | เงินเดือน=월급 | สลิปเงินเดือน=급여명세서
กินข้าวหรือยัง=밥 먹었어요? | กินข้าวแล้ว=밥 먹었어요
รอแป๊บ=잠깐만요 | ไม่เข้าใจ=이해 못 했어요 | พูดช้าๆ=천천히 말해 주세요
พูดอีกที=다시 말해 주세요 | ได้=돼요 | ไม่ได้=안 돼요 | ไม่เป็นไร=괜찮아요
`;

  const SITUATION_CONTEXT = {
    hospital: 'Situation: hospital/clinic. Focus on medical vocabulary only. Do not answer as doctor. Translate only.',
    work: 'Situation: workplace/factory. Focus on labor and workplace vocabulary only. Translate only.',
    visa: 'Situation: immigration office / paperwork. Focus on visa and document vocabulary only. Translate only.',
    bank: 'Situation: bank / remittance / account service. Focus on banking vocabulary only. Translate only.',
    money: 'Situation: money / tax / insurance / pension. Focus on financial vocabulary only. Translate only.',
    food: 'Situation: restaurant. Focus on food and ordering vocabulary only. Translate only.',
    shop: 'Situation: shopping / retail. Focus on shopping vocabulary only. Translate only.',
    travel: 'Situation: transportation / directions. Focus on travel vocabulary only. Translate only.',
    housing: 'Situation: housing / rental. Focus on housing vocabulary only. Translate only.',
    emergency: 'Situation: emergency. Focus on urgent help vocabulary only. Translate only.',
    beauty: 'Situation: beauty clinic / plastic surgery / dental cosmetics. Focus on beauty and surgery vocabulary only. Translate only.',
    general: '',
  };

  const VOCAB_BY_SITUATION = {
    work: `
[งาน/โรงงาน]
ลาออก=퇴사하다 | ไล่ออก=해고되다 | เปลี่ยนงาน/ย้ายงาน=사업장을 변경하다
สัญญาจ้าง=근로계약서 | หมดสัญญา=계약 만료 | ต่อสัญญา=계약 연장
โอที/ค่าโอที=야근/야근수당 | วันหยุด=휴무일 | ลาป่วย=병가 | ลาพักร้อน=연차
มาสาย=지각하다 | ขาดงาน=결근하다 | เข้างาน=출근하다 | เลิกงาน=퇴근하다
เงินเดือนสุทธิ=실수령액 | เงินเดือนก่อนหัก=세전 월급 | หักเงิน=공제
โดนหักเงิน=돈이 공제됐다 | เงินเดือนค้าง=임금 체불
`,
    visa: `
[วีซ่า/ราชการ]
บัตรต่างด้าว/ใบกาม่า/กาม่า/บัตรกาม่า=외국인등록증 | พาสปอร์ต=여권
ตม/ซุลลิก/ซุลลิกซา=출입국관리사무소
ต่อวีซ่า=비자 연장 | เปลี่ยนวีซ่า=비자 변경 | ยื่นวีซ่า=비자 신청
เอกสาร=서류 | ยื่นเอกสาร=서류 제출 | นัด/จองคิว=예약하다
หมดวีซ่า=비자 만료 | เกินวีซ่า=체류기간 초과
E-9/อีเก้า/อีนาย=E-9 비자 | E-7-4/อีเจ็ดสี่=E-7-4 비자
E-7-4R=E-7-4R 비자 | F-2-R/เอฟทูอาร์=F-2-R 비자 | F-6/เอฟหก=F-6 비자
TOPIK=TOPIK | KIIP=KIIP
`,
    money: `
[เงิน/ภาษี/ประกัน]
กุ๊กมิน/กุกมิน/กูมิน/เงินกุกมิน=국민연금
เงินกุกมินสะสม=국민연금 적립금 | ขอเงินกุกมินคืน=국민연금 환급 신청
เทจิก/แทจิก/เตจิก/เงินเทจิก=퇴직금
ประกันสังคม=사회보험/4대보험 | ประกันสุขภาพ=건강보험
ประกันอุบัติเหตุ=산재보험 | ประกันการจ้างงาน=고용보험
ภาษี=세금 | ภาษีเงินได้=소득세 | คืนภาษี=세금 환급
`,
    hospital: `
[โรงพยาบาล/ร้านขายยา]
โรงพยาบาล=병원 | คลินิก=의원 | ร้านขายยา=약국 | หมอ=의사 | พยาบาล=간호사
ปวดหัว=머리가 아프다 | ปวดท้อง=배가 아프다 | ปวดไหล่=어깨가 아프다
เวียนหัว=어지럽다 | มีไข้=열이 나다 | ไอ=기침하다
น้ำมูก=콧물 | คลื่นไส้=메스꺼움 | อาเจียน=구토 | ท้องเสีย=설사 | ท้องผูก=변비
ยาแก้ปวด=진통제 | ยาแก้อักเสบ=소염제 | ยาฆ่าเชื้อ=항생제
ใบสั่งยา=처방전 | หลังอาหาร=식후 | ก่อนอาหาร=식전
ตรวจเลือด=피검사 | ตรวจปัสสาวะ=소변검사 | เอ็กซเรย์=엑스레이
ซีทีสแกน=CT | เอ็มอาร์ไอ=MRI | อัลตราซาวด์=초음파 | ส่องกล้อง=내시경
ติดเชื้อ=감염되었습니다 | ต้องผ่าตัด=수술이 필요합니다
`,
    bank: `
[ธนาคาร]
ธนาคาร=은행 | เปิดบัญชี=계좌 개설 | ปิดบัญชี=계좌 해지
สมุดบัญชี=통장 | บัตรเอทีเอ็ม=체크카드 | บัตรเครดิต=신용카드
โอนเงิน=송금하다 | โอนเงินกลับไทย=해외송금 | ฝากเงิน=입금하다 | ถอนเงิน=출금하다
ยอดเงิน/ยอดคงเหลือ=잔액 | ค่าธรรมเนียมโอน=송금 수수료
`,
    food: `
[ร้านอาหาร]
ร้านอาหาร/ร้านข้าว=식당 | เมนู=메뉴 | สั่งอาหาร=주문하다
เอาอันนี้=이걸로 주세요 | ห่อกลับ/เอากลับบ้าน=포장해 주세요
ขอน้ำ=물 주세요 | ไม่เผ็ด=안 맵게 | เผ็ดน้อย=덜 맵게
อร่อย=맛있어요 | คิดเงิน=계산해 주세요
`,
    shop: `
[ช้อปปิ้ง]
ราคาเท่าไหร่=얼마예요 | แพงไป=너무 비싸요 | ลดหน่อย=좀 깎아 주세요
ขอถุง=봉투 주세요 | ขอใบเสร็จ=영수증 주세요
`,
    travel: `
[เดินทาง]
รถเมล์/บัส/บาซือ=버스 | รถไฟฟ้า/ซับเว/ซับเวย์/จีฮาชอล=지하철
แท็กซี่/แทกซี่=택시 | สถานี=역 | เรียกแท็กซี่=택시 부르다
ไปทางไหน=어디로 가요 | หลงทาง=길을 잃었어요 | จอดตรงนี้=여기서 세워 주세요
ซ้าย=왼쪽 | ขวา=오른쪽 | ตรงไป=직진 | เลี้ยวซ้าย=좌회전 | เลี้ยวขวา=우회전
ขึ้นรถ/นั่ง=타다 | ลงรถ=내리다 | เปลี่ยนสาย=환승하다
`,
    housing: `
[ที่พัก]
บ้านเช่า/ห้องเช่า=월세방/원룸 | ค่าเช่า=월세 | เงินมัดจำ=보증금
เจ้าของบ้าน=집주인 | ย้ายบ้าน=이사하다 | ย้ายออก=이사 나가다
น้ำไม่ไหล=물이 안 나와요 | ไฟดับ=전기가 나갔어요 | ฮีตเตอร์เสีย=난방 고장
`,
    emergency: `
[ฉุกเฉิน]
ช่วยด้วย=도와 주세요 | เจ็บมาก=많이 아파요 | เรียกรถพยาบาล=구급차 불러 주세요
โทรตำรวจ=경찰에 전화하다 | ของหาย=잃어버렸어요 | โดนโกง=사기당했어요
`,
    beauty: `
[ศัลยกรรม/ความงาม]
ศัลยกรรม=성형수술 | ทำตาสองชั้น=쌍꺼풀 수술
เย็บไม่กรีด=매몰법 | กรีดตา=절개법 | เปิดหัวตา=앞트임 | เปิดหางตา=뒤트임
เสริมจมูก=코 수술 | ซิลิโคน=실리콘 | กระดูกตัวเอง=자가연골
ฟิลเลอร์=필러 | โบทอก=보톡스 | เลเซอร์=레이저 | ยกกระชับ=리프팅
เสริมหน้าอก/ทำนม=가슴 수술 | ดูดไขมัน=지방흡입
จัดฟัน=치아교정 | รากฟันเทียม=임플란트 | ฟอกสีฟัน=치아미백
ยาชา=마취 | ดมยาสลบ=전신마취 | ห้องพักฟื้น=회복실
ผลข้างเคียง=부작용 | แผลเป็น=흉터 | แก้จมูก/แก้งาน=재수술
อยากปรึกษา=상담 받고 싶어요 | ราคาเท่าไหร่=비용이 얼마예요
`,
    general: '',
  };

  const vocabSections = [VOCAB_CORE];
  if (VOCAB_BY_SITUATION[finalSit]) vocabSections.push(VOCAB_BY_SITUATION[finalSit]);
  const vocabHint = vocabSections.filter(Boolean).join('\n');

  const contextHint = context ? `\n[USER CONTEXT]\n${safeJson(context, 300)}` : '';

  let genderInstruction = '';
  if (isKorean) {
    if (partner_gender === 'female') {
      genderInstruction = `
[GENDER RULE]
The Korean speaker is FEMALE.
Thai output should sound naturally female.
Use female Thai endings naturally.`;
    } else if (partner_gender === 'male') {
      genderInstruction = `
[GENDER RULE]
The Korean speaker is MALE.
Thai output should sound naturally male.
Use male Thai endings naturally.`;
    }
  } else {
    if (user_gender === 'male') {
      genderInstruction = `
[GENDER RULE]
The Thai speaker is MALE.
Use natural respectful Korean for a male speaker.`;
    } else if (user_gender === 'female') {
      genderInstruction = `
[GENDER RULE]
The Thai speaker is FEMALE.
Use natural respectful Korean for a female speaker.`;
    }
  }

  async function callAnthropic(system, userContent, maxTokens = 1200) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!response.ok) {
      const e = await response.json().catch(() => ({}));
      throw new Error(e?.error?.message || 'API error');
    }

    const data = await response.json();
    return (data?.content || [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }

  const NORMALIZE_SYSTEM = `You are a transcript normalizer for Thai and Korean speech-to-text output.
Your job: clean up spoken transcript without changing meaning.
Do not shorten. Do not summarize. Do not omit anything.
Only restore punctuation, spacing, and sentence boundaries.
Keep Thai and Korean proper names as-is.
Output cleaned text in source language only. No explanation.`;

  const TRANSLATE_SYSTEM = `You are a professional Thai-Korean interpreter.

CORE RULE:
Translate ONLY the current sentence.
Do NOT answer.
Do NOT continue the conversation.
Do NOT act as doctor, staff, seller, clerk, or assistant.
Do NOT rewrite the sentence as a reply.
Do NOT switch speaker roles.
Do NOT infer hidden intentions beyond the current sentence.

OUTPUT RULES:
- Thai → Korean only. Korean → Thai only.
- Output translation ONLY.
- No explanation. No notes. No markdown.
- Preserve greetings, politeness, emotion, and full meaning.
- Questions must stay questions.
- Statements must stay statements.
- Requests must stay requests.
- Never answer on behalf of either side.

THAI RULES:
- ผม/ฉัน/หนู/เรา + อยาก/ขอ/ต้องการ/สอบถาม/อยากรู้ = the speaker wants/asks.
- Do NOT turn "ผมอยากสอบถาม..." into a service reply.
- "ช่วย...ได้ไหม" must stay a request, not become an answer.
- In structures like "อยากให้ + PERSON + VERB", PERSON usually performs the verb.

KOREAN RULES:
- Translate Korean as spoken. Do not expand it into a role-play reply.
- Short Korean replies may be ambiguous. Choose the most neutral meaning from the current sentence only.
- Do not force extra interpretation from previous context.
- "아 그래요 / 아 그렇군요" should usually sound like realizing / acknowledging, not simple confirmation.

CRITICAL OVERRIDES:
- Thai requests like:
  "ผมอยากสอบถาม..."
  "ผมอยากรู้..."
  "ช่วยแนะนำผมได้ไหม..."
  "ช่วยอธิบายให้ผมหน่อยได้ไหม..."
  must be translated from the speaker's point of view only.
  NEVER turn them into:
  "궁금하신 거군요"
  "도와드릴 수 있습니다"
  "어떤 부분을 알고 싶으신가요"

- Korean reactions like:
  "아 그래요"
  "아 그렇군요"
  should usually be translated like:
  "อ๋อ อย่างนั้นเหรอครับ/ค่ะ"
  "อ๋อ เข้าใจแล้วครับ/ค่ะ"
  not as:
  "ใช่ครับ/ค่ะ"
  unless the sentence itself clearly means confirmation.

SAFETY:
If the sentence is unclear, use: ${unclearReply}
If explicit sexual harassment or violent threat only: ${failReply}

${contextHint}
${SITUATION_CONTEXT[finalSit] ? '\n' + SITUATION_CONTEXT[finalSit] : ''}
${genderInstruction}

Vocabulary:
${vocabHint}
`;

  function validateTranslation(output) {
    const out = compact(output || '');

    if (!out) return unclearReply;

    if (out.length > 25 && englishOnlyish(out) && looksLikeApiError(out)) {
      return unclearReply;
    }

    if (out.length > 40 && englishOnlyish(out)) {
      return unclearReply;
    }

    if (isThai) {
      if (out.length > 8 && !containsKorean(out)) {
        return unclearReply;
      }
    }

    if (isKorean) {
      if (out.length > 8 && !containsThai(out)) {
        return unclearReply;
      }
    }

    return out;
  }

  try {
    const normalizedText = await callAnthropic(
      NORMALIZE_SYSTEM,
      `Language: ${sourceLang}\nNormalize this transcript.\n\nText:\n${cleanedText}`,
      800
    );

    const rawTranslation = await callAnthropic(TRANSLATE_SYSTEM, normalizedText, 1200);
    const translation = validateTranslation(rawTranslation);

    const ip = req.headers['x-forwarded-for'] || 'unknown';
    const cleanIP = String(ip).split(',')[0].trim();

    console.log(
      'USAGE:',
      JSON.stringify({
        time: new Date().toISOString(),
        fromLang: lang,
        chars: cleanedText.length,
        selectedSituation: selectedSit,
        detectedSituation: detectedSit,
        finalSituation: finalSit,
        ip: cleanIP,
      })
    );

    const sheetURL = process.env.SHEET_WEBHOOK_URL;
    if (sheetURL) {
      const KEYWORD_MAP = {
        กุกมิน: 'ประกัน/กุกมิน',
        กุ๊กมิน: 'ประกัน/กุกมิน',
        เทจิก: 'เทจิก/ออกงาน',
        แทจิก: 'เทจิก/ออกงาน',
        ลาออก: 'เทจิก/ออกงาน',
        ไล่ออก: 'เทจิก/ออกงาน',
        วีซ่า: 'วีซ่า',
        'E-9': 'วีซ่า E-9',
        'E-7-4': 'วีซ่า E-7-4',
        กาม่า: 'บัตรต่างด้าว',
        พาสปอร์ต: 'พาสปอร์ต',
        เงินเดือน: 'เงินเดือน',
        โอที: 'โอที',
        โรงพยาบาล: 'โรงพยาบาล',
        หมอ: 'หมอ',
        ยา: 'ยา',
        ปวด: 'อาการปวด',
        ไข้: 'ไข้',
        โอนเงิน: 'โอนเงิน',
        ธนาคาร: 'ธนาคาร',
        ภาษี: 'ภาษี',
        ประกัน: 'ประกัน',
        เถ้าแก่: 'นายจ้าง',
        สัญญา: 'สัญญาจ้าง',
        หลงทาง: 'เดินทาง',
        แท็กซี่: 'แท็กซี่',
        ช่วยด้วย: 'ฉุกเฉิน',
        เรียกรถ: 'ฉุกเฉิน',
        ศัลยกรรม: 'ศัลยกรรม',
        เสริมจมูก: 'ศัลยกรรมจมูก',
        ทำตา: 'ศัลยกรรมตา',
        โบทอก: 'ความงาม',
        ฟิลเลอร์: 'ความงาม',
      };

      const detectedKeywords = [];
      for (const [kw, label] of Object.entries(KEYWORD_MAP)) {
        if (cleanedText.includes(kw)) detectedKeywords.push(label);
      }

      fetch(sheetURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromLang: lang,
          situation: finalSit,
          chars: cleanedText.length,
          keywords: detectedKeywords.slice(0, 5).join(', '),
          orig: cleanedText.substring(0, 60),
          trans: translation.substring(0, 60),
          userGender: user_gender || '',
          partnerGender: partner_gender || '',
          ip: cleanIP,
        }),
      }).catch(() => {});
    }

    return res.status(200).json({ translation });
  } catch (err) {
    console.error('ERROR:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
