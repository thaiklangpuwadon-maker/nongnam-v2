export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, fromLang, context, prev_turn, last_th, user_gender, partner_gender } = req.body || {};
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

  const containsThai = (s) => /[ก-๙]/.test(String(s || ''));
  const containsKorean = (s) => /[가-힣]/.test(String(s || ''));
  const englishOnlyish = (s) =>
    /^[a-zA-Z0-9\s.,!?'"():;/\\\-_[\]{}@#$%^&*+=<>|`~]+$/.test(String(s || '').trim());

  const isMetaReply = (s) =>
    /(저는 통역사입니다|질문에 답변할 수 없습니다|질문에 답변해 드릴 수 없습니다|저는 ai입니다|저는 인공지능입니다|i am an interpreter|i cannot answer|i cannot help|unable to respond|i am ai|i am an ai)/i.test(
      String(s || '')
    );

  const looksLikeApiError = (s) =>
    /(error|invalid_request|authentication|overloaded|rate limit|bad request|method not allowed|server error|api)/i.test(
      String(s || '')
    );

  const VOCAB_CORE = `
เถ้าแก่/ซาจัง/ซาจังนิม/นายจ้าง=사장님 | หัวหน้า/พันจัง/บันจัง=반장님
โรงงาน/คงจัง/กงจัง=공장 | เงินเดือน=월급 | สลิปเงินเดือน=급여명세서
กินข้าวหรือยัง=밥 먹었어요? | กินข้าวแล้ว=밥 먹었어요
รอแป๊บ=잠깐만요 | ไม่เข้าใจ=이해 못 했어요 | พูดช้าๆ=천천히 말해 주세요
พูดอีกที=다시 말해 주세요 | ได้=돼요 | ไม่ได้=안 돼요 | ไม่เป็นไร=괜찮아요`;

  const SITUATION_CONTEXT = {
    hospital: 'Situation: hospital/clinic. The THAI USER is the PATIENT. The Korean speaker is the doctor/nurse. Thai person came to receive medical care, NOT to provide it. Never translate Thai speaker as a medical professional.',
    work: 'Situation: workplace/factory. Focus on labor and work vocabulary.',
    visa: 'Situation: immigration office. Focus on visa and legal vocabulary.',
    bank: 'Situation: bank. Focus on banking and money transfer vocabulary.',
    food: 'Situation: restaurant. Focus on food ordering vocabulary.',
    shop: 'Situation: shopping. Focus on retail vocabulary.',
    travel: 'Situation: travel/directions. Focus on transportation vocabulary.',
    housing: 'Situation: housing/rental. Focus on accommodation vocabulary.',
    emergency: 'Situation: emergency. Prioritize urgent help vocabulary.',
    money: 'Situation: insurance/tax. Focus on financial vocabulary.',
    beauty: 'Situation: beauty clinic/plastic surgery. Focus on cosmetic procedure vocabulary.',
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
น้ำมูก=콧물 | คลื่นไส้=메스꺼움 | อาเจียน=구토 | ท้องเสีย=설사 | ท้องผูก=변비
คอ=목 | เอว=허리 | มือ=손 | เท้า=발
ยาแก้ปวด=진통제 | ยาแก้ปวดหัว=두통약 | ยาแก้อักเสบ=소염제
ยาฆ่าเชื้อ=항생제 | ใบสั่งยา=처방전
วันละ 3 ครั้ง=하루 3번 | หลังอาหาร=식후 | ก่อนอาหาร=식전
กินยา=약을 먹다 | ฉีดยา=주사 맞다 | นัดหมอ=진료 예약
ตรวจเลือด=피검사 | ตรวจปัสสาวะ=소변검사 | เอ็กซเรย์=엑스레이
ซีทีสแกน=CT | เอ็มอาร์ไอ=MRI | อัลตราซาวด์=초음파 | ส่องกล้อง=내시경
ติดเชื้อ=감염되었습니다 | ต้องผ่าตัด=수술이 필요합니다
รอดูอาการ=경과를 지켜봅시다 | ปกติดี=이상 없습니다
หวัด=감기 | ไข้หวัดใหญ่=독감 | กระเพาะอักเสบ=위염
อาหารเป็นพิษ=식중독 | ภูมิแพ้=알레르기
เบาหวาน=당뇨병 | ความดันสูง=고혈압
ห้องฉุกเฉิน=응급실 | ห้องผ่าตัด=수술실 | เคาน์เตอร์รับบัตร=접수처
หมดสติ=의식 없음 | หยุดหายใจ=호흡 정지 | โทร 119=119`,
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
ขึ้นรถ/นั่ง=타다/탑니다 | ลงรถ=내리다 | เปลี่ยนสาย=환승하다`,
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
    beauty: `
[ศัลยกรรม/ความงาม]
ศัลยกรรม=성형수술 | ทำตาสองชั้น/ซองกาพุล=쌍꺼풀 수술
เย็บไม่กรีด=매몰법 | กรีดตา=절개법 | เปิดหัวตา=앞트임 | เปิดหางตา=뒤트임
เสริมจมูก/โคซูซูล=코 수술 | ซิลิโคน=실리콘 | กระดูกตัวเอง=자가연골
สันจมูก=콧대 | ปลายจมูก=코끝
ฟิลเลอร์ปาก=입술 필러 | ยกมุมปาก=입꼬리 수술
ศัลยกรรมโครงหน้า=윤곽수술 | ลดโหนกแก้ม=광대 축소 | กรามเหลี่ยม=사각턱
หน้าเรียว=V라인 | ศัลยกรรมคาง=턱 수술
เสริมหน้าอก/ทำนม=가슴 수술 | ดูดไขมัน=지방흡입
โบทอก/Botox=보톡스 | ฟิลเลอร์/Filler=필러 | เลเซอร์=레이저 | ยกกระชับ=리프팅
ผิวขาว=미백 | ลดริ้วรอย=주름 개선
จัดฟัน=치아교정 | รากฟันเทียม/อิมแพลน=임플란트 | ฟอกสีฟัน=치아미백 | ขูดหินปูน/สเกลลิ่ง=스케일링
ยาชา=마취 | ดมยาสลบ=전신마취 | ห้องพักฟื้น=회복실 | แอดมิด=입원
ผลข้างเคียง=부작용 | แผลเป็น=흉터 | แก้จมูก/แก้งาน=재수술
อยากปรึกษา=상담 받고 싶어요 | ราคาเท่าไหร่=비용이 얼마예요
ใช้เวลาฟื้นตัวกี่วัน=회복 기간은 얼마나 걸려요`,
    general: ''
  };

  const sitKey = context && context.includes('โรงพยาบาล') ? 'hospital'
    : context && context.includes('ทำงาน') ? 'work'
    : context && context.includes('ราชการ') ? 'visa'
    : context && context.includes('เงิน') ? 'money'
    : context && context.includes('ธนาคาร') ? 'bank'
    : context && context.includes('ร้านอาหาร') ? 'food'
    : context && context.includes('ช้อปปิ้ง') ? 'shop'
    : context && context.includes('เดินทาง') ? 'travel'
    : context && context.includes('ที่พัก') ? 'housing'
    : context && context.includes('ฉุกเฉิน') ? 'emergency'
    : context && (context.includes('ศัลยกรรม') || context.includes('ความงาม')) ? 'beauty'
    : 'general';

  const autoDetect = (t) => {
    if (/ปวด|หมอ|ยา|โรงพยาบาล|ไข้|เจ็บ|คลินิก/.test(t)) return 'hospital';
    if (/เถ้าแก่|ลาออก|เงินเดือน|สัญญา|โรงงาน|โอที/.test(t)) return 'work';
    if (/วีซ่า|กาม่า|ตม|พาสปอร์ต|ต่อวีซ่า/.test(t)) return 'visa';
    if (/ธนาคาร|โอนเงิน|กุกมิน|เทจิก|ประกัน/.test(t)) return 'money';
    if (/택시|지하철|버스|หลงทาง|รถไฟ/.test(t)) return 'travel';
    if (/아프|병원|의사|약|증상|진료/.test(t)) return 'hospital';
    if (/사장|공장|월급|계약|퇴사|야근/.test(t)) return 'work';
    if (/비자|여권|외국인등록|출입국/.test(t)) return 'visa';
    if (/은행|송금|계좌|국민연금|퇴직금/.test(t)) return 'money';
    if (/택시|지하철|버스|환승/.test(t)) return 'travel';
    if (/ศัลยกรรม|เสริมจมูก|ทำตา|โบทอก|ฟิลเลอร์|ดูดไขมัน|ทำนม|จัดฟัน|성형|쌍꺼풀|코 수술|보톡스/.test(t)) return 'beauty';
    return sitKey;
  };

  const finalSit = sitKey !== 'general' ? sitKey : autoDetect(cleanedText);

  const situationCtx = SITUATION_CONTEXT[finalSit] || '';
  const vocabSections = [VOCAB_CORE];
  if (finalSit !== 'work') vocabSections.push(VOCAB_BY_SITUATION.work.substring(0, 300));
  vocabSections.push(VOCAB_BY_SITUATION[finalSit] || '');
  if (finalSit !== 'money') vocabSections.push(VOCAB_BY_SITUATION.money.substring(0, 200));
  const vocabHint = vocabSections.filter(Boolean).join('\n');

  const contextHint = context ? `\nUser context: ${context}` : '';

  let genderInstruction = '';
  if (fromLang === 'kr' || fromLang === 'ko') {
    if (partner_gender === 'female') {
      genderInstruction = `\n[GENDER RULE - MANDATORY]: The Korean speaker is FEMALE.
EVERY SINGLE SENTENCE in Thai output MUST use female speech.
ALLOWED: ดิฉัน, หนู, เธอ, ค่ะ, นะคะ, คะ
FORBIDDEN in EVERY sentence: ผม, ครับ, นะครับ
Example: 저는 민수진입니다. 만나서 반갑습니다. → "ดิฉันชื่อมินซูจินค่ะ ยินดีที่ได้รู้จักค่ะ"`;
    } else if (partner_gender === 'male') {
      genderInstruction = `\n[GENDER RULE - MANDATORY]: The Korean speaker is MALE.
EVERY SINGLE SENTENCE in Thai output MUST use male speech.
ALLOWED: ผม, เขา, ครับ, นะครับ
FORBIDDEN in EVERY sentence: ดิฉัน, ค่ะ, นะคะ
Example: 저는 민준입니다. 만나서 반갑습니다. → "ผมชื่อมินจุนครับ ยินดีที่ได้รู้จักครับ"`;
    }
  } else {
    if (user_gender === 'male') {
      genderInstruction = `\n[GENDER RULE - MANDATORY]: The Thai speaker is MALE. Use formal 합쇼체 Korean.`;
    } else if (user_gender === 'female') {
      genderInstruction = `\n[GENDER RULE - MANDATORY]: The Thai speaker is FEMALE. Use formal 합쇼체 Korean.`;
    }
  }

  const turnHint = ((fromLang === 'kr' || fromLang === 'ko') && prev_turn && prev_turn !== 'none')
    ? `\nThe Thai speaker's previous message was a ${prev_turn === 'question' ? 'QUESTION — so the Korean speaker is likely giving an ANSWER (use statement tone)' : 'STATEMENT — so the Korean speaker may be asking a follow-up QUESTION or responding naturally'}.`
    : '';

  const topicHint = ((fromLang === 'kr' || fromLang === 'ko') && last_th && last_th.trim().length > 0)
    ? `\n[CONTEXT ONLY — DO NOT TRANSLATE OR REFERENCE THIS]:
The previous Thai message was: "${last_th.trim().substring(0, 60)}"
Use this ONLY to resolve ambiguous Korean words.
NEVER include this Thai text in your translation output.`
    : '';

  async function callAnthropic(system, userContent, maxTokens = 1200) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: userContent }]
      })
    });
    if (!response.ok) {
      const e = await response.json().catch(() => ({}));
      throw new Error(e?.error?.message || 'API error');
    }
    const data = await response.json();
    return (data?.content || [])
      .filter(b => b?.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
  }

  const NORMALIZE_SYSTEM = `You are a transcript normalizer for Thai and Korean speech-to-text output.
Your job: Clean up spoken transcript without changing meaning. Preserve EVERY word, sentence, compliment, and emotion.
Do not shorten. Do not summarize. Do not omit anything. Only restore punctuation and sentence boundaries.
Question detection — Thai (ลงท้ายด้วยคำเหล่านี้ = คำถามเสมอ → ใส่ ? ท้ายประโยค):
ไหม/ไหมครับ/ไหมคะ/มั้ย/มั้ยครับ/มั้ยคะ = ~요?
หรือเปล่า/หรือเปล่าครับ/หรือเปล่าคะ/ป่าว = ~요?
หรือไม่/หรือไม่ครับ/หรือไม่คะ = ~습니까?
เหรอ/หรอ/เหรอครับ/เหรอคะ = ~요?
ปะ/ปะครับ/ปะคะ = ~ㄹ래요?
อะ/อ่ะ (ลงท้าย) = ~요?
WH-questions: อะไร=뭐 ทำไม=왜 ที่ไหน=어디 เมื่อไหร่=언제 กี่โมง=몇 시 เท่าไหร่=얼마 ยังไง=어떻게 ใคร=누구 แบบไหน=어떤

Question detection — Korean (ลงท้ายด้วย = คำถามเสมอ):
요? / 까요? / 니까? / 죠? / 나요? / 래요? / 어요? / 어때요? / 있어요? / 없어요?

Add ? when clearly a question. Keep statements as statements.
Thai and Korean proper names must NEVER be translated - keep them as-is.

CRITICAL - Word spacing fix for Thai speech-to-text:
Thai speech-to-text often produces words WITHOUT spaces. You MUST add proper spaces.
Common patterns to fix:
- "สวัสดีครับคุณหมอ" → "สวัสดีครับ คุณหมอ"
- "ครับผม" at word boundary → "ครับ ผม"
- Titles: คุณหมอ คุณครู คุณพยาบাল นายจ้าง เถ้าแก่ → keep as one unit
- NEVER split: คุณหมอ ร้านขายยา โรงพยาบาล สวัสดี ขอบคุณ

CRITICAL - Role disambiguation:
- "สวัสดีครับคุณหมอผมมาตรวจ" → speaker is PATIENT visiting doctor, NOT doctor themselves
- "ผมมาหาหมอ" = "I came to see the doctor" NOT "I am the doctor"
- "มาตรวจร่างกาย" = "came for a checkup" — the speaker is the PATIENT
- If ambiguous, assume speaker is the non-professional (patient/worker/customer)

ROLE EXAMPLES - CRITICAL:
Thai: "สวัสดีครับคุณหมอ ผมมาตรวจร่างกายประจำปีครับ"
= Speaker is PATIENT greeting the doctor → Korean: 안녕하세요. 저는 연간 건강검진을 받으러 왔습니다.
NOT: 저는 의사입니다 ← WRONG

Thai: "สวัสดีครับเถ้าแก่ ผมอยากลาออกครับ"
= Speaker is WORKER talking to boss → Korean: 안녕하세요, 사장님. 저는 퇴사하고 싶습니다.

Thai: "สวัสดีครับพนักงาน ผมอยากเปิดบัญชีครับ"
= Speaker is CUSTOMER at bank → Korean: 안녕하세요. 계좌를 개설하고 싶습니다.

Output: cleaned text in source language only. No explanation.`;

  const TRANSLATE_SYSTEM = `You are a professional Thai-Korean interpreter. You are a PIPE between two people. Sound goes in, translation comes out. Nothing else.

SPEAKER INTENT RULE (Thai):
- ผม/ฉัน/หนู/เรา + อยาก/ขอ/ต้องการ/สอบถาม/อยากรู้ = ตัวผู้พูดเองเป็นคนขอ → แปลเป็นประโยคขอในมุมผู้พูด
- อยาก/ขอ/ต้องการ (ไม่มีสรรพนาม) = ตัวผู้พูดเองเป็นคนขอ → แปลเป็นประโยคขอในมุมผู้พูด
- เพื่อน/เขา/เธอ/น้อง/พี่ (ชื่อคนอื่น) + อยาก = คนอื่นเป็นคนขอ ไม่ใช่ผู้พูด
- คุณ + อยาก/ต้องการ = ถามอีกฝ่ายว่าต้องการไหม

ตัวอย่าง:
"ผมอยากสอบถามเรื่องรถ" → 자동차에 대해 문의하고 싶습니다
"ผมอยากสอบถาม ช่วยแนะนำได้ไหมครับ" → 문의드리고 싶은데요, 도와주실 수 있나요?
"เพื่อนผมอยากสอบถาม" → 제 친구가 문의하고 싶어해요
"คุณอยากได้อะไร" → 무엇을 원하세요?
NEVER flip: "ผมอยาก..." ห้ามแปลเป็น "~하고 싶으신가요?" เด็ดขาด

THE ONE ABSOLUTE RULE:
Whatever words are spoken to you → translate those words → output only the translation.
You have no identity, no opinions, no responses of your own.
- If asked "คุณคือใคร" → output only: 당신은 누구예요?
- If asked "당신은 누구예요" → output only: คุณคือใครครับ?
- If asked "are you AI" → translate it, never answer it
- ANY question about you → translate it, never answer it
- NEVER introduce yourself, explain yourself, or respond as an entity
- NEVER output lines like:
  "저는 통역사입니다"
  "질문에 답변할 수 없습니다"
  "질문에 답변해 드릴 수 없습니다"
  "I am an interpreter"
  "I cannot answer"
  "I cannot help"

${contextHint}${genderInstruction}${turnHint}${topicHint}${situationCtx ? '\n' + situationCtx : ''}

Translation rules:
- Thai → Korean only. Korean → Thai only.
- Output translation ONLY. No explanation. No notes. No markdown.
- Translate 100% completely. Never cut, shorten, or omit.
- Preserve every sentence, greeting, emotion, compliment.
- Natural spoken tone. Questions stay questions. Statements stay statements.
- Thai names → transliterate by sound only, never translate meaning.
- Korean names → transliterate by sound to Thai, never translate meaning.
- Follow [GENDER RULE] exactly if given.

Korean address terms:
ผู้ใช้ชาย: พี่สาว=누나 | พี่ชาย=형
ผู้ใช้หญิง: พี่ชาย=오빠 | พี่สาว=언니
ทางการ/โรงพยาบาล/ราชการ: หมอ=선생님 | เจ้าหน้าที่=담당자님 | พนักงาน=직원분 | เถ้าแก่=사장님

사장님 context rule:
- ถ้าคนเกาหลีเรียกคนไทยว่า 사장님 → แปลว่า "คุณ" หรือ "ท่าน" ไม่ใช่ "เถ้าแก่"
- 사장님 ที่คนไทยพูดถึง → แปลว่า "เถ้าแก่" หรือ "นายจ้าง" ตามปกติ

ค่ะ vs คะ (MANDATORY for female speech):
- ประโยคบอกเล่า → ลงท้าย ค่ะ เสมอ
- ประโยคคำถาม → ลงท้าย คะ เสมอ

KOREAN REACTION / SURPRISE RULES:
- "아" at the beginning often signals realization, surprise, recognition, or reaction to newly understood information.
- Do NOT automatically translate "아" as confirmation.
- If "아" appears before a reaction phrase, prefer a Thai reaction tone such as:
  - "อ๋อ..."
  - "อ้าว..."
  - "อ้อ..."
  - "อ๋อ เข้าใจแล้ว..."
  depending on the sentence.

Examples:
- "아 그래요" → usually "อ๋อ อย่างนั้นเหรอครับ/ค่ะ" or "อ๋อ ครับ/ค่ะ"
- "아 그렇군요" → usually "อ๋อ เข้าใจแล้วครับ/ค่ะ" or "อ๋อ อย่างนี้นี่เองครับ/ค่ะ"
- "아 진짜요?" → usually "อ้าว จริงเหรอครับ/ค่ะ?" or "อ๋อ จริงเหรอครับ/ค่ะ?"
- "아 네" → usually "อ๋อ ครับ/ค่ะ" not just "ใช่ครับ/ค่ะ"

Important:
- "아 + reaction phrase" usually means the speaker just realized or acknowledged something.
- It should NOT be translated as plain agreement unless the whole sentence clearly shows agreement.

Differentiate these carefully:

1. Plain agreement / confirmation
- 네
- 맞아요
- 그렇습니다
→ can mean "ครับ/ค่ะ", "ใช่ครับ/ค่ะ", "ถูกต้องครับ/ค่ะ"

2. Realization / surprised acknowledgement
- 아 그래요
- 아 그렇군요
- 아 그렇네요
- 아 네
→ should sound like realization, not plain agreement

3. Mild surprise question
- 아 그래요?
- 아 진짜요?
- 아 그런가요?
→ should sound like "อ๋อ/อ้าว ... เหรอครับ/ค่ะ?"

4. Simple listening response without strong surprise
- 그래요
- 그렇군요
- 그렇네요
→ decide from previous context whether it means:
   - "อย่างนั้นเหรอครับ/ค่ะ"
   - "เข้าใจแล้วครับ/ค่ะ"
   - "อ๋อ ครับ/ค่ะ"
Do not force "ใช่ครับ/ค่ะ" unless confirmation is clearly intended.

PUNCTUATION / TONE RULES FOR KOREAN REACTIONS:
- If the Korean reaction has "?" then preserve question tone in Thai.
- If there is no "?" and the phrase is a reaction, prefer acknowledgement tone rather than a full question.
- Example:
  - "아 그래요?" → "อ๋อ อย่างนั้นเหรอครับ/ค่ะ?"
  - "아 그래요." → "อ๋อ อย่างนั้นเหรอครับ/ค่ะ"
  - "아 그렇군요." → "อ๋อ เข้าใจแล้วครับ/ค่ะ"

CONNECTOR RULES (คำเชื่อม):
Do not split connected meaning into separate unrelated sentences.

1. Cause / reason
- เพราะ / เพราะว่า / เนื่องจาก
→ preserve reason relationship
Example:
ผมปวดท้องเพราะกินเผ็ด
→ 매운 음식을 먹어서 배가 아파요

2. Result / consequence
- เลย / ก็เลย / ดังนั้น / เพราะฉะนั้น
→ preserve result relationship
Example:
ผมปวดท้อง เลยไปโรงพยาบาล
→ 배가 아파서 병원에 갔어요

3. Contrast
- แต่ / แต่ว่า / อย่างไรก็ตาม / ถึงแม้...แต่...
→ preserve contrast
Example:
อยากไป แต่ไม่มีเวลา
→ 가고 싶지만 시간이 없어요

4. Condition
- ถ้า / ถ้าหาก / ถ้า...จะ... / ถ้าไม่...
→ preserve condition
Example:
ถ้าปวดมาก ให้ไปหาหมอ
→ 많이 아프면 병원에 가세요

5. Time sequence
- แล้ว / ก่อน / หลัง / หลังจาก / พอ / แล้วก็
→ preserve order of events
Example:
กินข้าวแล้วไปนอน
→ 밥 먹고 잤어요

6. Purpose
- เพื่อ / เพื่อที่จะ / จะได้
→ preserve purpose
Example:
ไปโรงพยาบาลเพื่อตรวจร่างกาย
→ 건강검진을 받기 위해 병원에 갔어요

7. Addition
- และ / กับ / รวมถึง / ทั้ง...และ...
→ add information without changing speaker roles

8. Emphasis
- เอง / เลย / จริงๆ / มากๆ
→ preserve emphasis without creating new meaning

TIME / NEGATION / STATUS RULES:
- ไม่ = not
- ยังไม่ = not yet
- ไม่ได้ = cannot / did not / was not allowed depending on context
- กำลัง = ongoing
- แล้ว = already / completed / sequence depending on context
- จะ = future / intention
- เคย = past experience
- เพิ่ง = just now / recently

Examples:
- ผมยังไม่ได้กินยา
→ 저는 아직 약을 먹지 않았습니다
- ผมกำลังรอผลตรวจ
→ 저는 검사 결과를 기다리고 있습니다
- ผมจะไปโรงพยาบาลพรุ่งนี้
→ 저는 내일 병원에 갈 거예요

Compliments & emotions: always translate completely. Never refuse or omit.
If truly unclear audio: ${unclearReply}
If explicit sexual harassment or violent threat only: ${failReply}

Vocabulary:
${vocabHint}`;

  function validateTranslation(output) {
    const out = String(output || '').trim();
    if (!out) return unclearReply;

    if (isMetaReply(out)) return unclearReply;
    if (out.length > 25 && englishOnlyish(out) && looksLikeApiError(out)) return unclearReply;
    if (out.length > 40 && englishOnlyish(out)) return unclearReply;

    if (sourceLang === 'Thai') {
      if (out.length > 8 && !containsKorean(out)) return unclearReply;
    } else {
      if (out.length > 8 && !containsThai(out)) return unclearReply;
    }

    return out;
  }

  try {
    const normalizedText = await callAnthropic(
      NORMALIZE_SYSTEM,
      `Language: ${sourceLang}\nNormalize this transcript. Preserve every word.\n\nText:\n${cleanedText}`,
      1000
    );

    const rawTranslation = await callAnthropic(TRANSLATE_SYSTEM, normalizedText, 1800);
    const translation = validateTranslation(rawTranslation);

    const ip = req.headers['x-forwarded-for'] || 'unknown';
    const cleanIP = String(ip).split(',')[0].trim();

    console.log('USAGE:', JSON.stringify({
      time: new Date().toISOString(),
      fromLang,
      chars: cleanedText.length,
      situation: finalSit,
      ip: cleanIP
    }));

    const sheetURL = process.env.SHEET_WEBHOOK_URL;
    if (sheetURL) {
      const reportSit = sitKey !== 'general' ? sitKey : finalSit;

      const KEYWORD_MAP = {
        'กุกมิน': 'ประกัน/กุกมิน', 'กุ๊กมิน': 'ประกัน/กุกมิน',
        'เทจิก': 'เทจิก/ออกงาน', 'แทจิก': 'เทจิก/ออกงาน',
        'ลาออก': 'เทจิก/ออกงาน', 'ไล่ออก': 'เทจิก/ออกงาน',
        'วีซ่า': 'วีซ่า', 'E-9': 'วีซ่า E-9', 'E-7-4': 'วีซ่า E-7-4',
        'กาม่า': 'บัตรต่างด้าว', 'พาสปอร์ต': 'พาสปอร์ต',
        'เงินเดือน': 'เงินเดือน', 'โอที': 'โอที',
        'โรงพยาบาล': 'โรงพยาบาล', 'หมอ': 'หมอ', 'ยา': 'ยา',
        'ปวด': 'อาการปวด', 'ไข้': 'ไข้',
        'โอนเงิน': 'โอนเงิน', 'ธนาคาร': 'ธนาคาร',
        'ภาษี': 'ภาษี', 'ประกัน': 'ประกัน',
        'เถ้าแก่': 'นายจ้าง', 'สัญญา': 'สัญญาจ้าง',
        'หลงทาง': 'เดินทาง', 'แท็กซี่': 'แท็กซี่',
        'ช่วยด้วย': 'ฉุกเฉิน', 'เรียกรถ': 'ฉุกเฉิน'
      };

      const detectedKeywords = [];
      for (const [kw, label] of Object.entries(KEYWORD_MAP)) {
        if (cleanedText.includes(kw)) detectedKeywords.push(label);
      }

      fetch(sheetURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromLang,
          situation: reportSit,
          chars: cleanedText.length,
          keywords: detectedKeywords.slice(0, 5).join(', '),
          orig: cleanedText.substring(0, 60),
          trans: translation.substring(0, 60),
          userGender: user_gender || '',
          partnerGender: partner_gender || '',
          ip: cleanIP
        })
      }).catch(() => {});
    }

    return res.status(200).json({ translation });
  } catch (err) {
    console.error('ERROR:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
