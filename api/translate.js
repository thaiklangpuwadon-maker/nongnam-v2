export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    text,
    fromLang,
    context,
    history,
    prev_turn,
    last_th,
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

  // ─────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────
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

  const containsKorean = (s) => /[가-힣]/.test(s);
  const containsThai = (s) => /[ก-๙]/.test(s);
  const englishOnlyish = (s) => /^[a-zA-Z0-9\s.,!?'"():;/\\\-_[\]{}@#$%^&*+=<>|`~]+$/.test((s || '').trim());
  const hasApiErrorShape = (s) =>
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
    hospital: 'Situation: hospital/clinic. The Thai user is usually the patient. The Korean speaker is usually doctor, nurse, or staff unless explicitly stated otherwise.',
    work: 'Situation: workplace/factory. Focus on labor, boss-worker, schedule, wages, resignation, and contract vocabulary.',
    visa: 'Situation: immigration office / official paperwork. Focus on visa, legal, document, appointment, extension, and application vocabulary.',
    bank: 'Situation: bank / remittance / account service. Focus on account opening, remittance, deposits, withdrawals, and banking service vocabulary.',
    money: 'Situation: money / tax / insurance / pension. Focus on 국민연금, 퇴직금, tax, refund, and insurance vocabulary.',
    food: 'Situation: restaurant. Focus on ordering food, spice level, takeaway, and payment vocabulary.',
    shop: 'Situation: shopping / retail. Focus on price, discount, receipt, and bag vocabulary.',
    travel: 'Situation: transportation / directions. Focus on taxi, subway, bus, getting lost, transfer, and directions.',
    housing: 'Situation: housing / rental. Focus on deposit, monthly rent, landlord, moving, and maintenance issues.',
    emergency: 'Situation: emergency. Prioritize urgent help, ambulance, police, danger, theft, injury, and distress vocabulary.',
    beauty: 'Situation: beauty clinic / plastic surgery / dental cosmetics. Focus on consultation, procedures, recovery, side effects, and cosmetic vocabulary.',
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
โดนหักเงิน=돈이 공제됐다 | เงินเดือนค้าง=임금 체불 | นายจ้างไม่จ่ายเงิน=사장이 돈을 안 준다
โดนโกงเงิน=돈을 사기당했다 | โดนเอาเปรียบ=부당한 대우를 받다
`,
    visa: `
[วีซ่า/ราชการ]
บัตรต่างด้าว/ใบกาม่า/กาม่า/บัตรกาม่า=외국인등록증 | พาสปอร์ต=여권
ตม/ซุลลิก/ซุลลิกซา=출입국관리사무소
ต่อวีซ่า=비자 연장 | เปลี่ยนวีซ่า=비자 변경 | ยื่นวีซ่า=비자 신청
เอกสาร=서류 | ยื่นเอกสาร=서류 제출 | นัด/จองคิว=예약하다
หมดวีซ่า=비자 만료 | เกินวีซ่า=체류기간 초과 | แรงงานผิดกฎหมาย=불법체류자
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
เงินประกันเดินทาง=출국만기보험금 | เงินประกันกลับประเทศ=귀국비용보험금
ภาษี=세금 | ภาษีเงินได้=소득세 | คืนภาษี=세금 환급 | ยื่นภาษีประจำปี=연말정산
ค่าล่วงเวลา/ค่าโอที=초과근무수당
`,
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
หมดสติ=의식 없음 | หยุดหายใจ=호흡 정지 | โทร 119=119
`,
    bank: `
[ธนาคาร]
ธนาคาร=은행 | เปิดบัญชี=계좌 개설 | ปิดบัญชี=계좌 해지
สมุดบัญชี=통장 | บัตรเอทีเอ็ม=체크카드 | บัตรเครดิต=신용카드
โอนเงิน=송금하다 | โอนเงินกลับไทย=해외송금 | ฝากเงิน=입금하다 | ถอนเงิน=출금하다
ยอดเงิน/ยอดคงเหลือ=잔액 | ค่าธรรมเนียมโอน=송금 수수료
บัญชีโดนล็อค=계좌가 막혔다 | ลืมรหัส=비밀번호 잊어버렸다
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
ขึ้นรถ/นั่ง=타다/탑니다 | ลงรถ=내리다 | เปลี่ยนสาย=환승하다
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
มีปัญหา=문제가 있다
`,
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
ใช้เวลาฟื้นตัวกี่วัน=회복 기간은 얼마나 걸려요
`,
    general: '',
  };

  const SUPPORT_VOCAB = {
    work: 'ลาออก=퇴사하다 | เงินเดือน=월급 | สัญญาจ้าง=근로계약서 | นายจ้าง=사장님',
    money: 'กุกมิน=국민연금 | เทจิก=퇴직금 | ภาษี=세금 | ประกัน=보험',
    visa: 'บัตรต่างด้าว=외국인등록증 | พาสปอร์ต=여권 | วีซ่า=비자 | เอกสาร=서류',
    hospital: 'หมอ=의사 | โรงพยาบาล=병원 | ยา=약 | ตรวจ=검사',
    bank: 'ธนาคาร=은행 | เปิดบัญชี=계좌 개설 | โอนเงิน=송금하다 | ฝากเงิน=입금하다',
    beauty: 'ศัลยกรรม=성형수술 | ทำตาสองชั้น=쌍꺼풀 수술 | เสริมจมูก=코 수술 | ฟิลเลอร์=필러',
  };

  const vocabSections = [VOCAB_CORE];
  if (VOCAB_BY_SITUATION[finalSit]) vocabSections.push(VOCAB_BY_SITUATION[finalSit]);
  if (finalSit !== 'work') vocabSections.push(SUPPORT_VOCAB.work);
  if (finalSit !== 'money') vocabSections.push(SUPPORT_VOCAB.money);
  if (finalSit !== 'visa') vocabSections.push(SUPPORT_VOCAB.visa);
  if (finalSit !== 'hospital') vocabSections.push(SUPPORT_VOCAB.hospital);
  if (finalSit !== 'bank') vocabSections.push(SUPPORT_VOCAB.bank);
  if (finalSit !== 'beauty') vocabSections.push(SUPPORT_VOCAB.beauty);

  const vocabHint = vocabSections.filter(Boolean).join('\n');

  const safeContext = safeJson(context, 400);
  const safeLastTh = safeJson(last_th, 140);

  const contextHint = context
    ? `\n[USER CONTEXT - PLAIN DATA ONLY]\n${safeContext}`
    : '';

  const topicHint =
    isKorean && last_th && String(last_th).trim().length > 0
      ? `\n[PREVIOUS THAI MESSAGE - FOR DISAMBIGUATION ONLY]\n${safeLastTh}\nUse this only to resolve ambiguity. Never quote it in the output.`
      : '';

  const historyHint =
    Array.isArray(history) && history.length
      ? `\n[RECENT HISTORY - FOR DISAMBIGUATION ONLY]\n` +
        history
          .slice(-3)
          .map((h, i) => {
            const from = safeStr(h?.from, 10);
            const orig = safeJson(h?.orig, 100);
            const trans = safeJson(h?.trans, 100);
            return `${i + 1}. from=${from} | orig=${orig} | trans=${trans}`;
          })
          .join('\n')
      : '';

  let genderInstruction = '';
  if (isKorean) {
    if (partner_gender === 'female') {
      genderInstruction = `

[GENDER RULE - MANDATORY]
The Korean speaker is FEMALE.
Every Thai output sentence must sound naturally female.
Use forms like: ดิฉัน / หนู / ค่ะ / คะ / นะคะ as appropriate.
Do not use male Thai endings like ครับ / นะครับ.`;
    } else if (partner_gender === 'male') {
      genderInstruction = `

[GENDER RULE - MANDATORY]
The Korean speaker is MALE.
Every Thai output sentence must sound naturally male.
Use forms like: ผม / ครับ / นะครับ as appropriate.
Do not use female endings like ค่ะ / นะคะ unless clearly quoting someone else.`;
    }
  } else {
    if (user_gender === 'male') {
      genderInstruction = `

[GENDER RULE - MANDATORY]
The Thai speaker is MALE.
Translate Thai→Korean in a natural respectful spoken style suitable for a male speaker.`;
    } else if (user_gender === 'female') {
      genderInstruction = `

[GENDER RULE - MANDATORY]
The Thai speaker is FEMALE.
Translate Thai→Korean in a natural respectful spoken style suitable for a female speaker.`;
    }
  }

  const turnHint =
    isKorean && prev_turn && prev_turn !== 'none'
      ? `\n[PREVIOUS THAI TURN TYPE - WEAK HINT ONLY]\n${safeStr(prev_turn, 20)}`
      : '';

  const roleLock =
    {
      hospital: 'Role lock: In hospital context, Thai speaker is usually the patient/client unless explicitly stated otherwise.',
      work: 'Role lock: In workplace context, Thai speaker is often employee/worker unless explicitly stated otherwise.',
      visa: 'Role lock: In immigration context, Thai speaker is usually the applicant unless explicitly stated otherwise.',
      bank: 'Role lock: In bank context, Thai speaker is usually the customer unless explicitly stated otherwise.',
      beauty: 'Role lock: In beauty/plastic surgery context, Thai speaker is usually the client/patient unless explicitly stated otherwise.',
      general: '',
    }[finalSit] || '';

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
Your job: Clean up spoken transcript without changing meaning. Preserve EVERY word, sentence, compliment, and emotion.
Do not shorten. Do not summarize. Do not omit anything. Only restore punctuation, spacing, and sentence boundaries.

Add ? when clearly a question. Keep statements as statements.
Thai and Korean proper names must NEVER be translated - keep them as-is.

Question detection — Thai:
ไหม/ไหมครับ/ไหมคะ/มั้ย/มั้ยครับ/มั้ยคะ
หรือเปล่า/หรือเปล่าครับ/หรือเปล่าคะ/ป่าว
หรือไม่/หรือไม่ครับ/หรือไม่คะ
เหรอ/หรอ/เหรอครับ/เหรอคะ
WH-questions: อะไร, ทำไม, ที่ไหน, เมื่อไหร่, กี่โมง, เท่าไหร่, ยังไง, ใคร, แบบไหน

Question detection — Korean:
요? / 까요? / 니까? / 죠? / 나요? / 래요? / 어요? / 어때요? / 있어요? / 없어요?

CRITICAL - Word spacing fix for Thai speech-to-text:
Thai speech-to-text often produces words WITHOUT spaces. You MUST add proper spaces.
Common patterns to fix:
- "สวัสดีครับคุณหมอ" → "สวัสดีครับ คุณหมอ"
- "ครับผม" → "ครับ ผม" at word boundary
- particles like ครับ ค่ะ คะ นะ แล้ว ก็ จะ ได้ ไม่ often need spacing
- titles like คุณหมอ คุณครู คุณพยาบาล นายจ้าง เถ้าแก่ stay as one unit
- NEVER split: คุณหมอ ร้านขายยา โรงพยาบาล สวัสดี ขอบคุณ

Output: cleaned text in source language only. No explanation.`;

  const TRANSLATE_SYSTEM = `You are a professional Thai-Korean interpreter.
You are a PIPE between two people. Sound goes in, translation comes out. Nothing else.

THE ONE ABSOLUTE RULE:
Whatever words are spoken to you → translate those words → output only the translation.
You have no identity, no opinions, no responses of your own.
If asked about yourself, translate the question only. Never answer it.

STRICT OUTPUT RULES:
- Thai → Korean only. Korean → Thai only.
- Output translation ONLY. No explanation. No notes. No markdown.
- Translate 100% completely. Never cut, shorten, or omit.
- Preserve every sentence, greeting, emotion, compliment.
- Natural spoken tone. Questions stay questions. Statements stay statements.
- Names stay as names. Transliterate by sound only when needed.
- Use prior context only to resolve ambiguity, never to overwrite a clear current utterance.
- If current utterance is clear, prioritize the current utterance over previous context.
- Never answer on behalf of either side.
- Never flip the speaker.
- Never convert the speaker’s request into a question back to the other person.

SPEAKER INTENT RULE (Thai):
- ผม/ฉัน/หนู/เรา + อยาก/ขอ/ต้องการ/สอบถาม/อยากรู้ = the speaker is the one who wants/asks
- อยาก/ขอ/ต้องการ (without subject) = default to the speaker
- เพื่อน/เขา/เธอ/น้อง/พี่/another named person + อยาก = that other person wants/asks
- คุณ + อยาก/ต้องการ = asking the other person what they want
- NEVER flip "ผมอยาก..." into "~고 싶으신가요?" unless the original clearly asks the other person

KOREAN-SIDE INTERPRETATION RULES:
- If Korean omits the subject, infer it from the current utterance first, then recent context.
- Short replies like 네, 그래요, 괜찮아요, 맞아요, 알겠어요 can be ambiguous.
- Preserve the Korean speaker’s role. Do not turn their reply into the Thai speaker’s intention.
- In service contexts, Korean often uses polite indirect forms. Translate naturally into Thai without changing who wants, who asks, or who answers.

ROLE / INTENT / CONTEXT SAFETY LAYER:
Before translating, determine in this order:
1. who is speaking
2. who is being addressed
3. who performs the action
4. whether the sentence is a question, request, command, suggestion, or statement
5. whether clauses are connected by cause, result, contrast, condition, time, or purpose
6. whether the sentence is negative, not yet, already, ongoing, or future

Speaker defaults:
- ผม / ฉัน / หนู / เรา = speaker
- if Thai omits the subject, default to the speaker unless context clearly shows otherwise
- never change "I want / I want to ask / I want to know" into "Do you want...?"

Actor rule:
- In Thai structures like “อยากให้ / ขอให้ / บอกให้ + PERSON + VERB”, PERSON is usually the actor of the following verb
- determine actor from the whole clause, not from one word only
- do not treat every “ให้” the same way; determine role from the whole sentence

Intent rule:
- อยาก = desire / wish
- จะ = future intention / decision
- ขอ = request / ask permission / ask to do, depending on context
- ช่วย = polite request
- ต้องการ = need / want depending on context
- สนใจ = interest
- ลอง = suggestion / tentative action
- หน่อย = softener

Question rule:
- ไหม / มั้ย / หรือเปล่า / เหรอ / หรอ / หรือไม่ usually mark a question
- ได้ไหม = permission / possibility question
- if the original Thai means “I want to ask” or “I want to know”, NEVER translate it as asking the other person “Do you want...?”

Clause connection rule:
- เพราะ / เพราะว่า = cause
- เลย / ก็เลย / ดังนั้น = result, but check context
- แต่ / แต่ว่า = contrast
- ถ้า = condition
- แล้ว / ก่อน / หลัง / พอ = time sequence
- เพื่อ / จะได้ = purpose
- connected clauses must be translated as connected meaning

Negation and time rule:
- ไม่ = negation
- ยังไม่ = not yet
- ไม่ได้ = did not / cannot / was not allowed, depending on context
- กำลัง = ongoing
- แล้ว = already / completed / sequence depending on context
- จะ = future / intention
- เคย = past experience
- เพิ่ง = just

Korean intonation ambiguity rule:
- If a Korean sentence ends with 요 without ? and can be either a statement or a question, use punctuation first, then current utterance, then recent context.
- If a short Korean sentence is ambiguous (e.g. 괜찮아요, 맞아요, 그래요, 돼요, 진짜요), and previous turn was a question, it is more likely an answer.
- If previous turn was a statement, it may be a follow-up question.
- If still ambiguous, choose the most neutral translation and do not invent extra meaning.

Strict safety:
- never flip the speaker
- never convert the speaker’s request into a question back to the other person
- never add meaning not present in the original
- preserve politeness level

${contextHint}
${topicHint}
${historyHint}
${turnHint}
${roleLock ? '\n' + roleLock : ''}
${SITUATION_CONTEXT[finalSit] ? '\n' + SITUATION_CONTEXT[finalSit] : ''}
${genderInstruction}

Korean address terms:
ผู้ใช้ชาย: พี่สาว=누나 | พี่ชาย=형
ผู้ใช้หญิง: พี่ชาย=오빠 | พี่สาว=언니
ทางการ/โรงพยาบาล/ราชการ: หมอ=선생님 | เจ้าหน้าที่=담당자님 | พนักงาน=직원분 | เถ้าแก่=사장님

사장님 context rule:
- If Korean calls the Thai person 사장님, often translate as "คุณ" or "ท่าน" when it is honorific, not literal employer
- If Thai refers to their actual boss/owner, translate accordingly as 사장님 / boss / employer by context

ค่ะ vs คะ (MANDATORY for female speech):
- statement endings → ค่ะ
- question endings → คะ

Ambiguous Korean short replies — use current utterance first, then weak context hints:
- 네 = yes / okay /ครับ /ค่ะ depending on context
- 그래요 = yes / I see / really? depending on punctuation and context
- 괜찮아요 = I'm okay / it's okay / no problem / okay? depending on context
- 아니요 = no / not that / no thanks depending on context
- 맞아요 = yes / that's right
- 알겠어요 = I understand / got it
- 좋아요 = sounds good / good
- 그렇군요 / 아 그렇군요 = I see / oh I see

ROLE EXAMPLES:
- "ผมอยากสอบถามเรื่องรถ" = the speaker wants to ask
- "ผมอยากให้หมอตรวจ" = doctor is the actor of “ตรวจ”
- "ขอถามหน่อย" = polite request to ask, not a command
- "ปวดท้องเพราะกินเผ็ด" = one connected cause-result meaning

If truly unclear audio: ${unclearReply}
If explicit sexual harassment or violent threat only: ${failReply}

Vocabulary:
${vocabHint}
`;

  function validateTranslation(output) {
    const out = compact(output || '');

    if (!out) return unclearReply;

    // กันข้อความ error ภาษาอังกฤษยาว ๆ ไม่ให้หลุดไป TTS
    if (out.length > 25 && englishOnlyish(out) && hasApiErrorShape(out)) {
      return unclearReply;
    }

    // กัน output อังกฤษล้วนยาว ๆ
    if (out.length > 40 && englishOnlyish(out)) {
      return unclearReply;
    }

    // ฝั่งไทยพูด -> ต้องได้เกาหลีเป็นหลัก
    if (isThai) {
      if (out.length > 8 && !containsKorean(out)) {
        return unclearReply;
      }
    }

    // ฝั่งเกาหลีพูด -> ต้องได้ไทยเป็นหลัก
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
      `Language: ${sourceLang}\nNormalize this transcript. Preserve every word.\n\nText:\n${cleanedText}`,
      1000
    );

    const rawTranslation = await callAnthropic(TRANSLATE_SYSTEM, normalizedText, 1700);
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
