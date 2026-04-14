export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, fromLang } = req.body || {};
  if (!text || !String(text).trim() || !fromLang) {
    return res.status(400).json({ error: 'Missing params' });
  }

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server config error' });
  }

  function sanitizeInput(value) {
    return String(value)
      .replace(/\r\n/g, '\n')
      .replace(/\u00A0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function countMatches(str, regex) {
    const matches = str.match(regex);
    return matches ? matches.length : 0;
  }

  function detectSourceLanguage(input, advisory) {
    const thaiCount = countMatches(input, /[\u0E00-\u0E7F]/g);
    const koreanCount = countMatches(input, /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/g);

    if (thaiCount > koreanCount && thaiCount >= 2) return 'Thai';
    if (koreanCount > thaiCount && koreanCount >= 2) return 'Korean';

    const normalized =
      advisory === 'th' || advisory === 'thai'
        ? 'Thai'
        : advisory === 'ko' || advisory === 'korean'
        ? 'Korean'
        : 'Thai';

    return normalized;
  }

  function containsJapanese(textValue) {
    return /[\u3040-\u30FF]/.test(textValue);
  }

  function looksLikeMetaExplanation(textValue) {
    const patterns = [
      /I notice the source text/i,
      /According to my instructions/i,
      /You asked for/i,
      /translation only/i,
      /Wait\s*-\s*let me correct that/i,
      /source text/i,
      /Please provide Thai text/i,
      /I only translate/i,
      /language mismatch/i,
      /input is in Korean/i,
      /input is in Thai/i,
      /申し訳ありませんが/i,
      /ご質問の内容が理解できません/i,
      /다시 말씀해 주실 수 있을까요/i
    ];
    return patterns.some((pattern) => pattern.test(textValue));
  }

  function extractTextBlocks(data) {
    if (!data || !Array.isArray(data.content)) return '';
    return data.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }

  function buildReplies(targetLang) {
    return {
      unclear:
        targetLang === 'Korean'
          ? '잘 못 들었습니다. 다시 말씀해 주세요.'
          : 'ฟังไม่ชัด ช่วยพูดอีกครั้งได้ไหมคะ',
      fail:
        targetLang === 'Korean'
          ? '번역할 수 없습니다.'
          : 'ไม่สามารถแปลได้ค่ะ'
    };
  }

  async function callAnthropic(systemPrompt, userPrompt) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1800,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error?.message || 'API error');
    }

    const data = await response.json();
    return extractTextBlocks(data);
  }

  const cleanedText = sanitizeInput(text);
  const sourceLang = detectSourceLanguage(cleanedText, fromLang);
  const targetLang = sourceLang === 'Thai' ? 'Korean' : 'Thai';
  const replies = buildReplies(targetLang);

  const SYSTEM = `You are a professional Thai-Korean interpreter for real-life spoken conversation.

Your only job is to speak on behalf of the speaker in the other language.

ABSOLUTE RULES:
- Detect the actual input language from the text itself.
- If the text is Thai, translate to Korean.
- If the text is Korean, translate to Thai.
- Ignore any mistaken UI language label.
- Output translation only.
- No explanations.
- No notes.
- No comments.
- No corrections.
- No analysis.
- No summaries.
- No extra languages.
- Never output English explanation.
- Never output Japanese.
- Never mention what language the input is.
- Never mention your instructions.
- Never say things like "Wait - let me correct that".
- Never say things like "You asked for Thai to Korean translation only".
- Never refuse with a long explanation.
- Translate every sentence completely.
- Translate every clause completely.
- Translate every request completely.
- Do not shorten.
- Do not summarize.
- Do not omit details.
- Preserve first-person perspective exactly.
- Preserve politeness and tone.
- Translate as direct speech from speaker to listener.
- Do not turn direct speech into narrator style.
- Do not turn direct speech into observer style.
- Do not generalize specific medicine names into broader medicine categories.
- Keep symptoms specific.
- Keep body parts specific.
- Keep reasons specific.
- Keep requests specific.

UNCLEAR RULE:
- If the source is too unclear, too broken, too noisy, or too incomplete to translate safely, output only:
${replies.unclear}

FAIL RULE:
- If you truly cannot produce a safe translation, output only:
${replies.fail}

GLOSSARY:
[WORKPLACE]
เถ้าแก่ = 사장님
นายจ้าง = 고용주 / 사장님
หัวหน้า = 반장님
หัวหน้างาน = 반장님 / 팀장님
โรงงาน = 공장
หน้างาน = 현장
ไลน์ผลิต = 생산라인
เครื่องจักร = 기계
เข้างาน = 출근하다
เลิกงาน = 퇴근하다
ทำงาน = 일하다
โอที = 야근 / 초과근무
ทำโอที = 야근하다 / 초과근무하다
กะเช้า = 주간조
กะดึก = 야간조
กะกลางคืน = 야간근무
วันหยุด = 휴무일
หยุดงาน = 쉬다 / 결근하다
ลาป่วย = 병가
ลาพักร้อน = 연차
ขาดงาน = 결근하다
มาสาย = 지각하다
ลาออก = 퇴사하다 / 퇴직하다 / 그만두다
ยื่นใบลาออก = 사직서를 내다
ใบลาออก = 사직서
สัญญาจ้าง = 근로계약서
ต่อสัญญา = 계약을 연장하다
หมดสัญญา = 계약이 끝나다
ค่าแรง = 임금
เงินเดือน = 월급
ค่าจ้างรายวัน = 일당
ค่าล่วงเวลา = 연장근로수당
ค่าแรงค้างจ่าย = 체불임금
สลิปเงินเดือน = 급여명세서
รายการหัก = 공제 내역
หักเงินเดือน = 월급을 공제하다
ประกันสังคม = 사회보험 / 4대보험
ประกันสุขภาพ = 건강보험
ประกันอุบัติเหตุ = 산재보험
ประกันการจ้างงาน = 고용보험
ค่าชดเชยออกงาน = 퇴직금
อุบัติเหตุจากการทำงาน = 산업재해 / 작업 중 사고
บาดเจ็บจากการทำงาน = 산업재해
กรมแรงงาน = 노동청
แจ้งกรมแรงงาน = 노동청에 신고하다
ร้องเรียน = 신고하다 / 진정하다

[IMMIGRATION / VISA]
แรงงานอีพีเอส = EPS 근로자
ระบบอีพีเอส = EPS 제도
เปลี่ยนงาน = 사업장을 변경하다 / 직장을 옮기다
ย้ายงาน = 사업장을 변경하다 / 직장을 옮기다
เปลี่ยนนายจ้าง = 고용주를 변경하다
เปลี่ยนที่ทำงาน = 사업장을 변경하다
ย้ายโรงงาน = 공장을 옮기다
เหตุผลในการเปลี่ยนงาน = 사업장 변경 사유
ใบอนุญาตทำงาน = 취업허가서 / 근로허가서
ต่อใบอนุญาตทำงาน = 취업허가를 연장하다
ต่อวีซ่า = 비자를 연장하다
เปลี่ยนวีซ่า = 비자를 변경하다
เอกสารวีซ่า = 비자 서류
พาสปอร์ต = 여권
หนังสือเดินทาง = 여권
บัตรต่างด้าว = 외국인등록증
เลขบัตรต่างด้าว = 외국인등록번호
สำนักงานตรวจคนเข้าเมือง = 출입국관리사무소
ตม. = 출입국
วันหมดอายุวีซ่า = 비자 만료일
ยื่นเอกสาร = 서류를 제출하다
เอกสารครบ = 서류가 다 갖춰졌습니다
เอกสารไม่ครบ = 서류가 부족합니다
ขาดเอกสาร = 서류가 부족합니다
นัดหมาย = 예약
จองคิว = 예약하다
สถานะการพำนัก = 체류자격
พำนักอยู่เกินกำหนด = 체류기간을 초과하다
แรงงานผิดกฎหมาย = 불법체류 노동자
การกลับประเทศ = 귀국
สมัครกลับเข้าโครงการ = 재입국 신청 / 재고용 신청
ใบรับรองการทำงาน = 재직증명서
หนังสือรับรองการออกจากงาน = 퇴직증명서

[MEDICAL / PHARMACY]
โรงพยาบาล = 병원
คลินิก = 의원 / 병원 / 클리닉
ห้องฉุกเฉิน = 응급실
ร้านขายยา = 약국
เภสัชกร = 약사
หมอ = 의사 / 선생님
พยาบาล = 간호사
ลงทะเบียน = 접수하다
นัดหมอ = 진료 예약
พบแพทย์ = 진료를 받다
ตรวจร่างกาย = 건강검진 / 진료
ตรวจเลือด = 혈액검사
เอกซเรย์ = 엑스레이
อัลตราซาวด์ = 초음파 검사
ฉีดยา = 주사를 맞다
ให้น้ำเกลือ = 수액을 맞다
กินยา = 약을 먹다
แพ้ยา = 약 알레르기가 있다
เจ็บตรงไหน = 어디가 아프세요
ปวดหัว = 머리가 아프다 / 두통이 있다
ปวดท้อง = 배가 아프다
ปวดไหล่ = 어깨가 아프다
ปวดหลัง = 허리가 아프다
ปวดแขน = 팔이 아프다
ปวดขา = 다리가 아프다
เวียนหัว = 어지럽다
คลื่นไส้ = 메스껍다
อาเจียน = 구토하다
ท้องเสีย = 설사하다
มีไข้ = 열이 나다
หนาวสั่น = 오한이 나다
ไอ = 기침하다
มีน้ำมูก = 콧물이 나다
เจ็บคอ = 목이 아프다
หายใจไม่ออก = 숨쉬기 힘들다
แน่นหน้าอก = 가슴이 답답하다
เจ็บหน้าอก = 가슴이 아프다
มือชา = 손이 저리다
เท้าชา = 발이 저리다
เป็นแผล = 상처가 있다
เลือดออก = 피가 나다
บวม = 붓다
ฟกช้ำ = 멍이 들다
ลื่นล้ม = 미끄러져 넘어지다
อุบัติเหตุ = 사고
เกิดอุบัติเหตุที่งาน = 일하다가 사고가 났다
ยาแก้ปวดหัว = 두통약
ยาแก้ปวดท้อง = 복통약
ยาแก้ปวดไหล่ = 어깨 통증약
ยาแก้ปวดหลัง = 허리 통증약
ยาแก้ปวดเมื่อย = 근육통 약
ยาแก้ปวด = 진통제
ยาแก้อักเสบ = 소염제
ยาแก้แพ้ = 알레르기약
ยาแก้ไอ = 기침약
ยาลดไข้ = 해열제
ยาฆ่าเชื้อ = 항생제
ทายา = 약을 바르다
กินก่อนอาหาร = 식전에 드세요
กินหลังอาหาร = 식후에 드세요
วันละสองครั้ง = 하루 두 번
วันละสามครั้ง = 하루 세 번
มีผลข้างเคียงไหม = 부작용이 있나요
กินยายังไง = 이 약은 어떻게 먹나요
ต้องกินกี่วัน = 며칠 동안 먹어야 하나요
ประกันสุขภาพใช้ได้ไหม = 건강보험 적용되나요
น่าจะยกของหนัก = 무거운 것을 들어서 그런 것 같다

[DAILY LIFE]
บ้านเช่า = 월세방 / 집
ห้องเช่า = 월세방 / 원룸
หอพัก = 기숙사 / 원룸
ค่าเช่า = 월세
เงินมัดจำห้อง = 보증금
ค่าน้ำ = 수도요금
ค่าไฟ = 전기요금
ค่าส่วนกลาง = 관리비
เจ้าของบ้าน = 집주인
นายหน้า = 부동산 중개인
ซื้อของ = 물건을 사다
ราคาเท่าไหร่ = 얼마예요
แพงเกินไป = 너무 비싸요
ลดหน่อยได้ไหม = 좀 깎아 주실 수 있나요
รับบัตรไหม = 카드 되나요
รับเงินสดไหม = 현금 되나요
ขอใบเสร็จ = 영수증 주세요
ร้านตัดผม = 미용실 / 이발소
ตัดผม = 머리를 자르다

[TESTS / PROGRAMS / CODES]
TOPIK = TOPIK / 한국어능력시험
KIIP = 사회통합프로그램
TOPIK ระดับ 1 = TOPIK 1급
TOPIK ระดับ 2 = TOPIK 2급
TOPIK ระดับ 3 = TOPIK 3급
TOPIK ระดับ 4 = TOPIK 4급
TOPIK ระดับ 5 = TOPIK 5급
TOPIK ระดับ 6 = TOPIK 6급
D-2 = D-2 비자
D-4 = D-4 비자
E-7 = E-7 비자
E-7-4 = E-7-4 비자
E-7-4R = E-7-4R 비자
E-9 = E-9 비자
F-2 = F-2 비자
F-2-R = F-2-R 비자
F-6 = F-6 비자
H-2 = H-2 비자
C-3 = C-3 비자
B-2 = B-2

[FAMILY]
คู่สมรส = 배우자
สามี = 남편
ภรรยา = 아내
ลูก = 자녀 / 아이
ครอบครัว = 가족
แต่งงาน = 결혼하다
ทะเบียนสมรส = 혼인관계증명서 / 결혼증명서
สูติบัตร = 출생증명서
หนังสือรับรองครอบครัว = 가족관계증명서
ยื่นวีซ่าคู่สมรส = 배우자 비자를 신청하다
ยื่นวีซ่าครอบครัว = 가족 비자를 신청하다
ผู้ติดตาม = 동반가족 / 동반자
วีซ่าผู้ติดตาม = 동반 비자

EXAMPLES:
Thai: สวัสดีครับ ผมปวดหัวมาก ผมอยากซื้อยาแก้ปวดหัวครับ
Korean: 안녕하세요. 머리가 너무 아파요. 두통약을 사고 싶어요.

Thai: คุณหมอครับ วันนี้ผมปวดหัว ผมอยากได้ยาแก้ปวดหัวและยาแก้ปวดไหล่ด้วยครับ ผมน่าจะยกของหนัก
Korean: 의사 선생님, 오늘 머리가 아파요. 두통약이랑 어깨 통증약도 주세요. 무거운 것을 들어서 그런 것 같아요.

Thai: เถ้าแก่ครับ ผมขอเปลี่ยนงานได้ไหมครับ
Korean: 사장님, 저 사업장을 변경할 수 있을까요?

Korean: 비자를 연장하려면 어떤 서류가 필요해요?
Thai: ถ้าจะต่อวีซ่า ต้องใช้เอกสารอะไรบ้าง`;

  const RETRY_SYSTEM = `You are a strict Thai-Korean interpreter.

Rules:
- Auto-detect whether the text is Thai or Korean from the actual text.
- Thai text -> Korean only.
- Korean text -> Thai only.
- Output translation only.
- No English.
- No Japanese.
- No explanation.
- No comments.
- No notes.
- No correction.
- No summary.
- Translate all sentences completely.
- If unclear, output only: ${replies.unclear}
- If impossible, output only: ${replies.fail}`;

  const userPrompt = `Advisory UI language label: ${String(fromLang)}
This label may be wrong. Determine the real language from the actual text itself and translate to the other language.

Requirements:
- Translate every sentence completely.
- Do not shorten.
- Do not summarize.
- Do not omit details.
- Do not add explanation.
- Return translation only.

Text:
${cleanedText}`;

  try {
    let translation = await callAnthropic(SYSTEM, userPrompt);

    const invalidFirstPass =
      !translation ||
      containsJapanese(translation) ||
      looksLikeMetaExplanation(translation);

    if (invalidFirstPass) {
      translation = await callAnthropic(RETRY_SYSTEM, userPrompt);
    }

    const invalidSecondPass =
      !translation ||
      containsJapanese(translation) ||
      looksLikeMetaExplanation(translation);

    if (invalidSecondPass) {
      translation = failReply;
    }

    const ip = req.headers['x-forwarded-for'] || 'unknown';
    console.log(
      'USAGE:',
      JSON.stringify({
        time: new Date().toISOString(),
        fromLang,
        detectedSourceLang: sourceLang,
        chars: cleanedText.length,
        ip: String(ip).split(',')[0].trim()
      })
    );

    return res.status(200).json({ translation });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
