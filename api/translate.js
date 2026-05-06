// api/translate.js
// ============================================================
// Nongnam Thai-Korean Interpreter API
// Full stable replacement version
// Focus:
// - Thai <-> Korean interpreter only
// - Korean STT correction for real-life mishearing
// - 출장 / ชุลจัง = off-site work / business trip, not ตรวจสอบงาน
// - 몇 시에 들어와요 / 돌아와요 / 오세요 correction
// - Do NOT detect "อยาก" as "ยา"
// - Coupang / คูพัง / กูพัง = 쿠팡, not broken item
// - Parcel / online shopping / front door / delivery context
// - Hospital / dental / wisdom tooth / pus / bone / body pain
// - Isan / fishing / food / ceremony / banter
// - SIM / mobile / used car / work / housing / visa / bank
// - Google Sheet logging
// ============================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      text,
      fromLang,
      context,
      prev_turn,
      last_th,
      user_gender,
      partner_gender,
      history,

      clientId,
      sessionId,
      visitCount,
      firstSeen,
      deviceInfo
    } = req.body || {};

    if (!text || !fromLang) {
      return res.status(400).json({ error: 'Missing params' });
    }

    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server config error: missing CLAUDE_API_KEY' });
    }

    const model = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

    let cleanedText = normalizeAll(String(text || ''), fromLang);
    cleanedText = addQuestionMarksLight(cleanedText, fromLang);

    const sourceLang = isThaiLang(fromLang) ? 'Thai' : 'Korean';
    const targetLang = sourceLang === 'Thai' ? 'Korean' : 'Thai';

    const unclearReply =
      targetLang === 'Korean'
        ? '잘 못 들었습니다. 다시 말씀해 주세요.'
        : buildThaiUnclearReply(partner_gender);

    const failReply =
      targetLang === 'Korean'
        ? '번역할 수 없습니다.'
        : buildThaiFailReply(partner_gender);

    const uiSit = detectSituationFromUIContext(context);
    const finalSit = autoDetectSituation(cleanedText, uiSit);

    const hard = hardTranslate(cleanedText, fromLang, user_gender, partner_gender);
    if (hard) {
      logToSheetSafe(req, {
        fromLang,
        situation: finalSit,
        chars: cleanedText.length,
        keywords: detectKeywords(cleanedText, finalSit).join(', '),
        orig: String(text || '').substring(0, 160),
        normalized: cleanedText.substring(0, 160),
        trans: hard.substring(0, 160),
        userGender: user_gender || '',
        partnerGender: partner_gender || '',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: 'hard-map',
        estimatedCost: 0,
        clientId: clientId || '',
        sessionId: sessionId || '',
        visitCount: visitCount || '',
        firstSeen: firstSeen || '',
        deviceInfo: deviceInfo || ''
      });

      return res.status(200).json({
        translation: hard,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          model: 'hard-map',
          estimatedCost: 0
        },
        meta: {
          situation: finalSit,
          chars: cleanedText.length,
          hardMap: true
        }
      });
    }

    const vocabHint = buildVocabHint(cleanedText, finalSit, uiSit);

    const systemPrompt = buildSystemPrompt({
      sourceLang,
      targetLang,
      context,
      situationCtx: SITUATION_CONTEXT[finalSit] || SITUATION_CONTEXT[uiSit] || '',
      genderInstruction: buildGenderInstruction(fromLang, user_gender, partner_gender),
      turnHint: buildTurnHint(fromLang, prev_turn),
      topicHint: buildTopicHint(fromLang, last_th),
      historyHint: buildHistoryHint(history),
      vocabHint,
      unclearReply,
      failReply
    });

    const aiResult = await callAnthropic({
      apiKey,
      model,
      system: systemPrompt,
      userContent: `Source language: ${sourceLang}\nTarget language: ${targetLang}\nTranslate this spoken transcript only:\n\n${cleanedText}`,
      maxTokens: chooseMaxTokens(cleanedText),
      temperature: 0
    });

    const translation = sanitizeTranslation(aiResult.text, unclearReply);

    const usage = aiResult.usage || {};
    const inputTokens = Number(usage.input_tokens || usage.inputTokens || 0);
    const outputTokens = Number(usage.output_tokens || usage.outputTokens || 0);
    const totalTokens = inputTokens + outputTokens;
    const estimatedCost = estimateCost(inputTokens, outputTokens);

    console.log('USAGE:', JSON.stringify({
      time: new Date().toISOString(),
      fromLang,
      chars: cleanedText.length,
      situation: finalSit,
      inputTokens,
      outputTokens,
      totalTokens,
      model,
      ip: getCleanIP(req)
    }));

    logToSheetSafe(req, {
      fromLang,
      situation: finalSit,
      chars: cleanedText.length,
      keywords: detectKeywords(cleanedText, finalSit).join(', '),
      orig: String(text || '').substring(0, 160),
      normalized: cleanedText.substring(0, 160),
      trans: translation.substring(0, 160),
      userGender: user_gender || '',
      partnerGender: partner_gender || '',
      inputTokens,
      outputTokens,
      totalTokens,
      model,
      estimatedCost,
      clientId: clientId || '',
      sessionId: sessionId || '',
      visitCount: visitCount || '',
      firstSeen: firstSeen || '',
      deviceInfo: deviceInfo || ''
    });

    return res.status(200).json({
      translation,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens,
        model,
        estimatedCost
      },
      meta: {
        situation: finalSit,
        chars: cleanedText.length
      }
    });
  } catch (err) {
    console.error('TRANSLATE_ERROR:', err?.message || err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ============================================================
// Basic helpers
// ============================================================

function isThaiLang(fromLang) {
  return fromLang === 'th' || fromLang === 'thai' || fromLang === 'TH';
}

function isKoreanLang(fromLang) {
  return fromLang === 'kr' || fromLang === 'ko' || fromLang === 'korean' || fromLang === 'KR' || fromLang === 'KO';
}

function getCleanIP(req) {
  const ipHeader =
    req.headers['x-forwarded-for'] ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown';

  return String(ipHeader).split(',')[0].trim();
}

function thaiEnding(partnerGender) {
  if (partnerGender === 'female') return { polite: 'ค่ะ', question: 'คะ', ack: 'ค่ะ' };
  if (partnerGender === 'male') return { polite: 'ครับ', question: 'ครับ', ack: 'ครับ' };
  return { polite: 'ค่ะ', question: 'คะ', ack: 'ค่ะ' };
}

function buildThaiUnclearReply(partnerGender) {
  const e = thaiEnding(partnerGender);
  return `ฟังไม่ชัด ช่วยพูดอีกครั้งได้ไหม${e.question || 'คะ'}`;
}

function buildThaiFailReply(partnerGender) {
  const e = thaiEnding(partnerGender);
  return `ไม่สามารถแปลได้${e.polite || 'ค่ะ'}`;
}

// ============================================================
// Normalization
// ============================================================

function normalizeAll(input, fromLang) {
  let t = String(input || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  t = normalizeCommonThai(t);
  t = normalizeThaiLoanwords(t);
  t = normalizeKoreanSTT(t);
  t = normalizeCoupangAndOnline(t);
  t = normalizeIsanAndHobby(t);
  t = normalizeHospitalDental(t);
  t = normalizeRepeatedSpeech(t, fromLang);

  return t.trim();
}

function normalizeCommonThai(text) {
  return String(text || '')
    .replace(/ใหมครับ/g, 'ไหมครับ')
    .replace(/ใหมคะ/g, 'ไหมคะ')
    .replace(/ใหมค่ะ/g, 'ไหมคะ')
    .replace(/มัยครับ/g, 'ไหมครับ')
    .replace(/มัยคะ/g, 'ไหมคะ')
    .replace(/หรือปล่าว/g, 'หรือเปล่า')
    .replace(/ป่าว/g, 'หรือเปล่า')
    .replace(/แอลจี/g, 'LG')
    .replace(/เเอลจี/g, 'LG')
    .replace(/เคที/g, 'KT')
    .replace(/เอสเคที/g, 'SKT')
    .replace(/ยู ซิม/g, '유심')
    .replace(/ยูซิม/g, '유심')
    .replace(/ไฟแน้น/g, 'ไฟแนนซ์')
    .replace(/ไฟแนน/g, 'ไฟแนนซ์')
    .replace(/เลขไม/g, 'เลขไมล์')
    .replace(/โรงบาล/g, 'โรงพยาบาล')
    .replace(/โฮงบาล/g, 'โรงพยาบาล')
    .replace(/ใบตรวจสภาพรถ/g, 'ใบตรวจสภาพ')
    .replace(/ใบเช็คสภาพรถ/g, 'ใบตรวจสภาพ');
}

function normalizeThaiLoanwords(text) {
  const pairs = [
    [/ชุล จัง/g, '출장'],
    [/ชุลจัง/g, '출장'],
    [/ชุน จัง/g, '출장'],
    [/ชุนจัง/g, '출장'],
    [/ชู จัง/g, '출장'],
    [/ชูจัง/g, '출장'],
    [/ชุ ลจัง/g, '출장'],

    [/เวกึน/g, '외근'],
    [/เว กึน/g, '외근'],
    [/เวกึนไป/g, '외근ไป'],
    [/โอเวอร์ไทม์/g, 'โอที'],

    [/คีซุกซา/g, '기숙사'],
    [/คี สุก ซา/g, '기숙사'],
    [/กีซุกซา/g, '기숙사'],

    [/ซาจังนิม/g, '사장님'],
    [/ซาจัง/g, '사장님'],
    [/สาจำนี/g, '사장님'],
    [/สจนี/g, '사장님'],
    [/พันจัง/g, '반장님'],
    [/บันจัง/g, '반장님'],

    [/เวกุกอิน/g, '외국인'],
    [/เวกุกคน/g, '외국인'],
    [/ฮเวซา/g, '회사'],
    [/โฮซา/g, '회사']
  ];

  let t = String(text || '');
  for (const [a, b] of pairs) t = t.replace(a, b);
  return t;
}

function normalizeKoreanSTT(text) {
  let t = String(text || '');

  const pairs = [
    // 몇 시에 들어와요 / 돌아와요 / 오세요
    [/마치마치 들어와요/g, '몇 시에 들어와요?'],
    [/마치 들어와요/g, '몇 시에 들어와요?'],
    [/매치 들어와요/g, '몇 시에 들어와요?'],
    [/미지근 들어와요/g, '몇 시에 들어와요?'],
    [/미치근 들어와요/g, '몇 시에 들어와요?'],
    [/미지근마치 들어와요/g, '몇 시에 들어와요?'],
    [/며칠 들어와요/g, '몇 시에 들어와요?'],
    [/며칠간 들어와요/g, '몇 시에 들어와요?'],
    [/며칠 동안 들어와요/g, '몇 시에 들어와요?'],
    [/몇일 들어와요/g, '몇 시에 들어와요?'],
    [/몇일간 들어와요/g, '몇 시에 들어와요?'],

    [/마치마치 돌아와요/g, '몇 시에 돌아와요?'],
    [/마치 돌아와요/g, '몇 시에 돌아와요?'],
    [/매치 돌아와요/g, '몇 시에 돌아와요?'],
    [/미지근 돌아와요/g, '몇 시에 돌아와요?'],
    [/미치근 돌아와요/g, '몇 시에 돌아와요?'],
    [/미지근마치 돌아와요/g, '몇 시에 돌아와요?'],
    [/며칠 돌아와요/g, '몇 시에 돌아와요?'],
    [/며칠간 돌아와요/g, '몇 시에 돌아와요?'],
    [/몇일 돌아와요/g, '몇 시에 돌아와요?'],

    [/마치마치 오세요/g, '몇 시에 오세요?'],
    [/마치 오세요/g, '몇 시에 오세요?'],
    [/매치 오세요/g, '몇 시에 오세요?'],
    [/미지근 오세요/g, '몇 시에 오세요?'],
    [/미치근 오세요/g, '몇 시에 오세요?'],
    [/미지근마치 오세요/g, '몇 시에 오세요?'],
    [/며칠 오세요/g, '몇 시에 오세요?'],
    [/며칠간 오세요/g, '몇 시에 오세요?'],

    [/몇시에/g, '몇 시에'],
    [/몇 시 오세요/g, '몇 시에 오세요?'],
    [/몇 시 들어와요/g, '몇 시에 들어와요?'],
    [/몇 시 돌아와요/g, '몇 시에 돌아와요?'],

    // 어디 / 언제 common STT fragments
    [/어 들었나/g, '들었나요?'],
    [/어디 들었나/g, '어디 들었나요?'],
    [/오디세요/g, '어디에 계세요?'],
    [/어디세요/g, '어디에 계세요?'],
    [/어디 계세요/g, '어디에 계세요?'],
    [/어떻게 하세요/g, '뭐 하세요?'],
    [/어떻게 해요/g, '어떻게 해요?'],
    [/머 하세요/g, '뭐 하세요?'],
    [/머 해요/g, '뭐 해요?'],
    [/머 하는거예요/g, '뭐 하는 거예요?'],
    [/뭐하세요/g, '뭐 하세요?'],

    // work / dorm / company common repeats
    [/기수사/g, '기숙사'],
    [/기수하/g, '기숙사'],
    [/기숙사기숙사/g, '기숙사'],
    [/회사회사/g, '회사'],
    [/사장사장/g, '사장님'],
    [/노동부노동부/g, '노동부'],

    // parcel / phone / app
    [/유심유심/g, '유심'],
    [/배송배송/g, '배송'],
    [/택배택배/g, '택배'],
    [/쿠팡쿠팡/g, '쿠팡'],

    // common food / polite form
    [/감사 하나/g, '감사합니다'],
    [/밥 먹을게요/g, '밥 먹을게요.'],
    [/맛있네/g, '맛있네요.'],

    // Hangul letters / simple
    [/아 디귿 리 미음 비읍 시옷/g, '아, 디귿, 리을, 미음, 비읍, 시옷']
  ];

  for (const [a, b] of pairs) t = t.replace(a, b);

  // Broad Korean STT correction for time questions
  t = t.replace(/(미지근|마치|매치|며칠|몇일|미치근|미지근마치)\s*(들어와요|돌아와요|오세요|와요|끝나요|출발해요|퇴근해요)/g, '몇 시에 $2?');
  t = t.replace(/(어디|오디)\s*(들어왔어요|시작해요|갔어요)/g, '언제 $2?');

  // Common service questions and spacing
  t = t.replace(/뭐\s*하세요/g, '뭐 하세요?');
  t = t.replace(/어디\s*아파요/g, '어디 아파요?');
  t = t.replace(/뭐\s*필요하세요/g, '뭐 필요하세요?');
  t = t.replace(/어디\s*가세요/g, '어디 가세요?');
  t = t.replace(/뭐\s*도와드릴까요/g, '뭐 도와드릴까요?');
  t = t.replace(/왜\s*그래요/g, '왜 그래요?');
  t = t.replace(/이거\s*뭐예요/g, '이거 뭐예요?');
  t = t.replace(/그게\s*무슨말이에요/g, '그게 무슨 말이에요?');
  t = t.replace(/다시\s*말씀해주세요/g, '다시 말씀해 주세요.');
  t = t.replace(/천천히\s*말씀해주세요/g, '천천히 말씀해 주세요.');
  t = t.replace(/잘\s*못들었어요/g, '잘 못 들었어요.');
  t = t.replace(/이해\s*못했어요/g, '이해 못 했어요.');
  t = t.replace(/잠시만\s*기다려주세요/g, '잠시만 기다려 주세요.');
  t = t.replace(/조금만\s*기다려주세요/g, '조금만 기다려 주세요.');
  t = t.replace(/서명\s*해주세요/g, '서명해 주세요.');
  t = t.replace(/싸인\s*해주세요/g, '사인해 주세요.');
  t = t.replace(/여기\s*싸인/g, '여기에 사인해 주세요.');

  // Public office / hospital / payment questions
  t = t.replace(/예약\s*하셨어요/g, '예약하셨어요?');
  t = t.replace(/접수\s*하셨어요/g, '접수하셨어요?');
  t = t.replace(/결제\s*하셨어요/g, '결제하셨어요?');
  t = t.replace(/입금\s*하셨어요/g, '입금하셨어요?');
  t = t.replace(/송금\s*하셨어요/g, '송금하셨어요?');
  t = t.replace(/신분증\s*있어요/g, '신분증 있어요?');
  t = t.replace(/외국인\s*등록증\s*있어요/g, '외국인등록증 있어요?');
  t = t.replace(/여권\s*있어요/g, '여권 있어요?');

  // Phone / SIM
  t = t.replace(/유심\s*개통/g, '유심 개통');
  t = t.replace(/번호\s*바꾸/g, '번호 바꾸');
  t = t.replace(/인증번호\s*안와요/g, '인증번호 안 와요');

  // Food: do not force 맛있어요 into a question; punctuation/context will decide.
  t = t.replace(/맛있어요$/g, '맛있어요.');
  t = t.replace(/배고파요/g, '배고파요.');

  // Airport / immigration / hotel / concert STT normalizations
  t = t.replace(/입국\s*심사/g, '입국심사');
  t = t.replace(/출입국\s*심사/g, '출입국심사');
  t = t.replace(/이차\s*심사/g, '2차 심사');
  t = t.replace(/2차\s*심사실/g, '2차 심사실');
  t = t.replace(/입국\s*목적/g, '입국 목적');
  t = t.replace(/체류\s*기간/g, '체류 기간');
  t = t.replace(/숙소\s*주소/g, '숙소 주소');
  t = t.replace(/왕복\s*항공권/g, '왕복 항공권');
  t = t.replace(/귀국\s*항공권/g, '귀국 항공권');
  t = t.replace(/여행\s*일정/g, '여행 일정');
  t = t.replace(/예약\s*확인서/g, '예약 확인서');
  t = t.replace(/입국\s*거부/g, '입국 거부');
  t = t.replace(/입국\s*불허/g, '입국 불허');
  t = t.replace(/강제\s*송환/g, '강제송환');
  t = t.replace(/호텔\s*예약/g, '호텔 예약');
  t = t.replace(/체크\s*인/g, '체크인');
  t = t.replace(/체크\s*아웃/g, '체크아웃');
  t = t.replace(/항공\s*편/g, '항공편');
  t = t.replace(/탑승\s*구/g, '탑승구');
  t = t.replace(/수하물\s*찾기/g, '수하물 찾기');
  t = t.replace(/콘서트\s*티켓/g, '콘서트 티켓');
  t = t.replace(/팬\s*미팅/g, '팬미팅');
  t = t.replace(/응원\s*봉/g, '응원봉');
  t = t.replace(/포토\s*카드/g, '포토카드');
  t = t.replace(/택스\s*리펀드/g, '택스리펀드');

  return t;
}

function normalizeCoupangAndOnline(text) {
  let t = String(text || '');

  const pairs = [
    [/คู พัง/g, 'คู팡'],
    [/คูพัง/g, 'คู팡'],
    [/กู พัง/g, 'คู팡'],
    [/กูพัง/g, 'คู팡'],
    [/คู ปัง/g, 'คู팡'],
    [/คูปัง/g, 'คู팡'],
    [/คู ปอง/g, 'คู팡'],
    [/คูปอง/g, 'คู팡'],

    [/ของ ผม พัง/g, 'ของผมพัง'],
    [/ของ ฉัน พัง/g, 'ของฉันพัง'],
    [/ของ หนู พัง/g, 'ของหนูพัง'],
    [/สินค้า พัง/g, 'สินค้าพัง'],
    [/ของ แตก/g, 'ของแตก'],
    [/สินค้า แตก/g, 'สินค้าแตก'],
    [/ของ ชำรุด/g, 'ของชำรุด'],
    [/สินค้า ชำรุด/g, 'สินค้าชำรุด'],

    [/สั่ง ของ/g, 'สั่งของ'],
    [/ซื้อ ของ ออนไลน์/g, 'ซื้อของออนไลน์'],
    [/ซื้อ ออนไลน์/g, 'ซื้อออนไลน์'],
    [/ตาม พัสดุ/g, 'ตามพัสดุ'],
    [/ตาม ของ/g, 'ตามของ'],
    [/ส่ง พัสดุ/g, 'ส่งพัสดุ'],
    [/รับ พัสดุ/g, 'รับพัสดุ'],
    [/เลข พัสดุ/g, 'เลขพัสดุ'],
    [/เลข แทรค/g, 'เลขแทร็ก'],
    [/เลข แทร็ก/g, 'เลขแทร็ก'],
    [/เช็ค พัสดุ/g, 'เช็คพัสดุ'],
    [/พัสดุ จัดส่งแล้ว/g, 'พัสดุจัดส่งแล้ว'],
    [/จัด ส่ง แล้ว/g, 'จัดส่งแล้ว'],
    [/ไม่ เห็น พัสดุ/g, 'ไม่เห็นพัสดุ'],
    [/ไม่ เห็น ของ/g, 'ไม่เห็นของ'],
    [/หน้า ห้อง/g, 'หน้าห้อง'],
    [/หน้า ประตู/g, 'หน้าประตู'],
    [/คืน ของ/g, 'คืนสินค้า'],
    [/คืน สินค้า/g, 'คืนสินค้า'],
    [/เปลี่ยน สินค้า/g, 'เปลี่ยนสินค้า'],
    [/ของ ไม่ ตรง ปก/g, 'ของไม่ตรงปก'],
    [/ยก เลิก ออเดอร์/g, 'ยกเลิกออเดอร์'],
    [/เก็บ เงิน ปลาย ทาง/g, 'เก็บเงินปลายทาง'],
    [/ชำระ เงิน/g, 'ชำระเงิน']
  ];

  for (const [a, b] of pairs) t = t.replace(a, b);
  return t;
}

function normalizeIsanAndHobby(text) {
  let t = String(text || '');

  const pairs = [
    [/10\s*เบ็ด/g, 'ซิดเบ็ด'],
    [/สิบ\s*เบ็ด/g, 'ซิดเบ็ด'],
    [/ซิส\s*เบ็ด/g, 'ซิดเบ็ด'],
    [/สิด\s*เบ็ด/g, 'ซิดเบ็ด'],
    [/สิท\s*เบ็ด/g, 'ซิดเบ็ด'],
    [/ชิด\s*เบ็ด/g, 'ซิดเบ็ด'],
    [/ชิด\s*เบส/g, 'ซิดเบ็ด'],
    [/ซิสเบ็ด/g, 'ซิดเบ็ด'],
    [/สิดเบ็ด/g, 'ซิดเบ็ด'],
    [/สิทเบ็ด/g, 'ซิดเบ็ด'],
    [/ชิดเบ็ด/g, 'ซิดเบ็ด'],
    [/ชิดเบส/g, 'ซิดเบ็ด'],

    [/ไส้ เดือน/g, 'ไส้เดือน'],
    [/ขี้ กะ เดียน/g, 'ขี้กะเดียน'],
    [/ขี้ กะ เดี้ย/g, 'ขี้กะเดี้ย'],
    [/ขี้ ไก่ เดียน/g, 'ขี้ไก่เดียน'],
    [/ขี้ ไก่ เดี้ย/g, 'ขี้ไก่เดี้ย'],
    [/ส่อน กุ้ง/g, 'ส่อนกุ้ง'],
    [/ช้อน กุ้ง/g, 'ส่อนกุ้ง'],
    [/ซ่อน กุ้ง/g, 'ส่อนกุ้ง'],

    [/มื้อ นี่/g, 'มื้อนี้'],
    [/มื้อ นี้/g, 'มื้อนี้'],
    [/มื้อ อื่น/g, 'มื้ออื่น'],
    [/มื้อ วาน/g, 'มื้อวาน'],
    [/บ้าน งาน/g, 'บ้านงาน'],
    [/กิน ดอง/g, 'กินดอง'],

    [/ก้อย เนื้อ/g, 'ก้อยเนื้อ'],
    [/ก้อย กุ้ง/g, 'ก้อยกุ้ง'],
    [/ปลา ร้า/g, 'ปลาร้า'],
    [/ปลา แดก/g, 'ปลาแดก'],
    [/ตำ บัก หุ่ง/g, 'ตำบักหุ่ง'],
    [/ปลาร้า บอง/g, 'ปลาร้าบอง'],
    [/แจ่ว บอง/g, 'แจ่วบอง'],

    [/ห้วย หนอง คลอง บึง/g, 'ห้วยหนองคลองบึง'],
    [/หนอง น้ำ/g, 'หนองน้ำ'],
    [/ไป ใส่ เบ็ด/g, 'ไปใส่เบ็ด'],
    [/ใส่ เบ็ด/g, 'ใส่เบ็ด']
  ];

  for (const [a, b] of pairs) t = t.replace(a, b);
  return t;
}

function normalizeHospitalDental(text) {
  let t = String(text || '');

  const pairs = [
    [/ฟันคุดของฉันอยู่ใกล้เส้นประสาท/g, 'ฟันคุดฉันใกล้กับเส้นประสาท'],
    [/ฟันคุดของผมอยู่ใกล้เส้นประสาท/g, 'ฟันคุดฉันใกล้กับเส้นประสาท'],
    [/ฟันคุดผมอยู่ใกล้เส้นประสาท/g, 'ฟันคุดฉันใกล้กับเส้นประสาท'],
    [/ฟัน คุด/g, 'ฟันคุด'],
    [/ถอน ฟันคุด/g, 'ถอนฟันคุด'],
    [/ผ่า ฟันคุด/g, 'ผ่าฟันคุด'],
    [/เส้น ประสาท/g, 'เส้นประสาท'],
    [/ไก่กับเส้นประสาท/g, 'ใกล้กับเส้นประสาท'],

    [/เป็น หนอง/g, 'เป็นหนอง'],
    [/มี หนอง/g, 'มีหนอง'],
    [/แผล เป็นหนอง/g, 'แผลเป็นหนอง']
  ];

  for (const [a, b] of pairs) t = t.replace(a, b);
  return t;
}

function normalizeRepeatedSpeech(text, fromLang) {
  let t = String(text || '').trim();

  t = t.replace(/(.{3,40})\1{3,}/g, '$1');
  t = t.replace(/(ครับ|ค่ะ|คะ)\s*\1\s*\1/g, '$1');

  const koreanRepeatWords = [
    '네',
    '예',
    '아니요',
    '맞아요',
    '그래요',
    '그럼',
    '그러니까',
    '다른',
    '지금',
    '오늘',
    '내일',
    '제가',
    '저는',
    '물건',
    '수업',
    '기숙사',
    '똑같아',
    '길이',
    '사람',
    '아침',
    '회사',
    '예약',
    '인천',
    '문제',
    '노동부',
    '택배',
    '배송',
    '유심',
    '쿠팡'
  ];

  for (const w of koreanRepeatWords) {
    const re = new RegExp(`(${escapeRegExp(w)})\\1+`, 'g');
    t = t.replace(re, w);
  }

  t = t.replace(/\b(네|예|아니요|맞아요|그래요|그럼|그러니까)\s+\1\s+\1\s*/g, '$1 ');
  t = t.replace(/\b(다른|지금|오늘|내일|제가|저는|수업|기숙사|물건|회사|택배|유심)\s+\1\s+\1\s*/g, '$1 ');
  t = t.replace(/([가-힣]{2,8})\1{2,}/g, '$1');

  return t.trim();
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addQuestionMarksLight(text, fromLang) {
  const t = String(text || '').trim();
  if (!t) return t;
  if (/[?？]$/.test(t)) return t;

  if (isThaiLang(fromLang)) {
    const thaiQuestion =
      /(ไหม|มั้ย|หรือเปล่า|หรือไม่|เหรอ|หรอ|บ่|บ่หึ|บ่ฮึ|บ่หือ|บ่ฮือ|บ่หื|บ่ฮื|บ่ติ|บ่ตี้|บ่เบาะ|บ่น้อ|บ่เนาะ|บ่หนอ|บ่หนา|บ่ล่ะ|บ่ละ|เบาะ|บ้อ|บ๋อ|แม่นบ่|ได้ไหม|ได้บ่|อะไร|ใคร|ที่ไหน|อยู่ไส|ไปไส|เท่าไหร่|เท่าไร|กี่โมง|เมื่อไหร่|ยามใด๋|ยามได๋|ยังไง|อย่างไร|ทำไม)(ครับ|ค่ะ|คะ|เด้อ|เนาะ|น้อ|น้า)?$/;

    if (thaiQuestion.test(t)) return `${t}?`;
  } else {
    const koreanQuestion =
      /(까요|니까|나요|어요|예요|이에요|있어요|없어요|어때요|뭐예요|누구예요|어디예요|얼마예요|오세요|들어와요|돌아와요|가요|되나요|될까요)\??$/;

    if (koreanQuestion.test(t)) return `${t}?`;
  }

  return t;
}

// ============================================================
// Hard translate rules
// ============================================================

function hardTranslate(text, fromLang, userGender, partnerGender) {
  const raw = String(text || '').trim();

  const compact = raw
    .replace(/\s+/g, '')
    .replace(/[?？。.!！,，]/g, '')
    .trim();

  if (!isThaiLang(fromLang)) {
    return hardKoreanToThai(raw, compact, partnerGender);
  }

  return hardThaiToKorean(raw, compact);
}

function hardKoreanToThai(raw, compact, partnerGender) {
  const e = thaiEnding(partnerGender);
  const polite = e.polite || '';
  const question = e.question || '';
  const ack = e.ack || polite || 'ค่ะ';

  // ============================================================
  // Time / coming / entering / returning
  // ============================================================

  if (compact === '몇시에들어와요') return `จะเข้ามากี่โมง${question}`;
  if (compact === '몇시에오세요') return `จะมากี่โมง${question}`;
  if (compact === '몇시에돌아와요') return `จะกลับมากี่โมง${question}`;
  if (compact === '몇시에와요') return `จะมากี่โมง${question}`;
  if (compact === '몇시에출발해요') return `ออกเดินทางกี่โมง${question}`;
  if (compact === '몇시에끝나요') return `เสร็จกี่โมง${question}`;
  if (compact === '몇시에퇴근해요') return `เลิกงานกี่โมง${question}`;

  if (/몇시.*들어와요/.test(compact)) return `จะเข้ามากี่โมง${question}`;
  if (/몇시.*돌아와요/.test(compact)) return `จะกลับมากี่โมง${question}`;
  if (/몇시.*오세요/.test(compact) || /몇시.*와요/.test(compact)) return `จะมากี่โมง${question}`;
  if (/몇시.*출발/.test(compact)) return `ออกเดินทางกี่โมง${question}`;
  if (/몇시.*끝나요/.test(compact)) return `เสร็จกี่โมง${question}`;
  if (/몇시.*퇴근/.test(compact)) return `เลิกงานกี่โมง${question}`;

  if (compact === '언제와요' || compact === '언제오세요') return `จะมาเมื่อไหร่${question}`;
  if (compact === '언제들어와요') return `จะเข้ามาเมื่อไหร่${question}`;
  if (compact === '언제돌아와요') return `จะกลับมาเมื่อไหร่${question}`;
  if (compact === '언제끝나요') return `จะเสร็จเมื่อไหร่${question}`;
  if (compact === '언제출발해요') return `จะออกเดินทางเมื่อไหร่${question}`;

  if (compact === '지금어디있어요' || compact === '지금어디있어') return `ตอนนี้อยู่ที่ไหน${question}`;
  if (compact === '어디있어요' || compact === '어디있어') return `อยู่ที่ไหน${question}`;
  if (compact === '어디가요' || compact === '어디가세요') return `ไปไหน${question}`;
  if (compact === '어디로가요' || compact === '어디로가세요') return `ไปทางไหน${question}`;

  // ============================================================
  // 출장 / 외근
  // ============================================================

  if (compact === '출장') return 'ไปทำงานนอกสถานที่';

  if (/출장/.test(compact)) {
    if (/오늘/.test(compact)) return 'วันนี้ไปทำงานนอกสถานที่';
    if (/내일/.test(compact)) return 'พรุ่งนี้ไปทำงานนอกสถานที่';
    if (/어제/.test(compact)) return 'เมื่อวานไปทำงานนอกสถานที่';
    if (/가요|갑니다|갈거예요|갈거에요|간다/.test(compact)) return 'ไปทำงานนอกสถานที่';
    if (/갔다|다녀왔|왔어요/.test(compact)) return 'ไปทำงานนอกสถานที่มาแล้ว';
    if (/중/.test(compact)) return 'กำลังไปทำงานนอกสถานที่';
    return 'ไปทำงานนอกสถานที่';
  }

  if (compact === '외근') return 'ออกไปทำงานนอกสถานที่';

  if (/외근/.test(compact)) {
    if (/오늘/.test(compact)) return 'วันนี้ออกไปทำงานนอกสถานที่';
    if (/내일/.test(compact)) return 'พรุ่งนี้ออกไปทำงานนอกสถานที่';
    if (/어제/.test(compact)) return 'เมื่อวานออกไปทำงานนอกสถานที่';
    if (/갔다|다녀왔|왔어요/.test(compact)) return 'ออกไปทำงานนอกสถานที่มาแล้ว';
    return 'ออกไปทำงานนอกสถานที่';
  }

  // ============================================================
  // Work / company / job
  // ============================================================

  const workMap = {
    '출근했어요': `ไปทำงานแล้ว${polite}`,
    '출근하세요': `ไปทำงานนะ${polite}`,
    '출근해요': `ไปทำงาน${polite}`,
    '퇴근했어요': `เลิกงานแล้ว${polite}`,
    '퇴근하세요': `เลิกงานได้เลย${polite}`,
    '퇴근해요': `เลิกงาน${polite}`,
    '일하세요': `ทำงานนะ${polite}`,
    '일해요': `ทำงาน${polite}`,
    '일끝났어요': `งานเสร็จแล้ว${polite}`,
    '끝났어요': `เสร็จแล้ว${polite}`,
    '다끝났어요': `เสร็จหมดแล้ว${polite}`,
    '빨리하세요': `รีบทำหน่อย${polite}`,
    '천천히하세요': `ค่อย ๆ ทำ${polite}`,
    '조심하세요': `ระวังนะ${polite}`,
    '기다리세요': `รอก่อนนะ${polite}`,
    '잠깐만요': `รอสักครู่${polite}`,
    '괜찮아요': `ไม่เป็นไร${polite}`,
    '안돼요': `ไม่ได้${polite}`,
    '돼요': `ได้${polite}`,
    '알겠어요': `เข้าใจแล้ว${polite}`,
    '몰라요': `ไม่รู้${polite}`,
    '모르겠어요': `ไม่แน่ใจ${polite}`,
    '질문있습니까': `มีคำถามไหม${question}`,
    '없습니다': `ไม่มี${polite}`,
    '있습니다': `มี${polite}`,
    '사장님': 'เถ้าแก่ / นายจ้าง',
    '반장님': 'หัวหน้างาน',
    '회사': 'บริษัท',
    '공장': 'โรงงาน',
    '기숙사': 'หอพัก',
    '노동부': 'กระทรวงแรงงาน',
    '월급': 'เงินเดือน',
    '급여명세서': 'สลิปเงินเดือน',
    '근로계약서': 'สัญญาจ้างงาน',
    '퇴직금': 'เงินเกษียณ / เงินแทจิก',
    '국민연금': 'เงินกุกมิน / 국민연금'
  };

  if (workMap[compact]) return workMap[compact];

  if (/일.*안할거예요/.test(compact)) return `จะไม่ทำงาน${polite}`;
  if (/일.*할거예요/.test(compact)) return `จะทำงาน${polite}`;
  if (/일.*할수있어요/.test(compact)) return `ทำงานได้${polite}`;
  if (/일.*못해요/.test(compact)) return `ทำงานไม่ได้${polite}`;
  if (/새로운사람.*오면/.test(compact)) return `ถ้าคนใหม่มา${polite}`;
  if (/새로운직원.*오면/.test(compact)) return `ถ้าพนักงานใหม่มา${polite}`;
  if (/태국사람.*받아요/.test(compact)) return `รับคนไทยไหม${question}`;
  if (/월급.*언제/.test(compact)) return `เงินเดือนออกเมื่อไหร่${question}`;
  if (/계약.*끝/.test(compact)) return `สัญญาหมดแล้ว${polite}`;
  if (/계약.*연장/.test(compact)) return `ต่อสัญญา${polite}`;

  // ============================================================
  // Dorm / housing / moving / address
  // ============================================================

  if (/기숙사.*오늘.*들어갈수있어/.test(compact)) return `วันนี้เข้าหอพักได้ไหม${question}`;
  if (/기숙사.*들어갈수있어요/.test(compact)) return `เข้าหอพักได้ไหม${question}`;
  if (/기숙사.*어디/.test(compact)) return `หอพักอยู่ที่ไหน${question}`;
  if (/방.*있어요/.test(compact)) return `มีห้องไหม${question}`;
  if (/월세.*얼마/.test(compact)) return `ค่าเช่าเท่าไหร่${question}`;
  if (/보증금.*얼마/.test(compact)) return `เงินมัดจำเท่าไหร่${question}`;
  if (/주소.*주세요/.test(compact)) return `ขอที่อยู่หน่อย${polite}`;
  if (/주소.*알려주세요/.test(compact)) return `ช่วยบอกที่อยู่หน่อย${polite}`;
  if (/짐.*가지러/.test(compact)) return `ไปเอาของ / ไปเก็บของ${polite}`;
  if (/천안.*가지러/.test(compact)) return `ต้องไปเอาของที่ชอนอาน${polite}`;

  // ============================================================
  // Phone / SIM / payment / bank
  // ============================================================

  if (compact === '유심') return 'ซิมการ์ด';
  if (/유심.*말씀하시는거죠/.test(compact)) return `พูดถึงซิมการ์ดใช่ไหม${question}`;
  if (/유심.*있어요/.test(compact)) return `มีซิมการ์ดไหม${question}`;
  if (/얼마예요/.test(compact) && /유심|요금|가격/.test(compact)) return `ราคาเท่าไหร่${question}`;
  if (/한달.*얼마/.test(compact)) return `เดือนละเท่าไหร่${question}`;
  if (/자동이체/.test(compact)) return 'หักเงินอัตโนมัติจากบัญชี';
  if (/계좌.*빠져요/.test(compact)) return `หักจากบัญชี${polite}`;
  if (/미납/.test(compact)) return 'ยอดค้างชำระ';
  if (/인증번호/.test(compact)) return 'รหัสยืนยัน';
  if (/전화번호/.test(compact)) return 'เบอร์โทรศัพท์';
  if (/통신사/.test(compact)) return 'เครือข่ายมือถือ / บริษัทมือถือ';

  // ============================================================
  // Online / parcel / delivery
  // ============================================================

  if (compact === '택배') return 'พัสดุ';
  if (compact === '배송') return 'การจัดส่ง';
  if (compact === '쿠팡') return 'คู팡 / Coupang';
  if (/택배.*안보여요/.test(compact)) return `ไม่เห็นพัสดุ${polite}`;
  if (/문앞.*없어요/.test(compact) || /현관앞.*없어요/.test(compact)) return `ไม่เห็นของที่หน้าประตู${polite}`;
  if (/배송완료/.test(compact) && /안보여/.test(compact)) return `ขึ้นว่าส่งเสร็จแล้ว แต่ไม่เห็นพัสดุ${polite}`;
  if (/운송장번호/.test(compact) || /송장번호/.test(compact)) return 'เลขพัสดุ / เลขแทร็ก';
  if (/환불/.test(compact)) return 'คืนเงิน';
  if (/반품/.test(compact)) return 'คืนสินค้า';
  if (/교환/.test(compact)) return 'เปลี่ยนสินค้า';
  if (/불량/.test(compact)) return 'สินค้าเสีย / สินค้าชำรุด';
  if (/파손/.test(compact)) return 'สินค้าแตก / สินค้าเสียหาย';
  if (/잘못배송/.test(compact) || /오배송/.test(compact)) return 'ส่งสินค้าผิด';

  // ============================================================
  // Hospital / dental / beauty
  // ============================================================

  if (compact === '아파요') return `เจ็บ / ปวด${polite}`;
  if (/머리.*아파/.test(compact)) return `ปวดหัว${polite}`;
  if (/배.*아파/.test(compact)) return `ปวดท้อง${polite}`;
  if (/허리.*아파/.test(compact)) return `ปวดหลัง${polite}`;
  if (/무릎.*아파/.test(compact)) return `เจ็บเข่า${polite}`;
  if (/치아.*아파|이.*아파/.test(compact)) return `ปวดฟัน${polite}`;
  if (/사랑니.*신경/.test(compact)) return `ฟันคุดอยู่ใกล้เส้นประสาท${polite}`;
  if (/사랑니.*발치.*가능/.test(compact)) return `ฟันคุดถอนได้ไหม${question}`;
  if (/발치.*얼마/.test(compact)) return `ค่าถอนฟันเท่าไหร่${question}`;
  if (/고름/.test(compact)) return `เป็นหนอง${polite}`;
  if (/알레르기/.test(compact)) return `ภูมิแพ้${polite}`;
  if (/처방전/.test(compact)) return 'ใบสั่งยา';
  if (/진단서/.test(compact)) return 'ใบรับรองแพทย์';
  if (/약국/.test(compact)) return 'ร้านขายยา';
  if (/쌍수|쌍꺼풀/.test(compact)) return 'ทำตาสองชั้น';
  if (/보톡스/.test(compact)) return 'โบท็อกซ์';
  if (/필러/.test(compact)) return 'ฟิลเลอร์';

  // ============================================================
  // School / class / study
  // ============================================================

  if (/수업.*있어요/.test(compact)) return `มีเรียนไหม${question}`;
  if (/수업.*끝났어요/.test(compact)) return `เรียนเสร็จแล้ว${polite}`;
  if (/다른수업/.test(compact)) return `คลาสเรียนอื่น${polite}`;
  if (/학원.*다녀왔어요/.test(compact)) return `ไปเรียนพิเศษมาแล้ว${polite}`;
  if (/한국말.*잘해/.test(compact)) return `พูดภาษาเกาหลีเก่ง${polite}`;
  if (/영어수업/.test(compact)) return 'คลาสภาษาอังกฤษ';

  // ============================================================
  // Food / daily
  // ============================================================

  if ((compact === '밥먹었어' || compact === '밥먹었어요') && raw.includes('?')) return `กินข้าวแล้วหรือยัง${question}`;
  if (compact === '밥먹었어' || compact === '밥먹었어요') return `กินข้าวแล้ว${polite}`;
  if (/밥.*먹었/.test(compact) && raw.includes('?')) return `กินข้าวแล้วหรือยัง${question}`;
  if (/밥.*먹었/.test(compact)) return `กินข้าวแล้ว${polite}`;
  if (/맛있어요/.test(compact) && raw.includes('?')) return `อร่อยไหม${question}`;
  if (/맛있어요/.test(compact)) return `อร่อย${polite}`;
  if (/맛있다|맛있네|맛있겠다/.test(compact)) return `น่าอร่อย${polite}`;
  if (/떡볶이/.test(compact)) return 'ต็อกบกกี';
  if (/김치/.test(compact)) return 'กิมจิ';
  if (/갈비탕/.test(compact)) return 'คัลบีทัง / ซุปซี่โครงเนื้อ';

  // ============================================================
  // Massage / boundary / harassment / pharmacy quick Korean -> Thai
  // ============================================================

  if (/특별서비스.*있어요/.test(compact) || /특별서비스.*돼요/.test(compact)) return `มีบริการพิเศษไหม${question}`;
  if (/2차.*가능/.test(compact) || compact === '2차돼요' || compact === '2차가능해요') return `ไปต่อหรือมีบริการต่อได้ไหม${question}`;
  if (/추가요금.*돼요/.test(compact) || /얼마더주면돼요/.test(compact)) return `ถ้าเพิ่มเงินได้ไหม${question}`;
  if (/만져도돼요/.test(compact)) return `จับได้ไหม${question}`;
  if (/손잡아도돼요/.test(compact)) return `จับมือได้ไหม${question}`;
  if (/연락처.*주세요/.test(compact)) return `ขอเบอร์ติดต่อหน่อย${polite}`;
  if (/술한잔.*할래요/.test(compact)) return `ไปดื่มด้วยกันไหม${question}`;
  if (/개인적으로.*만날수있어요/.test(compact)) return `เจอกันส่วนตัวได้ไหม${question}`;
  if (/직원.*만지지마세요/.test(compact) || /만지지말아주세요/.test(compact)) return `กรุณาอย่าแตะตัวพนักงาน${polite}`;
  if (/성적인서비스.*제공하지않습니다/.test(compact)) return `ไม่มีบริการทางเพศ${polite}`;
  if (/건강마사지.*제공/.test(compact)) return `ที่นี่ให้บริการนวดเพื่อสุขภาพเท่านั้น${polite}`;
  if (/성희롱/.test(compact)) return `การล่วงละเมิดทางเพศ${polite}`;

  if (/사후피임약|응급피임약/.test(compact)) return `ยาคุมฉุกเฉิน${polite}`;
  if (/피임약/.test(compact) && !/사후|응급/.test(compact)) return `ยาคุมกำเนิด${polite}`;
  if (/콘돔/.test(compact)) return `ถุงยางอนามัย${polite}`;
  if (/임신테스트기/.test(compact)) return `ที่ตรวจครรภ์${polite}`;
  if (/생리통/.test(compact)) return `ปวดท้องประจำเดือน${polite}`;
  if (/생리/.test(compact)) return `ประจำเดือน${polite}`;
  if (/처방전.*필요/.test(compact)) return `ต้องใช้ใบสั่งยา${polite}`;
  if (/약국.*어디/.test(compact)) return `ร้านขายยาอยู่ที่ไหน${question}`;

  // ============================================================
  // Common short Korean
  // ============================================================

  // ============================================================
  // Korean short responses / greetings / service acknowledgements
  // ============================================================

  if (/^(네|예)안녕하세요$/.test(compact)) return `${ack} สวัสดี${polite}`;
  if (/^(네|예)안녕하십니까$/.test(compact)) return `${ack} สวัสดี${polite}`;
  if (/^(네|예)반갑습니다$/.test(compact)) return `${ack} ยินดีที่ได้รู้จัก${polite}`;
  if (/^(네|예)처음뵙겠습니다$/.test(compact)) return `${ack} ยินดีที่ได้รู้จัก${polite}`;
  if (/^(네|예)감사합니다$/.test(compact)) return `${ack} ขอบคุณ${polite}`;
  if (/^(네|예)알겠습니다$/.test(compact)) return `${ack} เข้าใจแล้ว${polite}`;
  if (/^(네|예)맞아요$/.test(compact)) return `${ack} ถูกต้อง${polite}`;
  if (/^(네|예)괜찮아요$/.test(compact)) return `${ack} ไม่เป็นไร${polite}`;
  if (/^(네|예)잠시만요$/.test(compact)) return `${ack} รอสักครู่${polite}`;
  if (/^(네|예)잠깐만요$/.test(compact)) return `${ack} รอสักครู่${polite}`;
  if (/^(아)?그래요$/.test(compact) && raw.includes('?')) return `อย่างนั้นเหรอ${question}`;
  if (/^아그래요$/.test(compact)) return `อ๋อ อย่างนั้นเหรอ${question}`;
  if (/^아그렇군요$/.test(compact)) return `อ๋อ เข้าใจแล้ว${polite}`;
  if (/^그렇군요$/.test(compact)) return `เข้าใจแล้ว${polite}`;
  if (/^됐어요$/.test(compact) && /(안해도|그만|괜찮)/.test(raw)) return `ไม่ต้องแล้ว${polite}`;

  // Public office / hospital / service desk common hard maps
  if (/번호표.*뽑/.test(compact)) return `กดบัตรคิวก่อน${polite}`;
  if (/신청서.*작성/.test(compact)) return `กรุณากรอกแบบฟอร์ม${polite}`;
  if (/신분증.*보여/.test(compact)) return `ขอดูบัตรประจำตัว${polite}`;
  if (/외국인등록증.*있/.test(compact)) return `มีบัตรต่างด้าวไหม${question}`;
  if (/여기.*서명/.test(compact) || /여기.*사인/.test(compact)) return `กรุณาเซ็นตรงนี้${polite}`;
  if (/서류.*부족/.test(compact)) return `เอกสารยังไม่ครบ${polite}`;
  if (/원본.*필요/.test(compact)) return `ต้องใช้ตัวจริง${polite}`;
  if (/사본.*가져오/.test(compact)) return `เอาสำเนามาด้วย${polite}`;

  // Police / accident
  if (/경찰.*신고/.test(compact)) return `แจ้งตำรวจ${polite}`;
  if (/신고.*싶/.test(compact)) return `อยากแจ้งความ${polite}`;
  if (/신고접수증.*받/.test(compact)) return `ขอใบรับแจ้งความได้ไหม${question}`;
  if (/교통사고.*났/.test(compact)) return `เกิดอุบัติเหตุรถชน${polite}`;
  if (/상대방.*도망/.test(compact)) return `คู่กรณีหนีไป${polite}`;
  if (/블랙박스.*있/.test(compact)) return `มีกล้องหน้ารถ${polite}`;
  if (/보험처리.*싶/.test(compact)) return `อยากให้ประกันจัดการ${polite}`;

  // Post office / customs
  if (/태국.*택배.*보내/.test(compact)) return `อยากส่งพัสดุกลับไทย${polite}`;
  if (/태국.*보낼수있/.test(compact)) return `อันนี้ส่งไปไทยได้ไหม${question}`;
  if (/배송비.*얼마/.test(compact)) return `ค่าส่งเท่าไหร่${question}`;
  if (/며칠.*걸/.test(compact)) return `ใช้เวลากี่วัน${question}`;
  if (/세관.*걸렸/.test(compact)) return `ติดศุลกากร${polite}`;
  if (/금지품목/.test(compact)) return `เป็นของต้องห้าม${polite}`;

  // Airport immigration / secondary inspection / hotel / concert / tourism
  if (/입국심사/.test(compact)) return `ตรวจคนเข้าเมือง${polite}`;
  if (/입국목적.*뭐|왜.*왔/.test(compact)) return `จุดประสงค์ในการเข้าประเทศคืออะไร${question}`;
  if (/체류기간.*얼마|얼마나.*머무/.test(compact)) return `จะอยู่กี่วัน${question}`;
  if (/숙소주소.*있|호텔예약.*있/.test(compact)) return `มีที่อยู่ที่พักหรือใบจองโรงแรมไหม${question}`;
  if (/호텔예약확인서.*보여|예약확인서.*보여/.test(compact)) return `ขอดูใบจองโรงแรม${polite}`;
  if (/왕복항공권|귀국항공권/.test(compact)) return `ตั๋วเครื่องบินขากลับ${polite}`;
  if (/2차심사|별도심사|조사실/.test(compact)) return `ต้องไปห้องตรวจสอบเพิ่มเติมของ ตม.${polite}`;
  if (/입국거부|입국불허/.test(compact)) return `ถูกปฏิเสธการเข้าประเทศ${polite}`;
  if (/강제송환/.test(compact)) return `ถูกส่งตัวกลับประเทศ${polite}`;
  if (/체크인.*하/.test(compact) && /호텔|객실|예약/.test(compact)) return `เช็กอินโรงแรม${polite}`;
  if (/체크아웃.*하/.test(compact)) return `เช็กเอาต์${polite}`;
  if (/짐.*보관/.test(compact)) return `ฝากกระเป๋าได้ไหม${question}`;
  if (/방.*바꿔/.test(compact)) return `ขอเปลี่ยนห้อง${polite}`;
  if (/따뜻한물.*안나/.test(compact)) return `น้ำอุ่นไม่ออก${polite}`;
  if (/항공편.*지연|비행기.*지연/.test(compact)) return `เที่ยวบินดีเลย์${polite}`;
  if (/항공편.*취소|비행기.*취소/.test(compact)) return `เที่ยวบินถูกยกเลิก${polite}`;
  if (/수하물.*없|캐리어.*없/.test(compact)) return `กระเป๋าเดินทางหาย${polite}`;
  if (/탑승구.*어디/.test(compact)) return `ประตูขึ้นเครื่องอยู่ที่ไหน${question}`;
  // Preserve K-pop artist/group name in Korean -> Thai concert context.
  if (/블랙핑크.*콘서트.*보러|블랙핑크.*보러/.test(compact)) return `มาดูคอนเสิร์ต BLACKPINK${polite}`;
  if (/(BTS|방탄소년단|방탄).*콘서트.*보러|(BTS|방탄소년단|방탄).*보러/.test(compact)) return `มาดูคอนเสิร์ต BTS${polite}`;
  if (/트와이스.*콘서트.*보러|트와이스.*보러/.test(compact)) return `มาดูคอนเสิร์ต TWICE${polite}`;
  if (/세븐틴.*콘서트.*보러|세븐틴.*보러/.test(compact)) return `มาดูคอนเสิร์ต SEVENTEEN${polite}`;
  if (/스트레이키즈.*콘서트.*보러|스트레이키즈.*보러|스트레이 키즈.*보러/.test(raw + compact)) return `มาดูคอนเสิร์ต Stray Kids${polite}`;
  if (/뉴진스.*콘서트.*보러|뉴진스.*보러/.test(compact)) return `มาดูคอนเสิร์ต NewJeans${polite}`;
  if (/에스파.*콘서트.*보러|에스파.*보러/.test(compact)) return `มาดูคอนเสิร์ต aespa${polite}`;
  if (/아이브.*콘서트.*보러|아이브.*보러/.test(compact)) return `มาดูคอนเสิร์ต IVE${polite}`;
  if (/르세라핌.*콘서트.*보러|르세라핌.*보러/.test(compact)) return `มาดูคอนเสิร์ต LE SSERAFIM${polite}`;
  if (/콘서트.*보러/.test(compact)) return `มาดูคอนเสิร์ต${polite}`;
  if (/콘서트.*티켓|티켓.*있/.test(compact)) return `มีบัตรคอนเสิร์ตไหม${question}`;
  if (/사진.*찍어도돼/.test(compact)) return `ถ่ายรูปได้ไหม${question}`;
  if (/영상촬영.*금지|촬영금지/.test(compact)) return `ห้ามถ่ายวิดีโอ${polite}`;
  if (/응원봉/.test(compact)) return `แท่งไฟ${polite}`;
  if (/굿즈/.test(compact)) return `กู๊ดส์ / สินค้าไอดอล${polite}`;
  if (/택스리펀드.*가능|세금환급.*가능/.test(compact)) return `ทำ Tax refund ได้ไหม${question}`;
  if (/여권.*필요/.test(compact) && /택스리펀드|면세|환급/.test(compact)) return `ต้องใช้พาสปอร์ตไหม${question}`;
  if (/정품.*맞/.test(compact)) return `เป็นของแท้ใช่ไหม${question}`;

  // Housing detailed
  if (/보증금.*언제.*돌려받/.test(compact)) return `เงินมัดจำจะคืนได้เมื่อไหร่${question}`;
  if (/관리비.*뭐.*포함/.test(compact)) return `ค่าส่วนกลางรวมอะไรบ้าง${question}`;
  if (/곰팡이.*생겼/.test(compact)) return `มีเชื้อราขึ้น${polite}`;
  if (/물.*새요/.test(compact)) return `น้ำรั่ว${polite}`;
  if (/보일러.*고장/.test(compact)) return `บอยเลอร์เสีย${polite}`;
  if (/계약.*연장.*싶/.test(compact)) return `อยากต่อสัญญา${polite}`;
  if (/이사.*나갈.*예정/.test(compact)) return `จะย้ายออก${polite}`;

  // Repair / device / appliances
  if (/전원.*안켜/.test(compact)) return `เปิดไม่ติด${polite}`;
  if (/화면.*깨졌/.test(compact)) return `หน้าจอแตก${polite}`;
  if (/충전.*안돼/.test(compact)) return `ชาร์จไม่เข้า${polite}`;
  if (/배터리.*빨리.*닳/.test(compact)) return `แบตหมดเร็ว${polite}`;
  if (/세탁기.*탈수.*안/.test(compact)) return `เครื่องซักผ้าไม่ปั่นแห้ง${polite}`;
  if (/냉장고.*안시원/.test(compact)) return `ตู้เย็นไม่เย็น${polite}`;
  if (/에어컨.*시원하지않/.test(compact)) return `แอร์ไม่เย็น${polite}`;

  // School / university
  if (/출석.*체크/.test(compact)) return `เช็กชื่อแล้วหรือยัง${question}`;
  if (/과제.*제출.*연장/.test(compact)) return `ขอเลื่อนส่งงานได้ไหม${question}`;
  if (/재학증명서.*발급/.test(compact)) return `อยากขอใบรับรองการเป็นนักศึกษา${polite}`;
  if (/등록금.*납부.*언제/.test(compact)) return `ช่วงจ่ายค่าเทอมเมื่อไหร่${question}`;

  // Hair / nail / salon
  if (/끝만.*다듬/.test(compact)) return `เล็มปลายผมนิดเดียว${polite}`;
  if (/짧게.*자르지말/.test(compact)) return `อย่าตัดสั้นเกินไป${polite}`;
  if (/사진처럼.*해/.test(compact)) return `ทำแบบในรูปนี้${polite}`;
  if (/뿌리염색.*싶/.test(compact)) return `อยากเติมสีโคนผม${polite}`;
  if (/젤네일.*제거.*싶/.test(compact)) return `อยากล้างเล็บเจล${polite}`;

  const commonMap = {
    '안녕하세요': `สวัสดี${polite}`,
    '감사합니다': `ขอบคุณ${polite}`,
    '고마워요': `ขอบคุณ${polite}`,
    '미안해요': `ขอโทษ${polite}`,
    '죄송합니다': `ขอโทษ${polite}`,
    '왜': `ทำไม${question}`,
    '뭐요': `อะไรนะ${question}`,
    '뭐해요': `ทำอะไรอยู่${question}`,
    '뭐하세요': `ทำอะไรอยู่${question}`,
    '어떻게해': `ทำยังไงดี${question}`,
    '어떻게해요': `ทำยังไงดี${question}`,
    '하지말라고': `บอกว่าอย่าทำ${polite}`,
    '하지마세요': `อย่าทำ${polite}`,
    '하지마': `อย่าทำ`,
    '안돼': `ไม่ได้`,
    '안돼요': `ไม่ได้${polite}`,
    '아니요': `ไม่${polite}`,
    '네': ack,
    '예': ack,
    '응': `อืม / ใช่`,
    '됐어요': `ได้แล้ว${polite} / พอแล้ว${polite}`,
    '됐다': 'ได้แล้ว / พอแล้ว',
    '출발': `ออกเดินทาง${polite}`,
    '도착': `ถึงแล้ว${polite}`,
    '집': 'บ้าน',
    '차': 'รถ / ชา',
    '수건주세요': `ขอผ้าเช็ดตัวหน่อย${polite}`,
    '이거주세요': `ขออันนี้หน่อย${polite}`,
    '누나': 'พี่สาว',
    '오빠': 'พี่ชาย / โอปป้า',
    '남편': 'สามี',
    '소방관': 'นักดับเพลิง',
    '기술자': 'ช่างเทคนิค',
    '보증금': 'เงินมัดจำ / เงินประกันห้อง'
  };

  if (commonMap[compact]) return commonMap[compact];

  return '';
}

function hardThaiToKorean(raw, compact) {
  // Isan/Lao-style question tails: บ่, บ่หึ/บ่ฮึ/บ่หือ, เบาะ, บ้อ, etc.
  // These tails at the END usually mean ไหม/หรือเปล่า/ใช่ไหม, not negation.
  const isanQuestionTailRe = /(บ่หึ|บ่ฮึ|บ่หือ|บ่ฮือ|บ่หื|บ่ฮื|บ่ติ|บ่ตี้|บ่เบาะ|บ่น้อ|บ่เนาะ|บ่หนอ|บ่หนา|บ่ล่ะ|บ่ละ|เบาะ|บ้อ|บ๋อ|บ่)$/;
  const isanNegativeQuestionTailRe = /(หึ|ฮึ|หือ|ฮือ|หื|ฮื|ติ|ตี้|น้อ|เนาะ|หนอ|หนา|ล่ะ|ละ)$/;
  const hasIsanQuestionTail = isanQuestionTailRe.test(compact);
  const stripIsanQuestionTail = (v) => String(v || '').replace(isanQuestionTailRe, '');
  const stripIsanNegativeQuestionTail = (v) => String(v || '').replace(isanNegativeQuestionTailRe, '');

  // Negative question: บ่ + verb/adjective + หึ/ฮึ/หือ... = ไม่...เหรอ?
  // Example: บ่ไปหึ = 안 가요? | บ่เข้าใจหึ = 이해 못 했어요?
  if (/^บ่/.test(compact) && isanNegativeQuestionTailRe.test(compact) && !isanQuestionTailRe.test(compact)) {
    const baseNeg = stripIsanNegativeQuestionTail(compact).replace(/^บ่/, '');
    if (/ไป/.test(baseNeg)) return '안 가요?';
    if (/มา/.test(baseNeg)) return '안 와요?';
    if (/กิน/.test(baseNeg)) return '안 먹어요?';
    if (/เข้าใจ/.test(baseNeg)) return '이해 못 했어요?';
    if (/มี/.test(baseNeg)) return '없어요?';
    if (/ได้/.test(baseNeg)) return '안 돼요?';
    if (/ว่าง/.test(baseNeg)) return '시간 없어요?';
    if (/สบาย|โอเค/.test(baseNeg)) return '괜찮지 않아요?';
  }

  // Positive yes/no question tails: verb/clause + บ่หึ/บ่ฮึ/เบาะ/บ้อ/etc.
  if (hasIsanQuestionTail) {
    const baseQ = stripIsanQuestionTail(compact);
    if (/(มื้ออื่น|พรุ่งนี้).*(ไป)?โรงพยาบาล/.test(baseQ)) return '내일 병원에 갈 거예요?';
    if (/(มื้อนี้|วันนี้).*(ไป)?โรงพยาบาล/.test(baseQ)) return '오늘 병원에 갈 거예요?';
    if (/(มื้อวาน|เมื่อวาน).*(ไป)?โรงพยาบาล/.test(baseQ)) return '어제 병원에 갔어요?';
    if (/เอิร์น.*(ไป)?โรงพยาบาล/.test(baseQ)) return '언 씨, 병원에 가요?';
    if (/(ไป)?โรงพยาบาล/.test(baseQ)) return '병원에 가요?';
    if (/กินข้าว.*แล้ว/.test(baseQ)) return '밥 먹었어요?';
    if (/กินข้าว/.test(baseQ)) return '밥 먹어요?';
    if (/เลิกงาน.*แล้ว/.test(baseQ)) return '퇴근했어요?';
    if (/เลิกงาน/.test(baseQ)) return '퇴근해요?';
    if (/เข้าใจ/.test(baseQ)) return '이해했어요?';
    if (/แม่น|ใช่/.test(baseQ)) return '맞아요?';
    if (/มี/.test(baseQ)) return '있어요?';
    if (/ได้/.test(baseQ)) return '돼요?';
    if (/ว่าง/.test(baseQ)) return '시간 있어요?';
    if (/สบาย|โอเค/.test(baseQ)) return '괜찮아요?';
    if (/ไป/.test(baseQ)) return '가요?';
    if (/มา/.test(baseQ)) return '와요?';
    if (/กิน/.test(baseQ)) return '먹어요?';
  }

  // Isan final question marker: บ่ at the end usually means "ไหม/หรือยัง", NOT Korean negation.
  // Examples: "มื้ออื่นไปโรงพยาบาลบ่" = 내일 병원에 갈 거예요?
  // "เอิร์นไปโรงพยาบาลบ่" = 언 씨, 병원에 가요?
  if (/(มื้ออื่น|พรุ่งนี้).*(ไป)?โรงพยาบาล.*บ่$/.test(compact)) return '내일 병원에 갈 거예요?';
  if (/(มื้อนี้|วันนี้).*(ไป)?โรงพยาบาล.*บ่$/.test(compact)) return '오늘 병원에 갈 거예요?';
  if (/(มื้อวาน|เมื่อวาน).*(ไป)?โรงพยาบาล.*บ่$/.test(compact)) return '어제 병원에 갔어요?';
  if (/เอิร์น.*(ไป)?โรงพยาบาล.*บ่$/.test(compact)) return '언 씨, 병원에 가요?';
  if (/(ไป)?โรงพยาบาล.*บ่$/.test(compact)) return '병원에 가요?';
  if (/กินข้าว.*บ่$/.test(compact)) return '밥 먹었어요?';
  if (/เลิกงาน.*บ่$/.test(compact)) return '퇴근했어요?';
  if (/ได้.*บ่$/.test(compact)) return '돼요?';
  // Massage / safety boundary Thai -> Korean
  if (/ที่นี่.*นวด.*สุขภาพเท่านั้น/.test(compact) || /นวดเพื่อสุขภาพเท่านั้น/.test(compact)) return '여기는 건강 마사지 서비스만 제공합니다.';
  if (/ไม่มีบริการพิเศษ/.test(compact)) return '특별 서비스는 없습니다.';
  if (/ไม่มีบริการทางเพศ/.test(compact)) return '성적인 서비스는 제공하지 않습니다.';
  if (/อย่าพูดแบบนั้น|กรุณาอย่าพูดแบบนั้น/.test(compact)) return '그런 말씀은 하지 말아 주세요.';
  if (/อย่าแตะตัวพนักงาน|ห้ามแตะตัวพนักงาน|อย่าจับตัว/.test(compact)) return '직원을 만지지 말아 주세요.';
  if (/จะหยุดบริการ|หยุดนวด/.test(compact) && /พูด|ทำ|แบบนี้|ยัง/.test(compact)) return '계속 그러시면 서비스를 중단하겠습니다.';
  if (/เรียกผู้จัดการ/.test(compact)) return '매니저를 부르겠습니다.';
  if (/แจ้งตำรวจ|โทรตำรวจ/.test(compact)) return '경찰에 신고하겠습니다.';
  if (/ฉันรู้สึกไม่ปลอดภัย|ไม่ปลอดภัย/.test(compact)) return '저는 안전하지 않다고 느껴요.';
  if (/ล่วงละเมิดทางเพศ|คุกคามทางเพศ/.test(compact)) return '이건 성희롱입니다.';
  if (/ออกจากห้อง|ออกไปจากห้อง/.test(compact)) return '방에서 나가 주세요.';

  // Pharmacy / women health Thai -> Korean
  if (/ยาคุมฉุกเฉิน/.test(compact)) return '사후피임약이 필요해요.';
  if (/ยาคุมกำเนิด|ยาคุม/.test(compact) && !/ฉุกเฉิน/.test(compact)) return '피임약이 필요해요.';
  if (/ถุงยาง/.test(compact)) return '콘돔 주세요.';
  if (/ที่ตรวจครรภ์|ชุดตรวจครรภ์|ตรวจครรภ์/.test(compact)) return '임신 테스트기 주세요.';
  if (/ปวดท้องประจำเดือน|ปวดท้องเมนส์/.test(compact)) return '생리통이 있어요.';
  if (/ประจำเดือนมาไม่ปกติ|เมนส์มาไม่ปกติ/.test(compact)) return '생리가 불규칙해요.';
  if (/ต้องใช้ใบสั่งยาไหม/.test(compact)) return '처방전이 필요해요?';

  // Korean loanword spoken by Thai users
  if (compact === '출장') return '출장';
  if (/ชุลจัง|ชุนจัง|ชูจัง/.test(compact)) return '출장';
  if (/วันนี้/.test(compact) && /출장/.test(compact)) return '오늘 저는 출장 가요.';
  if (/พรุ่งนี้/.test(compact) && /출장/.test(compact)) return '내일 저는 출장 가요.';
  if (/เมื่อวาน/.test(compact) && /출장/.test(compact)) return '어제 저는 출장 갔어요.';
  if (/ไป/.test(compact) && /출장/.test(compact)) return '출장 가요.';

  // Airport immigration slang / Thai tourist phrases
  if (/ห้องเย็น/.test(compact) && /(ตม|สนามบิน|เข้าเมือง|เกาหลี|พาเข้า|โดนพา|ถูกพา|กัก|สอบถาม|ตรวจ)/.test(compact)) {
    return '입국심사에서 2차 심사실로 가야 한다고 들었어요.';
  }
  if (/ตม.*พา.*ห้องเย็น|เข้าห้องเย็น/.test(compact)) {
    return '입국심사관이 저를 2차 심사실로 데려갔어요.';
  }
  if (/ถูกปฏิเสธเข้าเมือง|เข้าเมืองไม่ได้|เข้าประเทศไม่ได้/.test(compact)) {
    return '입국이 거부됐어요.';
  }
  if (/จุดประสงค์.*เข้า.*ประเทศ|มาทำอะไรที่เกาหลี/.test(compact)) {
    return '입국 목적이 무엇인지 물어보는 건가요?';
  }
  if (/จองโรงแรม|ใบจองโรงแรม/.test(compact)) return '호텔 예약 확인서가 있어요.';
  if (/ตั๋วขากลับ|ตั๋วเครื่องบินขากลับ/.test(compact)) return '귀국 항공권이 있어요.';
  // K-pop concert intent must preserve the artist/group name before the generic concert rule.
  // Example: "ผมมาดูคอนเสิร์ต BLACKPINK" -> "블랙핑크 콘서트를 보러 왔어요." not generic "콘서트" only.
  if (/(BLACKPINK|Blackpink|blackpink|แบล็กพิงก์|แบล็คพิงค์|블랙핑크)/.test(raw + compact) && /(คอนเสิร์ต|concert|คอน|ดู|มาดู|มาชม|ไปดู|ไปชม|보러)/.test(raw + compact)) {
    return /มา|มาดู|มาชม/.test(compact) ? '블랙핑크 콘서트를 보러 왔어요.' : '블랙핑크 콘서트를 보러 가요.';
  }
  if (/(BTS|บีทีเอส|방탄|방탄소년단)/.test(raw + compact) && /(คอนเสิร์ต|concert|คอน|ดู|มาดู|มาชม|ไปดู|ไปชม|보러)/.test(raw + compact)) {
    return /มา|มาดู|มาชม/.test(compact) ? 'BTS 콘서트를 보러 왔어요.' : 'BTS 콘서트를 보러 가요.';
  }
  if (/(TWICE|ทไวซ์|트와이스)/.test(raw + compact) && /(คอนเสิร์ต|concert|คอน|ดู|มาดู|มาชม|ไปดู|ไปชม|보러)/.test(raw + compact)) {
    return /มา|มาดู|มาชม/.test(compact) ? '트와이스 콘서트를 보러 왔어요.' : '트와이스 콘서트를 보러 가요.';
  }
  if (/(SEVENTEEN|เซเว่นทีน|세븐틴)/.test(raw + compact) && /(คอนเสิร์ต|concert|คอน|ดู|มาดู|มาชม|ไปดู|ไปชม|보러)/.test(raw + compact)) {
    return /มา|มาดู|มาชม/.test(compact) ? '세븐틴 콘서트를 보러 왔어요.' : '세븐틴 콘서트를 보러 가요.';
  }
  if (/(Stray Kids|สเตรย์คิดส์|스트레이키즈|스트레이 키즈)/.test(raw + compact) && /(คอนเสิร์ต|concert|คอน|ดู|มาดู|มาชม|ไปดู|ไปชม|보러)/.test(raw + compact)) {
    return /มา|มาดู|มาชม/.test(compact) ? '스트레이 키즈 콘서트를 보러 왔어요.' : '스트레이 키즈 콘서트를 보러 가요.';
  }
  if (/(NewJeans|นิวจีนส์|뉴진스)/.test(raw + compact) && /(คอนเสิร์ต|concert|คอน|ดู|มาดู|มาชม|ไปดู|ไปชม|보러)/.test(raw + compact)) {
    return /มา|มาดู|มาชม/.test(compact) ? '뉴진스 콘서트를 보러 왔어요.' : '뉴진스 콘서트를 보러 가요.';
  }
  if (/(aespa|Aespa|เอสป้า|에스파)/.test(raw + compact) && /(คอนเสิร์ต|concert|คอน|ดู|มาดู|มาชม|ไปดู|ไปชม|보러)/.test(raw + compact)) {
    return /มา|มาดู|มาชม/.test(compact) ? '에스파 콘서트를 보러 왔어요.' : '에스파 콘서트를 보러 가요.';
  }
  if (/(IVE|ไอฟ์|아이브)/.test(raw + compact) && /(คอนเสิร์ต|concert|คอน|ดู|มาดู|มาชม|ไปดู|ไปชม|보러)/.test(raw + compact)) {
    return /มา|มาดู|มาชม/.test(compact) ? '아이브 콘서트를 보러 왔어요.' : '아이브 콘서트를 보러 가요.';
  }
  if (/(LE SSERAFIM|Le Sserafim|เลเซราฟิม|르세라핌)/.test(raw + compact) && /(คอนเสิร์ต|concert|คอน|ดู|มาดู|มาชม|ไปดู|ไปชม|보러)/.test(raw + compact)) {
    return /มา|มาดู|มาชม/.test(compact) ? '르세라핌 콘서트를 보러 왔어요.' : '르세라핌 콘서트를 보러 가요.';
  }
  if (/ไปดูคอนเสิร์ต|ดูคอนเสิร์ต|มาดูคอนเสิร์ต|ชมคอนเสิร์ต/.test(compact)) {
    return /มา|มาดู|มาชม/.test(compact) ? '콘서트를 보러 왔어요.' : '콘서트를 보러 가요.';
  }
  if (/ฝากกระเป๋า/.test(compact) && /โรงแรม|ที่พัก|เช็กอิน|เช็คอิน/.test(compact)) return '체크인 전까지 짐을 맡길 수 있을까요?';
  if (/ขอเปลี่ยนห้อง/.test(compact)) return '방을 바꿔 주실 수 있을까요?';

  // Coupang hard rules
  if (
    compact.length <= 28 &&
    /คู팡|คูพัง|กูพัง|คูปัง/.test(compact) &&
    /(เช็คพัสดุ|พัสดุ|ของถึงไหน|เลขพัสดุ|เลขแทร็ก)/.test(compact)
  ) {
    return '쿠팡 앱에서 배송 조회는 어디서 해요?';
  }

  if (
    compact.length <= 22 &&
    /คู팡|คูพัง|กูพัง|คูปัง/.test(compact) &&
    /(มีของนี้ไหม|มีสินค้าไหม|มีไหม)/.test(compact)
  ) {
    return '쿠팡에 이 상품 있어요?';
  }

  // Parcel hard rules
  if (/ตามพัสดุ/.test(compact) && /(ไม่เห็น|หน้าห้อง|หน้าประตู|หน้า)/.test(compact)) {
    return '배송 완료된 택배를 확인하고 싶은데 문 앞에 안 보여요.';
  }

  if (/พัสดุจัดส่งแล้ว/.test(compact) && /(ไม่เห็น|หน้าห้อง|หน้าประตู|หน้า)/.test(compact)) {
    return '배송 완료됐다고 나오는데 문 앞에 택배가 안 보여요.';
  }

  if (/ไม่เห็นพัสดุ/.test(compact) || /ไม่เห็นของ/.test(compact)) {
    return '택배가 안 보여요.';
  }

  if (/พัสดุยังไม่ถึง|ของยังไม่ถึง/.test(compact)) {
    return '택배가 아직 도착하지 않았어요.';
  }

  if (/อยากเช็คพัสดุถึงไหนแล้ว|เช็คพัสดุถึงไหนแล้ว/.test(compact)) {
    return '택배가 어디쯤 왔는지 확인하고 싶어요.';
  }

  // Product damaged hard rules
  if (/ของผมพัง|ของฉันพัง|ของหนูพัง|สินค้าพัง|สินค้าแตก|สินค้าชำรุด|ของแตก|ของชำรุด/.test(compact)) {
    if (/คืนเงิน|ขอคืนเงิน|환불/.test(compact)) {
      return '제가 주문한 물건이 망가졌어요. 환불받을 수 있을까요?';
    }
    return '제가 주문한 물건이 망가졌어요.';
  }

  if (/ของไม่ตรงปก/.test(compact)) {
    if (/เปลี่ยนสินค้า|เปลี่ยนได้ไหม/.test(compact)) {
      return '상품이 설명과 달라요. 교환할 수 있을까요?';
    }
    return '상품이 설명과 달라요.';
  }

  if (/ขอคืนเงิน/.test(compact)) return '환불받을 수 있을까요?';
  if (/ขอเปลี่ยนสินค้า|เปลี่ยนสินค้าได้ไหม/.test(compact)) return '교환할 수 있을까요?';

  // Dental hard rules
  if (
    /ฟันคุด/.test(compact) &&
    /เส้นประสาท/.test(compact) &&
    /(ถอนได้ไหม|ถอนหรือผ่าได้ไหม|สามารถถอนได้ไหม|ผ่าได้ไหม|ถอนออกได้ไหม|เอาออกได้ไหม)/.test(compact)
  ) {
    return '제 사랑니가 신경과 가까운데 발치할 수 있을까요?';
  }

  if (
    /ฟันคุด/.test(compact) &&
    /เส้นประสาท/.test(compact) &&
    /(ราคาเท่าไหร่|ราคาเท่าไร|กี่วอน)/.test(compact)
  ) {
    return '제 사랑니가 신경과 가까운데 발치 비용이 얼마예요?';
  }

  if (/ฟันคุด/.test(compact) && /เส้นประสาท/.test(compact)) {
    return '제 사랑니가 신경과 가까워요.';
  }

  if (/ถอนฟันคุด/.test(compact) && /(ราคาเท่าไหร่|ราคาเท่าไร|กี่วอน)/.test(compact)) {
    return '사랑니 발치 비용이 얼마예요?';
  }

  if (/ผ่าฟันคุด/.test(compact) && /(ราคาเท่าไหร่|ราคาเท่าไร|กี่วอน)/.test(compact)) {
    return '사랑니 수술 발치 비용이 얼마예요?';
  }

  if (/ถอนฟันคุด/.test(compact)) return '사랑니를 발치하고 싶어요.';
  if (/ผ่าฟันคุด/.test(compact)) return '사랑니 수술 발치를 하고 싶어요.';

  // Isan banter
  if (/ห่ากินหัวมึงเอ้ย/.test(compact)) return '이 망할 놈아.';
  if (/ห่าขั่วมึงเอ้ย|ห่าขั่วมึง/.test(compact)) return '아이고, 이 망할 놈아.';
  if (/บักปอบนี่แหม|บักปอบ/.test(compact)) return '아이고, 이 못된 녀석아.';

  const map = {
    'ไส้เดือน': '지렁이',
    'ขี้กะเดียน': '지렁이',
    'ขี้กะเดี้ย': '지렁이',
    'ขี้ไก่เดียน': '지렁이',
    'ขี้ไก่เดี้ย': '지렁이',
    'ซิดเบ็ด': '낚시해요.',
    'ไปซิดเบ็ด': '낚시하러 가요.',
    'ผมสิไปซิดเบ็ด': '저는 낚시하러 갈 거예요.',
    'ไปใส่เบ็ดที่หนอง': '연못에 낚싯대를 놓으러 가요.',
    'ไปใส่เบ็ดที่คลอง': '수로에 낚싯대를 놓으러 가요.',
    'ไปใส่เบ็ดที่บึง': '늪이나 큰 연못에 낚싯대를 놓으러 가요.',
    'ไปใส่เบ็ดที่ห้วย': '개울에 낚싯대를 놓으러 가요.',
    'เป็นจั่งได๋นิ': '어때요?',
    'อีหยัง': '뭐예요?',
    'เว้าเบิ่ง': '말해 봐요.',
    'เลิกงานแล้วบ่': '퇴근했어요?',
    'กินข้าวแล้วบ่': '밥 먹었어요?',
    'แอปคู팡': '쿠팡 앱',
    'แอปกูพัง': '쿠팡 앱',
    'แอปคูพัง': '쿠팡 앱',
    'แอปคูปัง': '쿠팡 앱'
  };

  if (map[raw]) return map[raw];

  const compactMap = {};
  for (const [k, v] of Object.entries(map)) {
    compactMap[
      String(k)
        .replace(/\s+/g, '')
        .replace(/[?？。.!！,，]/g, '')
        .trim()
    ] = v;
  }

  return compactMap[compact] || '';
}

// ============================================================
// Situation detection
// ============================================================

function detectSituationFromUIContext(context) {
  const c = String(context || '');

  if (/โรงพยาบาล|medical|hospital/.test(c)) return 'hospital';
  if (/ทำงาน|แรงงาน|work/.test(c)) return 'work';
  if (/ราชการ|วีซ่า|immigration|legal/.test(c)) return 'visa';
  if (/ธนาคาร|bank/.test(c)) return 'bank';
  if (/เงิน|ประกัน|tax|insurance/.test(c)) return 'money';
  if (/ร้านอาหาร|food/.test(c)) return 'food';
  if (/ออนไลน์|online|ช้อปปิ้ง|shop/.test(c)) return 'online';
  if (/เดินทาง|travel/.test(c)) return 'travel';
  if (/ที่พัก|housing/.test(c)) return 'housing';
  if (/ฉุกเฉิน|emergency/.test(c)) return 'emergency';
  if (/ศัลยกรรม|ความงาม|beauty/.test(c)) return 'beauty';
  if (/ตำรวจ|แจ้งความ|อุบัติเหตุ|police|accident/.test(c)) return 'police';
  if (/ไปรษณีย์|ศุลกากร|EMS|post|customs/.test(c)) return 'post';
  if (/ซ่อม|เครื่องใช้ไฟฟ้า|service center|repair/.test(c)) return 'repair';
  if (/โรงเรียน|มหาวิทยาลัย|นักศึกษา|university|school/.test(c)) return 'school';
  if (/ทำผม|ร้านเล็บ|salon|hair|nail/.test(c)) return 'salon';
  if (/โรงแรม|hotel|체크인|체크아웃/.test(c)) return 'hotel';
  if (/สนามบิน|เที่ยวบิน|airport|flight|공항|항공편/.test(c)) return 'airport';
  if (/ตม|ห้องเย็น|ตรวจคนเข้าเมือง|immigration|입국심사|출입국심사|2차 심사/.test(c)) return 'airport_immigration';
  if (/คอนเสิร์ต|แฟนมีต|K-?pop|BLACKPINK|BTS|콘서트|팬미팅|아이돌/.test(c)) return 'concert_kpop';
  if (/นวด|หมอนวด|massage|마사지|안마|스웨디시|아로마/.test(c)) return 'massage_safety';
  if (/ยา|ร้านขายยา|ยาคุม|ฉุกเฉิน|피임약|사후피임약|약국|생리|임신/.test(c)) return 'pharmacy_women_health';
  if (/เที่ยว|ท่องเที่ยว|tour|travel spot|관광|관광지/.test(c)) return 'tourism';
  if (/tax.?refund|택스리펀드|면세|ปลอดภาษี|คืนภาษี|เครื่องสำอาง/.test(c)) return 'shopping_taxfree';
  if (/อีสาน|Isaan/.test(c)) return 'isaan';

  return 'general';
}

function autoDetectSituation(text, fallback = 'general') {
  const t = String(text || '');

  if (/ช่วยด้วย|ฉุกเฉิน|รถพยาบาล|ตำรวจ|โดนทำร้าย|ไฟไหม้|หมดสติ|119|112|응급|구급차|경찰|화재|의식/.test(t)) return 'emergency';
  if (shouldLoadPoliceAccidentVocab(t)) return 'police';
  if (shouldLoadPostCustomsVocab(t)) return 'post';
  if (shouldLoadRepairApplianceVocab(t)) return 'repair';
  if (shouldLoadSchoolUniversityVocab(t)) return 'school';
  if (shouldLoadSalonVocab(t)) return 'salon';
  if (shouldLoadPublicOfficeVocab(t)) return 'public_office';
  if (shouldLoadLaborDetailVocab(t)) return 'labor_detail';
  if (shouldLoadAirportImmigrationVocab(t)) return 'airport_immigration';
  if (shouldLoadAirportFlightVocab(t)) return 'airport';
  if (shouldLoadHotelVocab(t)) return 'hotel';
  if (shouldLoadConcertKpopVocab(t)) return 'concert_kpop';
  if (shouldLoadTourismVocab(t)) return 'tourism';
  if (shouldLoadShoppingTaxfreeVocab(t)) return 'shopping_taxfree';
  if (shouldLoadMassageSafetyVocab(t)) return 'massage_safety';
  if (shouldLoadPharmacyWomenHealthVocab(t)) return 'pharmacy_women_health';
  if (/출장|외근|ชุลจัง|ชุนจัง|ชูจัง/.test(t)) return 'work';
  if (shouldLoadOnlineShoppingVocab(t)) return 'online';
  if (shouldLoadDentalVocab(t) || shouldLoadMedicalBodyDetailVocab(t) || shouldLoadMedicineVocab(t)) return 'hospital';
  if (shouldLoadMobileVocab(t)) return 'mobile';
  if (shouldLoadCarTradeVocab(t)) return 'car';
  if (shouldLoadHobbyVocab(t) || shouldLoadWaterPlaceVocab(t)) return 'hobby';

  if (/บ้านงาน|กินดอง|งานกินดอง|งานบุญ|บุญบ้าน|บุญข้าวจี่|บุญบั้งไฟ|บุญผะเหวด|กฐิน|ผ้าป่า|สงกรานต์|ลอยกระทง|บายศรี|สู่ขวัญ|ผูกแขน|งานศพ|หมอลำ|ลำซิ่ง/.test(t)) return 'isaan';

  if (/ก้อย|ลาบ|ต้มแซ่บ|ต้มส้ม|แกงอ่อม|ตำบักหุ่ง|ปลาแดก|ปลาร้า|แจ่วบอง|ปลาจ่อม|กุ้งจ่อม|ส้มหมู|ส้มเนื้อ|ส้มปลา|กุ้งเต้น|ซอยจุ๊/.test(t)) return 'isan_food';

  if (/ปวด|หมอ|โรงพยาบาล|ไข้|เจ็บ|คลินิก|ใบรับรองแพทย์|ตรวจเลือด|เอ็กซเรย์|ผ่าตัด|ท้องเสีย|แพ้ยา|กินยา|ขอยา|รับยา|ยาแก้|ยาแก้ปวด|ยาแก้อักเสบ|ใบสั่งยา|ร้านขายยา/.test(t)) return 'hospital';
  if (/เถ้าแก่|นายจ้าง|หัวหน้า|ลาออก|เงินเดือน|สัญญา|โรงงาน|โอที|สลิปเงินเดือน|ทำงาน|กะกลางคืน|กะเช้า|ของเสีย|งานเสีย|เครื่องเสีย/.test(t)) return 'work';
  if (/วีซ่า|กาม่า|บัตรต่างด้าว|ตม|พาสปอร์ต|ต่อวีซ่า|สถานทูต|กงสุล|ไฮโคเรีย|HiKorea|ทะเบียนบ้าน|สูติบัตร/.test(t)) return 'visa';
  if (/ธนาคาร|เปิดบัญชี|โอนเงิน|รายการเดินบัญชี|statement|ใบรับรองยอดเงิน|บัตรเอทีเอ็ม|สมุดบัญชี/.test(t)) return 'bank';
  if (/กุกมิน|กุ๊กมิน|เทจิก|แทจิก|ภาษี|ประกัน|คืนภาษี|ประกันสุขภาพ/.test(t)) return 'money';
  if (/ร้านอาหาร|เมนู|สั่งอาหาร|ห่อกลับ|กินข้าว|หิว|อยากกิน/.test(t)) return 'food';
  if (/แท็กซี่|รถเมล์|รถไฟ|สถานี|หลงทาง|ไปทางไหน|เดินทาง/.test(t)) return 'travel';
  if (/ห้องเช่า|บ้านเช่า|ค่าเช่า|มัดจำ|วอลเซ|โบจึง|ย้ายบ้าน|น้ำไม่ไหล|ไฟดับ|기숙사|월세|보증금/.test(t)) return 'housing';
  if (/ศัลยกรรม|เสริมจมูก|ทำตา|โบทอก|ฟิลเลอร์|ดูดไขมัน|ทำนม|จัดฟัน|เลเซอร์/.test(t)) return 'beauty';

  if (/아프|병원|의사|약|증상|진료|진단서|처방전|수술|검사|치아|사랑니/.test(t)) return 'hospital';
  if (/사장|공장|월급|계약|퇴사|야근|급여|근무|출근|퇴근/.test(t)) return 'work';
  if (/비자|여권|외국인등록|출입국|하이코리아|대사관|영사관/.test(t)) return 'visa';
  if (/은행|송금|계좌|잔액|거래내역|통장|체크카드/.test(t)) return 'bank';
  if (/택배|배송|쿠팡|주문|환불|반품|교환|결제|문앞|현관/.test(t)) return 'online';

  if (looksLikeIsan(t)) return 'isaan';

  return fallback || 'general';
}

function looksLikeIsan(text) {
  const t = String(text || '');
  return /ข่อย|เจ้า|เฮา|เพิ่น|อ้าย|เอื้อย|บ่|แม่น|หยัง|ไผ|ไส|อยู่ไส|ไปไส|เว้า|เบิ่ง|เฮ็ด|ฟ้าว|พ้อ|เมือ|คัก|ม่วน|แซ่บ|เด้อ|เนาะ|น้อ|ซื่อหยัง|มื้อนี้|มื้ออื่น|มื้อวาน|เกิบ|ข่อยเสีย|ห่าขั่ว|ห่ากินหัว|บักปอบ|ฮ่วย|ป๊าด|งึด|หนหวย/.test(t);
}

// ============================================================
// Trigger checks
// ============================================================

function shouldLoadMedicineVocab(text) {
  const t = String(text || '');
  return /กินยา|ขอยา|รับยา|จ่ายยา|ยาแก้|ยาแก้ปวด|ยาแก้อักเสบ|ยาแก้แพ้|ยานอนหลับ|ยาแก้ไอ|ยาแก้ท้องเสีย|ใบสั่งยา|ร้านขายยา|처방전|약국|약을 먹다|진통제|소염제/.test(t);
}

function shouldLoadDentalVocab(text) {
  const t = String(text || '');
  return /ฟัน|ฟันคุด|ถอนฟัน|ผ่าฟัน|ปวดฟัน|เหงือก|รากฟัน|เส้นประสาท|จัดฟัน|ขูดหินปูน|อุดฟัน|치아|사랑니|발치|신경|잇몸|충치|교정/.test(t);
}

function shouldLoadMedicalBodyDetailVocab(text) {
  const t = String(text || '');
  return /กระดูก|ข้อศอก|หัวเข่า|เข่า|ข้อเท้า|ข้อมือ|เอ็น|กล้ามเนื้อ|บวม|ช้ำ|หนอง|เป็นหนอง|แผล|ติดเชื้อ|ผื่น|คัน|ฝี|เลือดออก|หายใจไม่ออก|จมูกตัน|ภูมิแพ้|เวียนหัว|ชา|뼈|골절|디스크|팔꿈치|무릎|고름|상처|염증/.test(t);
}

function shouldLoadOnlineShoppingVocab(text) {
  const t = String(text || '');
  return /ออนไลน์|สั่งของ|ซื้อของออนไลน์|ซื้อออนไลน์|คู팡|คูพัง|กูพัง|คูปัง|쿠팡|พัสดุ|택배|배송|ส่งพัสดุ|รับพัสดุ|เลขพัสดุ|เลขแทร็ก|เช็คพัสดุ|ตามพัสดุ|ตามของ|จัดส่งแล้ว|พัสดุจัดส่งแล้ว|ไม่เห็นพัสดุ|ไม่เห็นของ|ไม่เห็นที่หน้าห้อง|ไม่เห็นที่หน้าประตู|หน้าห้อง|หน้าประตู|현관|문앞|문 앞|배송완료|택배가 안 보여요|ของพัง|ของเสีย|ของแตก|ชำรุด|ของไม่ตรงปก|คืนสินค้า|คืนเงิน|เปลี่ยนสินค้า|ยกเลิกออเดอร์|เก็บเงินปลายทาง|환불|교환|반품|결제|장바구니|판매자/.test(t);
}

function shouldLoadOnlineOrderVocab(text) {
  const t = String(text || '');
  return /สั่งของ|ซื้อของออนไลน์|กดสั่ง|ออเดอร์|สั่งซื้อ|ตะกร้า|ชำระเงิน|จ่ายเงิน|บัตรเครดิต|คูปอง|ส่วนลด|주문|구매|장바구니|결제|쿠폰|할인/.test(t);
}

function shouldLoadDeliveryParcelVocab(text) {
  const t = String(text || '');
  return /พัสดุ|택배|배송|ส่งพัสดุ|รับพัสดุ|เลขพัสดุ|เลขแทร็ก|เช็คพัสดุ|ตามพัสดุ|ตามของ|ของถึงไหน|ของยังไม่ถึง|จัดส่งแล้ว|พัสดุจัดส่งแล้ว|ไม่เห็นพัสดุ|ไม่เห็นของ|หน้าห้อง|หน้าประตู|현관|문앞|문 앞|배송완료|배송조회|운송장|송장번호|택배사/.test(t);
}

function shouldLoadReturnRefundVocab(text) {
  const t = String(text || '');
  return /คืนเงิน|คืนสินค้า|เปลี่ยนสินค้า|ยกเลิกออเดอร์|เคลม|สินค้าเสีย|ของพัง|ของเสีย|ของแตก|ชำรุด|ไม่ตรงปก|ส่งผิด|ของผิด|ของไม่ครบ|환불|반품|교환|취소|클레임|불량|파손|오배송|누락/.test(t);
}

function shouldLoadSellerChatVocab(text) {
  const t = String(text || '');
  return /ร้านค้า|คนขาย|ผู้ขาย|แชท|ทักร้าน|รีวิว|ให้ดาว|บริการลูกค้า|판매자|상점|채팅|문의|리뷰|별점|고객센터/.test(t);
}

function shouldLoadMobileVocab(text) {
  const t = String(text || '');
  return /ซิม|ซิมการ์ด|ยูซิม|유심|เบอร์|เบอร์โทร|โทรศัพท์|มือถือ|ค่าโทร|ค่าเน็ต|อินเทอร์เน็ต|เน็ตไม่ขึ้น|เน็ตช้า|ไม่มีสัญญาณ|เปิดซิม|เปิดเบอร์|ยกเลิกเบอร์|เติมเงิน|ข้อความยืนยัน|รหัสยืนยัน|LG|KT|SKT|แอลจี|เคที|เอสเคที|통신사|휴대폰|전화번호|인증번호|미납|자동이체|명의/.test(t);
}

function shouldLoadCarTradeVocab(text) {
  const t = String(text || '');
  return /รถ|รถยนต์|รถมือสอง|ทะเบียน|เลขไมล์|ไมล์แท้|กิโล|โอนรถ|เล่มรถ|ประกันรถ|ภาษีรถ|ตรวจสภาพ|ใบตรวจสภาพ|อุบัติเหตุ|ชนหนัก|ชนเบา|ทำสี|น้ำท่วม|จำนำ|ไฟแนนซ์|ผ่อน|ดาวน์|ค่างวด|เจ้าของเดิม|ขายดาวน์|ซ่อมรถ|อู่|중고차|명의이전|보험|자동차세|사고차|무사고|침수차|주행거리|할부/.test(t);
}

function shouldLoadHobbyVocab(text) {
  const t = String(text || '');
  return /งานอดิเรก|ตกปลา|ซิดเบ็ด|คันเบ็ด|รอกตกปลา|รอก|สายเอ็น|ตัวเบ็ด|ทุ่น|ตะกั่ว|เหยื่อ|ไส้เดือน|ขี้กะเดียน|ขี้กะเดี้ย|ขี้ไก่เดียน|กุ้งฝอย|ส่อนกุ้ง|บ่อตกปลา|แทงสนุ๊ก|สนุ๊กเกอร์|낚시|낚싯대|릴|낚싯줄|미끼|지렁이|당구|스누커/.test(t);
}

function shouldLoadWaterPlaceVocab(text) {
  const t = String(text || '');
  return /ห้วย|หนองน้ำ|หนอง|คลอง|บึง|บ่อปลา|แม่น้ำ/.test(t) &&
    /ซิดเบ็ด|ตกปลา|หาปลา|ใส่เบ็ด|ลงเบ็ด|เหยื่อ|คันเบ็ด|ไส้เดือน|ขี้กะเดียน/.test(t);
}

function shouldLoadThaiSiaAmbiguity(text) {
  const t = String(text || '');
  return /เสีย|ซะ|สิ|ของเสีย|งานเสีย|เครื่องเสีย|รถเสีย|เกิบเสีย|พัง|แตก|ชำรุด/.test(t);
}

function shouldLoadIsanBanterVocab(text) {
  const t = String(text || '');
  return /ห่า|ห่าขั่ว|ห่ากินหัว|บักห่า|บักปอบ|ฮ่วย|ป๊าด|บักปึก|ตอแหล|งึด|หนหวย|มึง|กู/.test(t);
}

function shouldLoadIsanFoodVocab(text, situation, uiSituation) {
  const t = String(text || '');
  return /ก้อย|ลาบ|ต้มแซ่บ|ต้มส้ม|แกงอ่อม|ตำบักหุ่ง|ปลาแดก|ปลาร้า|แจ่วบอง|ปลาจ่อม|กุ้งจ่อม|ส้มหมู|ส้มเนื้อ|ส้มปลา|กุ้งเต้น|ซอยจุ๊/.test(t)
    || ((situation === 'isaan' || uiSituation === 'isaan') && /อยากกิน|หิว|กิน|แซ่บ|ข้าวเหนียว/.test(t));
}

function shouldLoadIsanCeremonyVocab(text, situation, uiSituation) {
  const t = String(text || '');
  return /บ้านงาน|กินดอง|งานกินดอง|แต่งงาน|งานแต่ง|งานบุญ|บุญบ้าน|บุญข้าวจี่|บุญบั้งไฟ|บุญผะเหวด|กฐิน|ผ้าป่า|สงกรานต์|ลอยกระทง|บายศรี|สู่ขวัญ|ผูกแขน|งานศพ|หมอลำ|ลำซิ่ง|มื้อนี้|มื้ออื่น|มื้อวาน/.test(t)
    || ((situation === 'isaan' || uiSituation === 'isaan') && /พี่น้อง|หมู่บ้าน|ผู้เฒ่า|พ่อใหญ่|แม่ใหญ่/.test(t));
}


function shouldLoadKoreanShortResponseVocab(text) {
  const t = String(text || '');
  return /\b(네|예|그래요|아 그래요|그렇군요|아 그렇군요|됐어요|괜찮아요|아니에요|좋아요|잠깐만요|잠시만요|알겠습니다|맞아요)\b|안녕하세요|반갑습니다/.test(t);
}

function shouldLoadPublicOfficeVocab(text) {
  const t = String(text || '');
  return /주민센터|동사무소|구청|시청|민원실|번호표|대기번호|신청서|서명|도장|신분증|외국인등록증|주소 변경|전입신고|전출신고|등본|초본|가족관계증명서|혼인관계증명서|출생증명서|번역공증|공증|원본|사본|제출|발급|재발급|수수료|ศูนย์บริการชุมชน|สำนักงานเขต|บัตรคิว|กรอกเอกสาร|เซ็นชื่อ|ตราประทับ|ต้นฉบับ|สำเนา|รับรองเอกสาร/.test(t);
}

function shouldLoadPoliceAccidentVocab(text) {
  const t = String(text || '');
  return /경찰서|파출소|경찰관|신고|사건번호|진술서|피해자|가해자|목격자|증거|CCTV|블랙박스|도난|분실|폭행|협박|사기|교통사고|접촉사고|뺑소니|음주운전|무면허|면허증|보험 처리|합의|합의금|벌금|과태료|แจ้งความ|สถานีตำรวจ|ป้อมตำรวจ|หมายเลขคดี|ผู้เสียหาย|พยาน|กล้องวงจรปิด|กล้องหน้ารถ|ถูกขโมย|รถชน|ชนแล้วหนี|เมาแล้วขับ|ใบขับขี่|ค่าปรับ|ใบสั่ง/.test(t);
}

function shouldLoadPostCustomsVocab(text) {
  const t = String(text || '');
  return /우체국|국제택배|국제우편|EMS|항공편|선편|택배 접수|송장|운송장번호|받는 사람|보내는 사람|우편번호|무게|부피|배송비|파손주의|취급주의|세관|통관|관세|금지품목|액체류|배터리|화장품|중고물품|ไปรษณีย์|ส่งของกลับไทย|พัสดุระหว่างประเทศ|ศุลกากร|ภาษีนำเข้า|ของต้องห้าม|น้ำหนักเกิน|ของเหลว|แบตเตอรี่/.test(t);
}

function shouldLoadHousingDetailVocab(text) {
  const t = String(text || '');
  return /부동산|중개인|중개수수료|임대인|임차인|임대차계약서|계약금|전세|관리비|공과금|전기세|수도세|가스비|입주일|퇴실일|위약금|오피스텔|고시원|반지하|옥탑방|보일러|난방|누수|곰팡이|벌레|바퀴벌레|층간소음|방음|นายหน้า|ค่านายหน้า|สัญญาเช่า|ค่าส่วนกลาง|ค่าน้ำค่าไฟ|วันย้ายเข้า|วันย้ายออก|ผิดสัญญา|บอยเลอร์|น้ำรั่ว|เชื้อรา|แมลงสาบ|เสียงดัง/.test(t);
}

function shouldLoadRepairApplianceVocab(text) {
  const t = String(text || '');
  return /수리|수리점|서비스센터|고장|작동이 안|전원이 안|화면이 깨|화면이 안|소리가 안|충전이 안|배터리|물에 빠졌|데이터 복구|비밀번호|세탁기|냉장고|에어컨|전자레인지|청소기|탈수|수리비|견적|ซ่อม|ร้านซ่อม|ศูนย์บริการ|เปิดไม่ติด|หน้าจอแตก|ชาร์จไม่เข้า|แบตหมดเร็ว|ตกน้ำ|กู้ข้อมูล|ลืมรหัส|เครื่องซักผ้า|ตู้เย็น|แอร์ไม่เย็น|ค่าซ่อม|ประเมินราคา/.test(t);
}

function shouldLoadSchoolUniversityVocab(text) {
  const t = String(text || '');
  return /대학교|학과|전공|교수님|강의|출석|결석|지각|조퇴|과제|발표|시험|중간고사|기말고사|성적|성적표|성적증명서|재학증명서|졸업증명서|휴학|복학|등록금|장학금|수강신청|학점|졸업요건|มหาวิทยาลัย|สาขาวิชา|อาจารย์|เช็กชื่อ|ขาดเรียน|มาสาย|งานส่ง|พรีเซนต์|สอบกลางภาค|สอบปลายภาค|ค่าเทอม|ทุนการศึกษา|ลงทะเบียนเรียน|หน่วยกิต/.test(t);
}

function shouldLoadSalonVocab(text) {
  const t = String(text || '');
  return /미용실|머리 자르|커트|앞머리|옆머리|뒷머리|다듬|펌|매직|염색|탈색|뿌리염색|상한 머리|트리트먼트|네일샵|젤네일|네일 제거|손톱|발톱|속눈썹 연장|눈썹 문신|ร้านทำผม|ตัดผม|หน้าม้า|เล็มปลาย|ดัดผม|ยืดผม|ทำสีผม|กัดสีผม|เติมสีโคน|เล็บเจล|ล้างเล็บ|ต่อขนตา|สักคิ้ว/.test(t);
}

function shouldLoadHospitalAdminVocab(text) {
  const t = String(text || '');
  return /접수|진료 접수|예약 확인|초진|재진|문진표|보험증|건강보험|비급여|진료비|수납|검사 결과|정상|이상 있음|추가 검사|재검사|금식|공복|혈압|체온|맥박|채혈|소변검사|대변검사|심전도|내시경|위내시경|대장내시경|ลงทะเบียน|รับบัตรคิว|จองคิว|มาครั้งแรก|ตรวจซ้ำ|แบบสอบถามอาการ|ประกันสุขภาพ|นอกประกัน|ค่ารักษา|ผลตรวจ|ตรวจเพิ่ม|งดอาหาร|ท้องว่าง|ความดัน|เจาะเลือด|ส่องกล้อง/.test(t);
}

function shouldLoadLaborDetailVocab(text) {
  const t = String(text || '');
  return /노동청|고용노동부|산재|산재보험|업무상 재해|임금체불|최저임금|주휴수당|연차수당|야근수당|해고예고수당|계약 위반|무단결근|사업장 변경|근무시간|휴게시간|สำนักงานแรงงาน|กระทรวงแรงงาน|อุบัติเหตุจากการทำงาน|ประกันอุบัติเหตุงาน|ค้างจ่ายค่าแรง|ค่าแรงขั้นต่ำ|ค่าวันหยุด|ค่าโอทีกลางคืน|ผิดสัญญา|ขาดงานโดยไม่แจ้ง|เวลาพัก/.test(t);
}


function shouldLoadAirportImmigrationVocab(text) {
  const t = String(text || '');
  return /ห้องเย็น|ตม|ตรวจคนเข้าเมือง|ด่านตรวจคนเข้าเมือง|ถูกกัก|โดนกัก|สัมภาษณ์เข้าเมือง|เข้าห้องสอบสวน|เข้าห้องเย็น|入国|입국심사|출입국심사|입국 목적|체류 기간|숙소 주소|왕복 항공권|귀국 항공권|여행 일정|초청장|재정 증명|2차 심사|별도 심사|조사실|대기실|입국 거부|입국 불허|강제송환|입국심사관|세컨더리|secondary inspection/.test(t);
}

function shouldLoadAirportFlightVocab(text) {
  const t = String(text || '');
  return /สนามบิน|เที่ยวบิน|ตั๋วเครื่องบิน|เช็กอินสายการบิน|โหลดกระเป๋า|กระเป๋าเดินทาง|น้ำหนักกระเป๋า|เกินน้ำหนัก|ประตูขึ้นเครื่อง|ขึ้นเครื่อง|เครื่องดีเลย์|ยกเลิกเที่ยวบิน|ต่อเครื่อง|รับกระเป๋า|กระเป๋าหาย|공항|항공편|항공권|항공사|체크인|수하물|위탁|초과 수하물|탑승구|탑승하다|지연|취소|환승|수하물 찾기|캐리어|여행가방/.test(t);
}

function shouldLoadHotelVocab(text) {
  const t = String(text || '');
  return /โรงแรม|เช็กอิน|เช็คอิน|เช็กเอาต์|เช็คเอาท์|จองห้อง|ห้องพัก|ห้องเดี่ยว|ห้องคู่|เตียงเดี่ยว|เตียงคู่|อาหารเช้า|ฝากกระเป๋า|คีย์การ์ด|เปลี่ยนห้อง|น้ำอุ่น|호텔|체크인|체크아웃|객실|예약|싱글룸|더블룸|트윈룸|조식|짐 보관|카드키|방을 바꿔|따뜻한 물/.test(t);
}

function shouldLoadConcertKpopVocab(text) {
  const t = String(text || '');
  return /คอนเสิร์ต|แฟนมีต|แฟนมีตติ้ง|บัตรคอน|บัตรคอนเสิร์ต|บัตรยืน|บัตรนั่ง|โซนที่นั่ง|เลขที่นั่ง|แท่งไฟ|กู๊ดส์|ของหน้างาน|ไอดอล|นักร้อง|นักแสดง|เกิร์ลกรุ๊ป|บอยแบนด์|แฟนคลับ|เมน|โฟโต้การ์ด|ลายเซ็น|BLACKPINK|블랙핑크|BTS|방탄|TWICE|트와이스|SEVENTEEN|세븐틴|Stray Kids|스트레이|aespa|에스파|IVE|아이브|NewJeans|뉴진스|LE SSERAFIM|르세라핌|콘서트|팬미팅|티켓|스탠딩석|좌석|구역|입장|입구|굿즈|응원봉|촬영 금지|매진|포토카드|팬사인회/.test(t);
}

function shouldLoadTourismVocab(text) {
  const t = String(text || '');
  return /ท่องเที่ยว|สถานที่ท่องเที่ยว|จุดถ่ายรูป|ถ่ายรูป|ช่วยถ่ายรูป|ค่าเข้า|เปิดกี่โมง|ปิดกี่โมง|ใกล้สถานีไหน|ต้องจองไหม|คนเยอะไหม|ร้านดัง|คาเฟ่ดัง|พระราชวัง|ฮงแด|เมียงดง|คังนัม|นัมซาน|관광지|사진 찍|포토존|입장료|몇 시에 열|몇 시에 닫|예약해야|사람 많|유명한 가게|유명한 카페|궁궐|홍대|명동|강남|남산/.test(t);
}

function shouldLoadShoppingTaxfreeVocab(text) {
  const t = String(text || '');
  return /ปลอดภาษี|คืนภาษี|Tax refund|tax refund|แท็กซ์รีฟันด์|ดิวตี้ฟรี|Duty Free|พาสปอร์ตต้องใช้ไหม|ร้านเครื่องสำอาง|เครื่องสำอาง|สกินแคร์|กันแดด|มาสก์หน้า|ลิปสติก|รองพื้น|ของแท้ไหม|ลดราคาไหม|Olive Young|โอลีฟยัง|면세|택스리펀드|세금 환급|여권 필요|화장품|스킨케어|선크림|마스크팩|립스틱|파운데이션|정품|할인|올리브영/.test(t);
}

function shouldLoadMassageSafetyVocab(text) {
  const t = String(text || '');
  return /นวด|หมอนวด|นวดไทย|นวดน้ำมัน|นวดอโรม่า|นวดสปอร์ต|ร้านนวด|กดแรง|กดเบา|พลิกตัว|นอนคว่ำ|นอนหงาย|บริการพิเศษ|ไปต่อ|เพิ่มเงิน|จับได้ไหม|ขอเบอร์|ล่วงเกิน|คุกคาม|ไม่ปลอดภัย|ผู้จัดการ|마사지|안마|타이마사지|오일마사지|아로마|스포츠마사지|스웨디시|특별 서비스|2차|추가 요금|얼마 더|만져도|손 잡아도|연락처|술 한잔|성희롱|불쾌|매니저|직원을 만지|나가 주세요/.test(t);
}

function shouldLoadPharmacyWomenHealthVocab(text) {
  const t = String(text || '');
  return /ยา|ร้านขายยา|ยาแก้ปวด|ยาแก้อักเสบ|ยาแก้แพ้|ยาคุม|ยาคุมฉุกเฉิน|ยาคุมกำเนิด|ถุงยาง|ตรวจครรภ์|ประจำเดือน|เมนส์|ปวดท้องเมนส์|ตั้งครรภ์|ท้องไหม|โรคติดต่อทางเพศ|ตกขาว|คัน|ปัสสาวะแสบ|กระเพาะปัสสาวะ|약국|약|진통제|소염제|항생제|피임약|사후피임약|응급피임약|콘돔|임신테스트기|생리|생리통|임신|성병|질염|방광염|소변 볼 때 아파|처방전/.test(t);
}

function shouldLoadKoreanCommonVocab(text) {
  const t = String(text || '');
  return /몇시|언제|어디|들어와요|돌아와요|오세요|와요|가요|출발|도착|기숙사|회사|수업|질문|괜찮아요|안돼요|돼요|몰라요|알겠어요|네|예|그래요|그렇군요|됐어요|아니에요|좋아요|잠깐만요|잠시만요/.test(t);
}

function buildVocabHint(text, finalSit, uiSit) {
  const sections = [VOCAB_CORE];

  if (shouldLoadKoreanCommonVocab(text)) sections.push(KOREAN_COMMON_REAL_LIFE_VOCAB);
  if (shouldLoadKoreanShortResponseVocab(text)) sections.push(KOREAN_SHORT_RESPONSE_AMBIGUITY_VOCAB, DO_NOT_HARD_MAP_AMBIGUOUS_KOREAN_VOCAB);

  if (finalSit === 'isaan' || looksLikeIsan(text)) {
    sections.push(ISAN_CORE_COMPACT, ISAN_AMBIGUITY_RULES);
  }

  if (VOCAB_BY_SITUATION[finalSit]) {
    sections.push(VOCAB_BY_SITUATION[finalSit]);
  } else if (VOCAB_BY_SITUATION[uiSit]) {
    sections.push(VOCAB_BY_SITUATION[uiSit]);
  }

  if (shouldLoadPublicOfficeVocab(text) || finalSit === 'public_office' || uiSit === 'public_office') sections.push(PUBLIC_OFFICE_VOCAB);
  if (shouldLoadPoliceAccidentVocab(text) || finalSit === 'police' || uiSit === 'police') sections.push(POLICE_ACCIDENT_REPORT_VOCAB);
  if (shouldLoadPostCustomsVocab(text) || finalSit === 'post' || uiSit === 'post') sections.push(POST_CUSTOMS_VOCAB);
  if (shouldLoadHousingDetailVocab(text)) sections.push(HOUSING_DETAIL_VOCAB);
  if (shouldLoadRepairApplianceVocab(text) || finalSit === 'repair' || uiSit === 'repair') sections.push(REPAIR_APPLIANCE_DEVICE_VOCAB);
  if (shouldLoadSchoolUniversityVocab(text) || finalSit === 'school' || uiSit === 'school') sections.push(SCHOOL_UNIVERSITY_VOCAB);
  if (shouldLoadSalonVocab(text) || finalSit === 'salon' || uiSit === 'salon') sections.push(HAIR_NAIL_SALON_VOCAB);
  if (shouldLoadHospitalAdminVocab(text)) sections.push(HOSPITAL_ADMIN_CHECKUP_VOCAB);
  if (shouldLoadLaborDetailVocab(text) || finalSit === 'labor_detail' || uiSit === 'labor_detail') sections.push(LABOR_DETAIL_VOCAB);
  if (shouldLoadAirportImmigrationVocab(text) || finalSit === 'airport_immigration' || uiSit === 'airport_immigration') sections.push(AIRPORT_IMMIGRATION_ROOM_VOCAB);
  if (shouldLoadAirportFlightVocab(text) || finalSit === 'airport' || uiSit === 'airport') sections.push(AIRPORT_FLIGHT_VOCAB);
  if (shouldLoadHotelVocab(text) || finalSit === 'hotel' || uiSit === 'hotel') sections.push(HOTEL_TRAVEL_STAY_VOCAB);
  if (shouldLoadConcertKpopVocab(text) || finalSit === 'concert_kpop' || uiSit === 'concert_kpop') sections.push(CONCERT_KPOP_ENTERTAINMENT_VOCAB);
  if (shouldLoadTourismVocab(text) || finalSit === 'tourism' || uiSit === 'tourism') sections.push(TOURISM_PHOTO_ATTRACTION_VOCAB);
  if (shouldLoadShoppingTaxfreeVocab(text) || finalSit === 'shopping_taxfree' || uiSit === 'shopping_taxfree') sections.push(SHOPPING_TAXFREE_COSMETICS_VOCAB);
  if (shouldLoadMassageSafetyVocab(text) || finalSit === 'massage_safety' || uiSit === 'massage_safety') sections.push(MASSAGE_PROFESSIONAL_SAFETY_VOCAB);
  if (shouldLoadPharmacyWomenHealthVocab(text) || finalSit === 'pharmacy_women_health' || uiSit === 'pharmacy_women_health') sections.push(PHARMACY_WOMEN_HEALTH_VOCAB);
  if (shouldLoadThaiSiaAmbiguity(text)) sections.push(THAI_SIA_AMBIGUITY_VOCAB);
  if (shouldLoadDentalVocab(text)) sections.push(DENTAL_VOCAB);
  if (shouldLoadMedicalBodyDetailVocab(text)) sections.push(MEDICAL_BODY_DETAIL_VOCAB);
  if (shouldLoadMedicineVocab(text)) sections.push(MEDICINE_VOCAB);
  if (shouldLoadHobbyVocab(text)) sections.push(HOBBY_FISHING_SNOOKER_VOCAB);
  if (shouldLoadWaterPlaceVocab(text)) sections.push(ISAN_WATER_PLACE_VOCAB);

  if (shouldLoadIsanBanterVocab(text) || finalSit === 'isaan' || uiSit === 'isaan') {
    sections.push(ISAN_EXCLAMATION_BANTER_VOCAB);
  }

  if (/ซิดเบ็ด|ตกปลา|หาปลา|ใส่เบ็ด|ลงเบ็ด/.test(text)) {
    sections.push(ISAN_ACTIVITY_FIXES);
  }

  if (shouldLoadIsanFoodVocab(text, finalSit, uiSit)) sections.push(ISAN_FOOD_VOCAB);
  if (shouldLoadIsanCeremonyVocab(text, finalSit, uiSit)) sections.push(ISAN_CEREMONY_FESTIVAL_VOCAB);
  if (shouldLoadMobileVocab(text)) sections.push(MOBILE_SIM_VOCAB);
  if (shouldLoadCarTradeVocab(text)) sections.push(CAR_TRADE_VOCAB);
  if (shouldLoadOnlineShoppingVocab(text)) sections.push(ONLINE_SHOPPING_CORE_VOCAB);
  if (shouldLoadOnlineOrderVocab(text)) sections.push(ONLINE_ORDER_PAYMENT_VOCAB);
  if (shouldLoadDeliveryParcelVocab(text)) sections.push(ONLINE_DELIVERY_PARCEL_VOCAB);
  if (shouldLoadReturnRefundVocab(text)) sections.push(ONLINE_RETURN_REFUND_VOCAB);
  if (shouldLoadSellerChatVocab(text)) sections.push(ONLINE_SELLER_CHAT_VOCAB);

  return sections.filter(Boolean).join('\n\n');
}

// ============================================================
// Prompt construction
// ============================================================

function buildGenderInstruction(fromLang, userGender, partnerGender) {
  if (!isThaiLang(fromLang)) {
    if (partnerGender === 'female') {
      return `
The Korean speaker is FEMALE.
Thai output should use female speech naturally.
Use: ดิฉัน / หนู / ค่ะ / คะ / นะคะ
Avoid male endings: ผม / ครับ / นะครับ
`;
    }

    if (partnerGender === 'male') {
      return `
The Korean speaker is MALE.
Thai output should use male speech naturally.
Use: ผม / ครับ / นะครับ
Avoid female endings: ดิฉัน / ค่ะ / นะคะ
`;
    }
  } else {
    if (userGender === 'male') return 'The Thai speaker is MALE. Korean output should be polite and natural.';
    if (userGender === 'female') return 'The Thai speaker is FEMALE. Korean output should be polite and natural.';
  }

  return '';
}

function buildTurnHint(fromLang, prevTurn) {
  if (isThaiLang(fromLang)) return '';
  if (!prevTurn || prevTurn === 'none') return '';
  return `The previous Thai message was a ${prevTurn === 'question' ? 'QUESTION' : 'STATEMENT'}. Use only to resolve ambiguous Korean responses.`;
}

function buildTopicHint(fromLang, lastThai) {
  if (isThaiLang(fromLang)) return '';
  if (!lastThai || !String(lastThai).trim()) return '';
  return `Previous Thai context, do not translate: ${String(lastThai).trim().substring(0, 120)}`;
}

function buildHistoryHint(history) {
  if (!Array.isArray(history) || history.length === 0) return '';

  return history
    .slice(-3)
    .map((h, idx) => {
      const from = h?.from || h?.fromLang || '';
      const orig = String(h?.orig || '').substring(0, 80);
      const trans = String(h?.trans || '').substring(0, 80);
      return `${idx + 1}. ${from}: ${orig} -> ${trans}`;
    })
    .join('\n');
}

function buildSystemPrompt({
  sourceLang,
  targetLang,
  context,
  situationCtx,
  genderInstruction,
  turnHint,
  topicHint,
  historyHint,
  vocabHint,
  unclearReply,
  failReply
}) {
  const contextHint = context ? `[USER UI CONTEXT]\n${context}\n` : '';

  return `
You are "Nongnam", a professional Thai-Korean interpreter.

ABSOLUTE ROLE:
- Thai input -> Korean output only.
- Korean input -> Thai output only.
- Output translation only.
- Do not answer questions as yourself.
- Do not explain.
- Do not add notes.
- Do not summarize.
- Do not moralize.
- Preserve meaning, emotion, tone, questions, and statements.

SOURCE LANGUAGE: ${sourceLang}
TARGET LANGUAGE: ${targetLang}

${contextHint}
${situationCtx ? `[SITUATION]\n${situationCtx}\n` : ''}
${genderInstruction ? `[GENDER]\n${genderInstruction}\n` : ''}
${turnHint ? `[TURN CONTEXT]\n${turnHint}\n` : ''}
${topicHint ? `[PREVIOUS THAI CONTEXT]\n${topicHint}\n` : ''}
${historyHint ? `[RECENT CONTEXT]\n${historyHint}\n` : ''}

CORE RULES:
1. Translate only the newest input.
2. Preserve questions as questions.
3. Preserve statements as statements.
4. Preserve names by sound. Never translate names by meaning.
5. If input asks "คุณคือใคร" or "당신은 누구예요", translate the question. Never answer it.
6. If input is Isan dialect, convert meaning internally to standard Thai, then translate.
7. If Korean is ambiguous, use context but do not invent facts.
8. If audio is truly unclear, output exactly: ${unclearReply}
9. If the input is explicit sexual harassment or a direct violent threat, output exactly: ${failReply}

KOREAN SHORT RESPONSE CONTEXT RULE:
- 네 / 예 does NOT always mean "yes".
- If 네 / 예 appears before greetings such as 안녕하세요, 안녕하십니까, 반갑습니다, translate as acknowledgement: "ครับ" or "ค่ะ".
- Example: "네, 안녕하세요." = "ครับ สวัสดีครับ" or "ค่ะ สวัสดีค่ะ". Do NOT translate as "ใช่ครับ สวัสดีครับ".
- 네 means "ใช่" only when it clearly answers a yes/no question.
- 그래요, 됐어요, 괜찮아요, 아니에요, 좋아요, 잠깐만요 are context-sensitive. Use current utterance and situation; do not hard-translate blindly.

SERVICE / OFFICE / HOSPITAL SPEECH:
- Korean staff often use indirect polite questions. Translate naturally into Thai without changing who asks or who answers.
- 예약하셨어요? = ได้จองไว้ไหม, 접수하셨어요? = ลงทะเบียน/รับคิวแล้วไหม, 신분증 있으세요? = มีบัตรประจำตัวไหม.

MASSAGE / HARASSMENT SAFETY RULE:
- In massage context, translate sexual harassment or boundary-violating phrases accurately so the worker understands them.
- Do not encourage, negotiate, or imply consent to sexual services.
- If the worker refuses or sets a boundary, translate politely but firmly.
- Professional massage means health/body massage only unless the input explicitly says otherwise.

PHARMACY / WOMEN HEALTH RULE:
- Translate medicine and women-health terms accurately.
- Do not provide dosage, diagnosis, or medical advice. Translate only.
- 사후피임약 / 응급피임약 = ยาคุมฉุกเฉิน.
- 피임약 = ยาคุมกำเนิด.
- 콘돔 = ถุงยางอนามัย.
- 임신 테스트기 = ที่ตรวจครรภ์.

KOREAN STT CORRECTION:
- 마치마치 들어와요 / 매치 들어와요 / 미지근 들어와요 / 며칠 들어와요 usually means 몇 시에 들어와요?
- 마치마치 돌아와요 / 매치 돌아와요 / 며칠 돌아와요 usually means 몇 시에 돌아와요?
- 들어와요 can mean เข้ามา / กลับเข้ามา / เข้าหอ / เข้าที่พัก depending on context.
- 돌아와요 means กลับมา.
- 오세요 means มา.
- 몇 시에 오세요? = จะมากี่โมง
- 몇 시에 들어와요? = จะเข้ามากี่โมง / จะกลับเข้ามากี่โมง
- 몇 시에 돌아와요? = จะกลับมากี่โมง

WORK / KOREAN LOANWORD:
- 출장 means business trip / work trip / working off-site / ไปทำงานนอกสถานที่ / ไปทำงานต่างพื้นที่.
- 출장 does NOT mean ตรวจสอบงาน.
- ชุลจัง / ชุนจัง / ชูจัง are Thai speech variants of 출장.
- 외근 means going out for work / off-site work.
- 작업을 확인하다 / 업무를 점검하다 / 현장을 확인하다 = ตรวจสอบงาน.

HOSPITAL / MEDICINE:
- Do not treat "อยาก" as medicine.
- Only treat as medicine when there are words such as กินยา, ขอยา, รับยา, ยาแก้ปวด, ยาแก้อักเสบ, ใบสั่งยา, ร้านขายยา, 처방전, 약국.
- ฟันคุด = 사랑니, never 충치 and never 앞니.

ISAN CONTEXT:
- บ่ at the END of a clause/sentence usually marks a yes/no question like ไหม/หรือยัง. Do NOT translate final บ่ as Korean 안/못 negation.
  Example: มื้ออื่นไปโรงพยาบาลบ่? = 내일 병원에 갈 거예요?
  Example: กินข้าวแล้วบ่? = 밥 먹었어요?
- บ่ before a verb/adjective can mean ไม่, but final บ่ is usually a question marker.
- บ่หึ / บ่ฮึ / บ่หือ / บ่ฮือ / บ่ติ / บ่ตี้ / บ่เบาะ / บ่น้อ / บ่เนาะ / บ่หนอ / บ่ล่ะ at the END of a clause are question markers like ไหม/หรือเปล่า/ใช่ไหม.
  Example: ไปบ่หึ? = 가요? | เข้าใจบ่ฮึ? = 이해했어요? | กินข้าวแล้วบ่หือ? = 밥 먹었어요?
- บ่ + verb/adjective + หึ/ฮึ/หือ/etc. = negative question like ไม่...เหรอ.
  Example: บ่ไปหึ? = 안 가요? | บ่เข้าใจฮึ? = 이해 못 했어요?
- เบาะ / บ้อ / บ๋อ at the END can also be Isan/Lao-style question markers like ไหม/เหรอ.
- Names such as เอิร์น must be kept as a name by sound, not translated as 어른/adult.
- ซิดเบ็ด / ซิสเบ็ด / สิดเบ็ด / สิทเบ็ด / สิบเบ็ด / 10เบ็ด means ตกเบ็ด / ตกปลา / 낚시하다. Never treat as number ten.
- มื้อนี้ means วันนี้, not meal.
- มื้ออื่น means พรุ่งนี้, not another meal.
- มื้อวาน means เมื่อวาน.
- กินดอง means wedding feast / wedding ceremony, not eating pickled food.
- บ้านงาน means a house where a ceremony/event is held.
- หนอง in medical context means pus / 고름.
- หนอง in rural Isan/fishing/water context means pond / 연못.
- ห่ากินหัว / ห่าขั่ว / บักปอบ are Isan banter/swearing expressions. Do not translate literally.

ONLINE SHOPPING:
- คูพัง / กูพัง / คูปัง means 쿠팡 / Coupang app, NOT broken item.
- Only translate as broken item when phrase clearly says ของผมพัง / ของฉันพัง / ของหนูพัง / สินค้าพัง / ของแตก / ชำรุด.
- ตามพัสดุ / เช็คพัสดุ / พัสดุจัดส่งแล้ว / ไม่เห็นที่หน้าห้อง / ไม่เห็นที่หน้าประตู = parcel delivery context.
- ของไม่ตรงปก = product does not match photo/description.
- เลขพัสดุ / เลขแทร็ก = 운송장번호.
- เก็บเงินปลายทาง = cash on delivery.

AIRPORT IMMIGRATION / THAI SLANG:
- ห้องเย็น in Thai traveler slang often means airport immigration secondary inspection room / 2차 심사실 / 입국심사 조사실 / 대기실, NOT a literal cold room.
- Translate ห้องเย็น literally as 냉장실/냉동실 only when the context is food storage, warehouse, kitchen, or refrigeration.
- 입국 목적 = จุดประสงค์ในการเข้าประเทศ.
- 체류 기간 = ระยะเวลาพำนัก.
- 숙소 주소 / 호텔 예약 확인서 = ที่อยู่ที่พัก / ใบจองโรงแรม.
- 입국 거부 / 입국 불허 = ถูกปฏิเสธการเข้าประเทศ.
- 강제송환 = ถูกส่งตัวกลับประเทศ.

VOCABULARY:
${vocabHint}

FINAL OUTPUT:
Return only the translation in ${targetLang}. No explanation.
`.trim();
}

// ============================================================
// Anthropic API
// ============================================================

async function callAnthropic({ apiKey, model, system, userContent, maxTokens = 1200, temperature = 0 }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: 'user', content: userContent }]
    })
  });

  if (!response.ok) {
    const errPayload = await response.json().catch(() => ({}));
    const msg = errPayload?.error?.message || `Anthropic API error: ${response.status}`;
    throw new Error(msg);
  }

  const data = await response.json();

  const text = (data?.content || [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return {
    text,
    usage: data?.usage || {}
  };
}

function chooseMaxTokens(text) {
  const len = String(text || '').length;
  if (len <= 80) return 500;
  if (len <= 250) return 900;
  return 1400;
}

function sanitizeTranslation(output, unclearReply) {
  const s = String(output || '').trim();

  if (!s) return unclearReply;

  const badReply =
    /(저는 통역사|저는 AI|질문에 답변할 수|답변할 수 없습니다|설명해 드리|도와드릴 수 없습니다|번역만 할 수|통역만 할 수|질문에 대답|답변하지 못|I am an AI|I am an interpreter|cannot answer|cannot respond|I can only translate|as an interpreter)/i;

  if (badReply.test(s)) return unclearReply;

  return s.replace(/^["“”]+|["“”]+$/g, '').trim();
}

// ============================================================
// Logging
// ============================================================

function detectKeywords(text, situation) {
  const t = String(text || '');
  const found = [];

  const keywordMap = {
    '몇 시에': 'เกาหลี/ถามเวลา',
    '들어와요': 'เกาหลี/เข้ามา',
    '돌아와요': 'เกาหลี/กลับมา',
    '오세요': 'เกาหลี/มา',
    '출장': 'งาน/출장',
    'ชุลจัง': 'งาน/출장',
    'ชุนจัง': 'งาน/출장',
    'ชูจัง': 'งาน/출장',
    '외근': 'งาน/외근',
    '기숙사': 'หอพัก',
    '회사': 'บริษัท',
    '수업': 'เรียน/คลาส',

    'ฟันคุด': 'ทันตกรรม/ฟันคุด',
    'เส้นประสาท': 'ทันตกรรม/เส้นประสาท',
    'ถอนฟัน': 'ทันตกรรม/ถอนฟัน',
    'ผ่าฟันคุด': 'ทันตกรรม/ผ่าฟันคุด',
    'เป็นหนอง': 'แผล/หนอง',
    'หนอง': 'หนอง/กำกวม',
    'กระดูก': 'กระดูก',
    'ข้อศอก': 'ข้อศอก',
    'เข่า': 'เข่า',
    'ยาแก้ปวด': 'ยา',
    'ใบสั่งยา': 'ยา',

    'คู팡': 'ออนไลน์/Coupang',
    'คูพัง': 'ออนไลน์/Coupang',
    'กูพัง': 'ออนไลน์/Coupang',
    'คูปัง': 'ออนไลน์/Coupang',
    'สั่งของ': 'ออนไลน์/สั่งของ',
    'ซื้อของออนไลน์': 'ออนไลน์/ซื้อของ',
    'ตามพัสดุ': 'ออนไลน์/ตามพัสดุ',
    'ตามของ': 'ออนไลน์/ตามพัสดุ',
    'พัสดุ': 'ออนไลน์/พัสดุ',
    'จัดส่งแล้ว': 'ออนไลน์/จัดส่งแล้ว',
    'หน้าห้อง': 'ออนไลน์/หน้าห้อง',
    'หน้าประตู': 'ออนไลน์/หน้าประตู',
    'เลขพัสดุ': 'ออนไลน์/เลขพัสดุ',
    'เลขแทร็ก': 'ออนไลน์/เลขพัสดุ',
    'ของพัง': 'ออนไลน์/สินค้าชำรุด',
    'ของเสีย': 'ออนไลน์/สินค้าชำรุด',
    'ของไม่ตรงปก': 'ออนไลน์/ไม่ตรงปก',
    'ส่งผิด': 'ออนไลน์/ส่งผิด',
    'ของไม่ครบ': 'ออนไลน์/ของไม่ครบ',
    'คืนสินค้า': 'ออนไลน์/คืนสินค้า',
    'คืนเงิน': 'ออนไลน์/คืนเงิน',
    'เปลี่ยนสินค้า': 'ออนไลน์/เปลี่ยนสินค้า',
    'ยกเลิกออเดอร์': 'ออนไลน์/ยกเลิกออเดอร์',
    'เก็บเงินปลายทาง': 'ออนไลน์/COD',

    'ซิดเบ็ด': 'ตกปลา/ซิดเบ็ด',
    'ขี้กะเดียน': 'เหยื่อตกปลา/ไส้เดือนอีสาน',
    'คลอง': 'ห้วยหนองคลองบึง',
    'ห้วย': 'ห้วยหนองคลองบึง',
    'บึง': 'ห้วยหนองคลองบึง',
    'ห่าขั่ว': 'อีสาน/คำอุทาน',
    'ห่ากินหัว': 'อีสาน/คำอุทาน',
    'บักปอบ': 'อีสาน/คำหยอก',

    'ซิม': 'มือถือ/ซิม',
    '유심': 'มือถือ/ซิม',
    'เบอร์': 'มือถือ/เบอร์โทร',
    'LG': 'มือถือ/LG',
    'KT': 'มือถือ/KT',
    'SKT': 'มือถือ/SKT',

    'รถมือสอง': 'ซื้อขายรถยนต์',
    'โอนรถ': 'โอนรถ',
    'เลขไมล์': 'เลขไมล์',
    'ไฟแนนซ์': 'ไฟแนนซ์รถ',

    'บัตรต่างด้าว': 'บัตรต่างด้าว',
    'วีซ่า': 'วีซ่า',
    'พาสปอร์ต': 'พาสปอร์ต',

    'เงินเดือน': 'เงินเดือน',
    '월급': 'เงินเดือน',
    'เถ้าแก่': 'นายจ้าง',
    '사장님': 'นายจ้าง',
    'ธนาคาร': 'ธนาคาร',
    '은행': 'ธนาคาร',
    'โอนเงิน': 'โอนเงิน',
    'กุกมิน': 'ประกัน/กุกมิน',
    '국민연금': 'ประกัน/กุกมิน',
    'เทจิก': 'เทจิก/ออกงาน',
    '퇴직금': 'เทจิก/ออกงาน',
    'ห้องเย็น': 'สนามบิน/ห้องเย็น ตม.',
    '입국심사': 'สนามบิน/ตม.',
    '2차 심사': 'สนามบิน/2차 심사',
    '조사실': 'สนามบิน/ห้องสอบสวน',
    '입국 거부': 'สนามบิน/ปฏิเสธเข้าเมือง',
    '호텔': 'โรงแรม',
    '체크인': 'โรงแรม/เช็กอิน',
    '항공편': 'สนามบิน/เที่ยวบิน',
    '수하물': 'สนามบิน/กระเป๋า',
    '콘서트': 'คอนเสิร์ต',
    'BLACKPINK': 'K-pop/BLACKPINK',
    '블랙핑크': 'K-pop/BLACKPINK',
    'BTS': 'K-pop/BTS',
    '아이돌': 'K-pop/ไอดอล',
    '택스리펀드': 'Shopping/Tax refund',
    '면세': 'Shopping/Duty free'
  };

  for (const [kw, label] of Object.entries(keywordMap)) {
    if (t.includes(kw) && !found.includes(label)) {
      found.push(label);
    }
  }

  if (situation && !found.includes(`หมวด:${situation}`)) {
    found.unshift(`หมวด:${situation}`);
  }

  return found.slice(0, 14);
}

function logToSheetSafe(req, payload) {
  logToSheet({
    ...payload,
    ip: getCleanIP(req)
  });
}

function logToSheet(payload) {
  const sheetURL = process.env.SHEET_WEBHOOK_URL;
  if (!sheetURL) return;

  fetch(sheetURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch((err) => {
    console.error('SHEET_LOG_ERROR:', err?.message || err);
  });
}

function estimateCost(inputTokens, outputTokens) {
  const inputPer1k = Number(process.env.COST_PER_1K_INPUT || 0);
  const outputPer1k = Number(process.env.COST_PER_1K_OUTPUT || 0);

  if (!inputPer1k && !outputPer1k) return 0;

  const cost =
    (inputTokens / 1000) * inputPer1k +
    (outputTokens / 1000) * outputPer1k;

  return Number(cost.toFixed(8));
}

// ============================================================
// Vocabulary
// ============================================================

const VOCAB_CORE = `
[Core Thai-Korean]
เถ้าแก่/ซาจัง/ซาจังนิม/นายจ้าง=사장님
หัวหน้า/พันจัง/บันจัง=반장님
โรงงาน/คงจัง/กงจัง=공장
บริษัท=회사
หอพัก=기숙사
เงินเดือน=월급
สลิปเงินเดือน=급여명세서
กินข้าวหรือยัง=밥 먹었어요?
กินข้าวแล้ว=밥 먹었어요
รอแป๊บ=잠깐만요
ไม่เข้าใจ=이해 못 했어요
พูดช้าๆ=천천히 말해 주세요
พูดอีกที=다시 말해 주세요
ได้=돼요
ไม่ได้=안 돼요
ไม่เป็นไร=괜찮아요

[Common Korean ambiguity]
사장님 when Korean calls Thai person politely can mean คุณ/ท่าน, not always เถ้าแก่.
괜찮아요 can mean ไม่เป็นไร / โอเค / สบายดี depending on context.
네 means ใช่ / ค่ะ / ครับ.
그래요 can mean ใช่ / อย่างนั้นเหรอ depending on tone.
출장=ไปทำงานนอกสถานที่ / ไปทำงานต่างพื้นที่ / ออกไปทำงานข้างนอก, not ตรวจสอบงาน
ชุลจัง/ชุนจัง/ชูจัง=출장
외근=ออกไปทำงานนอกสถานที่
작업을 확인하다 / 업무를 점검하다 / 현장을 확인하다=ตรวจสอบงาน
들어와요=เข้ามา / กลับเข้ามา / เข้าหอ / เข้าที่พัก depending on context
돌아와요=กลับมา
오세요=มา
`;

const KOREAN_COMMON_REAL_LIFE_VOCAB = `
[Korean real-life phrases]
몇 시에 오세요?=จะมากี่โมง
몇 시에 들어와요?=จะเข้ามากี่โมง / จะกลับเข้ามากี่โมง
몇 시에 돌아와요?=จะกลับมากี่โมง
몇 시에 출발해요?=ออกเดินทางกี่โมง
몇 시에 끝나요?=เสร็จกี่โมง
몇 시에 퇴근해요?=เลิกงานกี่โมง
언제 와요?=จะมาเมื่อไหร่
언제 들어와요?=จะเข้ามาเมื่อไหร่
언제 돌아와요?=จะกลับมาเมื่อไหร่
지금 어디 있어요?=ตอนนี้อยู่ที่ไหน
어디 가요?=ไปไหน
어디로 가요?=ไปทางไหน
뭐 하세요?=ทำอะไรอยู่
뭐 하러 왔어요?=มาทำอะไร
기숙사 들어갈 수 있어요?=เข้าหอพักได้ไหม
오늘 기숙사 들어갈 수 있어요?=วันนี้เข้าหอพักได้ไหม
주소 알려 주세요=ช่วยบอกที่อยู่หน่อย
질문 있습니까?=มีคำถามไหม
없습니다=ไม่มี
있습니다=มี
알겠어요=เข้าใจแล้ว
모르겠어요=ไม่แน่ใจ / ไม่รู้
괜찮아요=ไม่เป็นไร / โอเค
안 돼요=ไม่ได้
돼요=ได้
`;

const SITUATION_CONTEXT = {
  general: '',
  hospital: 'Hospital/clinic. Thai user is usually the patient. Korean speaker may be doctor/nurse.',
  work: 'Workplace/factory/company. Focus on boss, salary, overtime, resignation, contract, defective work, broken machine, 출장, 외근.',
  visa: 'Immigration/government/embassy. Focus on visa, alien registration card, documents, appointments.',
  bank: 'Bank. Focus on account, bank statement, transfer, balance certificate.',
  money: 'Money/insurance/tax. Focus on pension, severance pay, tax refund, insurance.',
  food: 'Restaurant/food. Focus on ordering food, taste, ingredients.',
  online: 'Online shopping / Coupang / parcel / delivery / refund / return / product claim / seller chat.',
  shop: 'Shopping/retail.',
  travel: 'Travel/directions/transportation.',
  housing: 'Housing/rent/dormitory/utilities.',
  emergency: 'Emergency. Prioritize urgent help.',
  beauty: 'Beauty clinic/plastic surgery.',
  isaan: 'Isan dialect mode. Translate Isan meaning by context.',
  isan_food: 'Thai-Isan food context. Translate food names by meaning, not word-by-word.',
  mobile: 'Mobile phone / SIM card / telecom / phone bill / authentication code.',
  car: 'Used car buying/selling, car transfer, insurance, repair, vehicle inspection, financing.',
  hobby: 'Hobby/leisure context. Focus on fishing, fishing gear, bait, snooker, sports, karaoke, games, free-time activities.',
  police: 'Police station / accident / report / theft / fraud / traffic accident / insurance handling.',
  post: 'Post office / international parcel / customs / EMS / shipping to Thailand.',
  repair: 'Repair shop / service center / appliance / phone / device malfunction.',
  school: 'School / university / professor / class / attendance / assignment / tuition / certificates.',
  salon: 'Hair salon / nail shop / non-surgery beauty services.',
  public_office: 'Public office / 주민센터 / document application / forms / ID / certificates.',
  labor_detail: 'Labor office / 산재 / unpaid wage / severance / overtime / labor rights.',
  airport_immigration: 'Airport immigration / 입국심사 / 2차 심사 / investigation room / Thai slang ห้องเย็น. Translate ห้องเย็น as airport secondary inspection room, not literal cold room unless food/storage context.',
  airport: 'Airport / flight / baggage / boarding / delay / transfer.',
  hotel: 'Hotel / check-in / checkout / room / luggage storage / room problems.',
  concert_kpop: 'Concert / fan meeting / K-pop / idol goods / seats / entry / photography rules.',
  tourism: 'Tourism / attractions / photo spots / opening hours / entrance fee / directions.',
  massage_safety: 'Professional massage context. Translate normal massage service vocabulary and boundary/safety phrases. Understand risky sexual-harassment phrases only for accurate translation and safe refusal; never imply agreement to sexual services.',
  pharmacy_women_health: 'Pharmacy and women health context. Focus on medicine names, contraception, emergency contraception, condoms, pregnancy tests, period pain, prescription, and pharmacy communication. Translate only; do not give medical advice.',
  shopping_taxfree: 'Shopping / tax refund / duty free / cosmetics / Olive Young / authentic products.'
};

const VOCAB_BY_SITUATION = {
  hospital: `
[Hospital]
โรงพยาบาล=병원
คลินิก=의원
ร้านขายยา=약국
หมอ=의사/선생님
พยาบาล=간호사
ห้องฉุกเฉิน=응급실
ปวดหัว=머리가 아파요
ปวดท้อง=배가 아파요
ปวดหลัง=허리가 아파요
มีไข้=열이 나요
เจ็บคอ=목이 아파요
ไอ=기침해요
น้ำมูก=콧물
ท้องเสีย=설사
อาเจียน=구토해요
แพ้ยา=약 알레르기가 있어요
ใบรับรองแพทย์=진단서
ใบสั่งยา=처방전
ตรวจเลือด=피검사
เอ็กซเรย์=엑스레이
`,

  work: `
[Work]
출장=ไปทำงานนอกสถานที่ / ไปทำงานต่างพื้นที่ / ออกไปทำงานข้างนอก
외근=ออกไปทำงานนอกสถานที่
ชุลจัง/ชุนจัง/ชูจัง=출장
ตรวจสอบงาน=작업을 확인하다 / 업무를 점검하다 / 현장을 확인하다
ลาออก=퇴사하다
ไล่ออก=해고되다
เปลี่ยนงาน/ย้ายงาน=사업장을 변경하다
สัญญาจ้าง=근로계약서
หมดสัญญา=계약 만료
ต่อสัญญา=계약 연장
โอที=야근/초과근무
ค่าโอที=초과근무수당
วันหยุด=휴무일
ลาป่วย=병가
ลาพักร้อน=연차
มาสาย=지각하다
ขาดงาน=결근하다
เข้างาน=출근하다
เลิกงาน=퇴근하다
เงินเดือนสุทธิ=실수령액
เงินเดือนก่อนหัก=세전 월급
สลิปเงินเดือน=급여명세서
ใบรับรองการทำงาน=재직증명서
เงินเดือนค้าง=임금 체불
ของเสีย=불량품
งานเสีย=작업에 문제가 생겼어요
เครื่องเสีย=기계가 고장 났어요
คุณทำงานเสีย=당신이 일을 망쳤어요 / 당신 때문에 작업에 문제가 생겼어요
`,

  visa: `
[Visa/Government]
บัตรต่างด้าว=외국인등록증
ใบกาม่า=외국인등록증
กาม่า=외국인등록증
บัตรกาม่า=외국인등록증
พาสปอร์ต=여권
ตม=출입국관리사무소
ต่อวีซ่า=비자 연장
เปลี่ยนวีซ่า=비자 변경
ยื่นวีซ่า=비자 신청
เอกสาร=서류
ยื่นเอกสาร=서류 제출
จองคิว=예약하다
HiKorea/ไฮโคเรีย=하이코리아
ทำบัตรต่างด้าวใหม่=외국인등록증 재발급
บัตรต่างด้าวหาย=외국인등록증을 분실했습니다
เปลี่ยนที่อยู่=주소 변경 신고
สถานทูตไทย=태국 대사관
หนังสือมอบอำนาจ=위임장
ใบรับรองโสด=미혼증명서
ใบสมรส=혼인증명서
ใบเกิด/สูติบัตร=출생증명서
ทะเบียนบ้าน=호적등본
E-9=E-9 비자
E-7-4=E-7-4 비자
F-2-R=F-2-R 비자
F-6=F-6 비자
`,

  bank: `
[Bank]
ธนาคาร=은행
เปิดบัญชี=계좌 개설
ปิดบัญชี=계좌 해지
สมุดบัญชี=통장
บัตรเอทีเอ็ม=체크카드
บัตรเครดิต=신용카드
โอนเงิน=송금하다
โอนเงินกลับไทย=태국으로 해외송금하다
ฝากเงิน=입금하다
ถอนเงิน=출금하다
ยอดเงิน/ยอดคงเหลือ=잔액
ค่าธรรมเนียมโอน=송금 수수료
บัญชีโดนล็อค=계좌가 잠겼다
รายการเดินบัญชี=거래내역서
statement=거래내역서
ใบรับรองยอดเงิน=잔액증명서
`,

  money: `
[Money/Insurance/Tax]
กุ๊กมิน/กุกมิน/กูมิน=국민연금
เงินกุกมินสะสม=국민연금 적립금
ขอเงินกุกมินคืน=국민연금 환급 신청
เทจิก/แทจิก/เตจิก=퇴직금
ประกันสังคม=사회보험/4대보험
ประกันสุขภาพ=건강보험
ประกันอุบัติเหตุ=산재보험
ประกันการจ้างงาน=고용보험
ภาษี=세금
คืนภาษี=세금 환급
`,

  food: `
[Food/Restaurant]
ร้านอาหาร=식당
เมนู=메뉴
สั่งอาหาร=주문하다
เอาอันนี้=이걸로 주세요
ห่อกลับ=포장해 주세요
ขอน้ำ=물 주세요
ไม่เผ็ด=안 맵게
เผ็ดน้อย=덜 맵게
เผ็ดมาก=아주 맵게
อร่อย=맛있어요
คิดเงิน=계산해 주세요
`,

  online: `
[Online]
คูพัง/กูพัง/คูปัง=쿠팡
คู팡/Coupang=쿠팡
แอปคูพัง/แอปกูพัง=쿠팡 앱
สั่งของออนไลน์=온라인으로 주문하다
ซื้อของออนไลน์=온라인 쇼핑하다
พัสดุ=택배
จัดส่ง=배송
จัดส่งแล้ว=배송완료
หน้าห้อง/หน้าประตู=문 앞 / 현관 앞
เลขพัสดุ=운송장번호
เช็คพัสดุ=배송 조회하다
คืนสินค้า=반품하다
คืนเงิน=환불
เปลี่ยนสินค้า=교환하다
ของไม่ตรงปก=상품이 설명과 달라요
สินค้าเสีย=불량품
ของพัง/ของแตก/ชำรุด=상품이 파손됐어요
`,

  travel: `
[Travel]
รถเมล์=버스
รถไฟฟ้า=지하철
แท็กซี่=택시
สถานี=역
เรียกแท็กซี่=택시를 부르다
ไปทางไหน=어디로 가요?
หลงทาง=길을 잃었어요
จอดตรงนี้=여기서 세워 주세요
ซ้าย=왼쪽
ขวา=오른쪽
ตรงไป=직진
เลี้ยวซ้าย=좌회전
เลี้ยวขวา=우회전
`,

  housing: `
[Housing]
บ้านเช่า/ห้องเช่า=월세방/원룸
หอพัก=기숙사
ค่าเช่า=월세
เงินมัดจำ=보증금
เจ้าของบ้าน=집주인
ย้ายบ้าน=이사하다
ย้ายออก=이사 나가다
น้ำไม่ไหล=물이 안 나와요
ไฟดับ=전기가 나갔어요
ฮีตเตอร์เสีย=난방이 고장 났어요
`,

  emergency: `
[Emergency]
ช่วยด้วย=도와 주세요
เจ็บมาก=많이 아파요
เรียกรถพยาบาล=구급차 불러 주세요
โทรตำรวจ=경찰에 전화해 주세요
ของหาย=물건을 잃어버렸어요
โดนโกง=사기당했어요
ไฟไหม้=불이 났어요
`,

  beauty: `
[Beauty/Plastic Surgery]
ศัลยกรรม=성형수술
ทำตาสองชั้น=쌍꺼풀 수술
เสริมจมูก=코 수술
ซิลิโคน=실리콘
ฟิลเลอร์=필러
โบทอก=보톡스
เลเซอร์=레이저
ยกกระชับ=리프팅
ดูดไขมัน=지방흡입
จัดฟัน=치아교정
รากฟันเทียม=임플란트
ยาชา=마취
ดมยาสลบ=전신마취
ผลข้างเคียง=부작용
แผลเป็น=흉터
`,

  isan_food: `
[Isan Food Minimal]
ก้อย=고이 / 태국 이산식 생고기 또는 생선 무침
ก้อยเนื้อ=고이 느아 / 태국 이산식 생고기 무침
ลาบ=라브 / 태국 이산식 다진 고기 샐러드
ส้มตำ/ตำบักหุ่ง=쏨땀 / 파파야 샐러드
ปลาร้า/ปลาแดก=태국식 발효 생선 소스
ส้มหมู/ส้มเนื้อ/ส้มปลา=태국식 발효 고기/생선
`,

  mobile: `
[Mobile Minimal]
ซิม=유심
เบอร์โทร=전화번호
เปิดซิม=유심 개통하다
ค่าโทร=휴대폰 요금
เน็ตไม่ขึ้น=인터넷이 안 돼요
รหัสยืนยัน=인증번호
`,

  car: `
[Car Minimal]
รถมือสอง=중고차
โอนรถ=차량 명의이전
ทะเบียนรถ=자동차 번호판
เลขไมล์=주행거리
ใบตรวจสภาพ=성능점검기록부
ซ่อมรถ=차를 수리하다
`,

  hobby: `
[Hobby Minimal]
งานอดิเรก=취미
ตกปลา=낚시하다
ซิดเบ็ด=낚시하다
คันเบ็ด=낚싯대
เหยื่อปลา=낚시 미끼
แทงสนุ๊ก=당구 치다 / 스누커 치다
`
};

const ISAN_CORE_COMPACT = `
[Isan Core Compact]
ข่อย=ฉัน/ผม
เจ้า=คุณ
เฮา=เรา
เพิ่น=เขา/เธอ/คนนั้น
อ้าย=พี่ชาย, not AI
เอื้อย=พี่สาว, not name
บ่=ไม่ when before verb/adjective; final บ่=ไหม/หรือยัง question marker
บ่หึ/บ่ฮึ/บ่หือ/บ่ฮือ=ไหม/หรือเปล่า/ใช่ไหม when at sentence end
บ่ติ/บ่ตี้/บ่เบาะ/บ่น้อ/บ่เนาะ/บ่หนอ/บ่ล่ะ/บ่ละ=ไหม/หรือเปล่า/ใช่ไหม when at sentence end
เบาะ/บ้อ/บ๋อ=ไหม/เหรอ/หรือเปล่า when at sentence end
แม่น=ใช่/ถูก
หยัง/อีหยัง=อะไร
ไผ=ใคร
ไส=ที่ไหน
อยู่ไส=อยู่ที่ไหน
ไปไส=ไปไหน
เว้า=พูด
เบิ่ง=ดู
เฮ็ด=ทำ
ฟ้าว=รีบ
ย่าง=เดิน
พ้อ=เจอ
เมือ=กลับ
ฮอด=ถึง
ซื่อ=ชื่อ or ซื้อ depending on context
ข่อยซื่อ=ฉันชื่อ/ผมชื่อ
คัก=มาก/จริงๆ
ม่วน=สนุก
แซ่บ=อร่อย
คึดฮอด=คิดถึง
ย่าน=กลัว
เมื่อย=เหนื่อย
ฮ้อน=ร้อน
หนาว=หนาว
เกิบ=รองเท้า
เด้อ/เน้อ/น้อ=คำลงท้าย
เบาะ=เหรอ/ไหม
แม่นบ่=ใช่ไหม
บ่เป็นหยัง=ไม่เป็นไร
จั๊ก=ไม่รู้
งึด=ทึ่ง/งง/เหลือเชื่อ
หนหวย=รำคาญ/หงุดหงิด
`;

const ISAN_AMBIGUITY_RULES = `
[Isan ambiguity rules]
Final บ่ at the end of a sentence = ไหม/หรือยัง question marker, not negation.
Do not translate final บ่ as 안/못.
Final บ่หึ/บ่ฮึ/บ่หือ/บ่ฮือ/บ่ติ/บ่ตี้/บ่เบาะ/บ่น้อ/บ่เนาะ/บ่หนอ/บ่ล่ะ/บ่ละ = ไหม/หรือเปล่า/ใช่ไหม.
บ่ + verb/adjective + หึ/ฮึ/หือ/ฮือ/ติ/ตี้/etc. = negative question, e.g. บ่ไปหึ = ไม่ไปเหรอ = 안 가요?
เบาะ/บ้อ/บ๋อ at sentence end can be question markers, not nouns.
เอิร์น is usually a Thai name (Earn/Un) when followed by a verb; do not translate as 어른/adult.
อ้าย at beginning or end = older brother / friendly male address, not AI.
เอื้อย = older sister / friendly female address.
เกิบ = shoes.
เกิบเสีย = shoes are missing/lost, unless context says broken.
เกิบข่อยเสีย = my shoes are missing/lost.
มื้อนี้ = today.
มื้ออื่น = tomorrow.
มื้อวาน = yesterday.
หนอง:
- medical context: pus / 고름.
- rural Isan/fishing/water context: pond / 연못.
`;

const THAI_SIA_AMBIGUITY_VOCAB = `
[Thai/Isan ambiguity: เสีย / ซะ / สิ]
Do NOT automatically replace "เสีย" with "สิ".
The word "เสีย" has multiple meanings depending on context.

1) Damage / broken / mistake:
คุณทำงานเสีย=당신이 일을 망쳤어요 / 당신 때문에 작업에 문제가 생겼어요
คุณทำงานเสียหาย=당신이 작업에 손해를 끼쳤어요
คุณทำของเสีย=당신이 불량품을 만들었어요
งานเสีย=작업에 문제가 생겼어요 / 일이 망쳤어요
เครื่องเสีย=기계가 고장 났어요
รถเสีย=차가 고장 났어요
ระบบเสีย=시스템에 문제가 생겼어요
สินค้าเสีย=불량품이에요
ของเสีย=불량품이에요 / 물건이 고장 났어요

2) Lost / missing / wasted:
เกิบเสีย=신발이 없어졌어요 / 신발을 잃어버렸어요
เกิบข่อยเสีย=제 신발이 없어졌어요 / 제 신발을 잃어버렸어요
กระเป๋าข่อยเสีย=제 가방이 없어졌어요 / 제 가방을 잃어버렸어요
เสียเงิน=돈이 들었어요 / 돈을 잃었어요
เสียเวลา=시간을 낭비했어요

3) Command particle:
Only interpret "เสีย" as "ซะ/สิ" when clear command markers exist:
รีบ..., ไป..., ทำให้เสร็จ..., กิน..., พูด..., ลอง..., เอา..., รีบทำ...
คุณรีบทำงานเสียสิ=빨리 일하세요
รีบทำงานซะสิ=빨리 일하세요
`;

const DENTAL_VOCAB = `
[Dental]
ฟัน=치아 / 이
ฟันหน้า=앞니
ฟันกราม=어금니
ฟันคุด=사랑니
ถอนฟัน=발치
ถอนฟันคุด=사랑니 발치
ผ่าฟันคุด=사랑니 수술 발치
ปวดฟัน=치아가 아파요
ฟันผุ=충치
รากฟัน=치근
เส้นประสาทฟัน=치아 신경
ฟันคุดอยู่ใกล้เส้นประสาท=사랑니가 신경과 가까워요
เหงือก=잇몸
เหงือกบวม=잇몸이 부었어요
เหงือกอักเสบ=잇몸에 염증이 있어요
ขูดหินปูน=스케일링
อุดฟัน=충치 치료 / 레진 치료
จัดฟัน=치아교정
รากฟันเทียม=임플란트
Dental rule: ฟันคุด = 사랑니, never 충치 and never 앞니.
`;

const MEDICAL_BODY_DETAIL_VOCAB = `
[Medical body / wound]
กระดูก=뼈
กระดูกหัก=골절됐어요
กระดูกทับเส้น=신경이 눌려요
หมอนรองกระดูก=디스크
ข้อศอก=팔꿈치
หัวเข่า/เข่า=무릎
ข้อเท้า=발목
ข้อมือ=손목
เอ็น=인대
กล้ามเนื้อ=근육
บวม=부었어요
ช้ำ=멍이 들었어요
แผล=상처
หนอง=고름
มีหนอง=고름이 나와요
เป็นหนอง=곪았어요
แผลเป็นหนอง=상처가 곪았어요
ติดเชื้อ=감염됐어요
ผื่น=발진
คัน=가려워요
ฝี=종기
เลือดออก=피가 나요
หายใจไม่ออก=숨을 쉴 수 없어요
จมูกตัน=코가 막혔어요
ภูมิแพ้=알레르기
เวียนหัว=어지러워요
ชา=저려요
`;

const MEDICINE_VOCAB = `
[Medicine]
ยา=약
กินยา=약을 먹다
ขอยา=약을 주세요
รับยา=약을 받다
จ่ายยา=약을 처방하다 / 약을 내주다
ร้านขายยา=약국
ใบสั่งยา=처방전
ยาแก้ปวด=진통제
ยาแก้อักเสบ=소염제
ยาแก้แพ้=항히스타민제 / 알레르기 약
ยาแก้ไอ=기침약
ยาแก้ท้องเสีย=설사약
ยานอนหลับ=수면제
แพ้ยา=약 알레르기가 있어요
`;

const ISAN_ACTIVITY_FIXES = `
[กิจกรรมอีสาน / คำที่ Speech Recognition มักฟังผิด]
ซิดเบ็ด=낚시하다 / ตกเบ็ด / ตกปลา
ซิสเบ็ด=ซิดเบ็ด / 낚시하다
สิดเบ็ด=ซิดเบ็ด / 낚시하다
สิทเบ็ด=ซิดเบ็ด / 낚시하다
สิบเบ็ด=ซิดเบ็ด ไม่ใช่เลข 10
10เบ็ด=ซิดเบ็ด ไม่ใช่เลข 10
ไปซิดเบ็ด=낚시하러 가다
สิไปซิดเบ็ด=낚시하러 갈 거예요
มื้อนี้สิไปซิดเบ็ด=오늘 낚시하러 갈 거예요
ใส่เบ็ด=낚싯대를 놓다 / 낚시를 하다
ตกปลา=낚시하다
หาปลา=물고기를 잡다
บ่อปลา=낚시터 / 물고기 연못
หนองน้ำ=연못
คลอง=수로
ห้วย=개울
บึง=늪 / 큰 연못
แม่น้ำ=강
`;

const ISAN_WATER_PLACE_VOCAB = `
[Water places]
ห้วย=개울
หนอง=연못, if fishing/rural water context
หนองน้ำ=연못
คลอง=수로 / 운하
บึง=늪 / 큰 연못
บ่อปลา=물고기 연못 / 낚시터
แม่น้ำ=강
ไปใส่เบ็ดที่หนอง=연못에 낚싯대를 놓으러 가요
ไปใส่เบ็ดที่คลอง=수로에 낚싯대를 놓으러 가요
ไปใส่เบ็ดที่บึง=늪이나 큰 연못에 낚싯대를 놓으러 가요
ไปใส่เบ็ดที่ห้วย=개울에 낚싯대를 놓으러 가요
แผลเป็นหนอง=상처가 곪았어요
`;

const ISAN_EXCLAMATION_BANTER_VOCAB = `
[Isan exclamation / banter]
ฮ่วย=아이구 / 아 진짜 / 어이없네
ป๊าด=대박 / 와
งึด=어이없다 / 신기하다
หนหวย=짜증나다
ห่าขั่วมึงเอ้ย=이 망할 놈아 / 아이고 이 녀석아, depending on tone
ห่ากินหัวมึงเอ้ย=이 망할 놈아 / 아이고 이 녀석아
ห่าลากมึงเอ้ย=이 망할 놈아
บักห่า=이 녀석아 / 이 망할 놈아
บักปอบ=이 못된 녀석아 / 이 귀신 같은 놈아, joking or angry by tone
บักปอบนี่แหม=아이고, 이 못된 녀석아
บักปึก=멍청이 / 바보
บักหน้าด้าน=뻔뻔한 놈
อีตอแหล=거짓말쟁이
มึง=너, informal rude
กู=나, informal rude
Use soft Korean if context is joking. Use stronger Korean only if context is clearly angry.
`;

const HOBBY_FISHING_SNOOKER_VOCAB = `
[Hobby / fishing / snooker]
งานอดิเรก=취미
เวลาว่าง=여가 시간 / 자유 시간
พักผ่อน=쉬다 / 휴식하다
ตกปลา=낚시하다
ซิดเบ็ด=낚시하다
คันเบ็ด=낚싯대
รอกตกปลา=낚시 릴
สายเอ็น=낚싯줄
ตัวเบ็ด=낚시바늘
ทุ่น=찌
ตะกั่วถ่วง=봉돌
เหยื่อปลา=미끼
เหยื่อสด=생미끼
เหยื่อปลอม=루어 / 가짜 미끼
ไส้เดือน=지렁이
ขี้กะเดียน/ขี้กะเดี้ย/ขี้ไก่เดียน=지렁이
กุ้งฝอย=작은 새우
ส่อนกุ้ง=뜰채로 작은 새우를 잡다
บ่อตกปลา=낚시터
ตกปลาทะเล=바다낚시
ตกปลาน้ำจืด=민물낚시
ปลาไม่กินเบ็ด=물고기가 미끼를 안 물어요
ปลากินเบ็ดแล้ว=물고기가 미끼를 물었어요
ปลาติดเบ็ดแล้ว=물고기가 걸렸어요
ปลาหลุด=물고기를 놓쳤어요
สายขาด=낚싯줄이 끊어졌어요
แทงสนุ๊ก=당구 치다 / 스누커 치다
แทงสนุ้ก=당구 치다 / 스누커 치다
โต๊ะสนุ๊ก=당구대 / 스누커 테이블
ไม้คิว=큐대
ลูกสนุ๊ก=당구공
ลูกขาว=흰 공
ลูกแดง=빨간 공
แทงพลาด=샷을 실수하다
แทงแม่น=샷이 정확하다
`;

const ISAN_FOOD_VOCAB = `
[อาหารอีสาน / Thai-Isan Food]
ก้อย=고이 / 태국 이산식 생고기 또는 생선 무침
ก้อยเนื้อ=고이 느아 / 태국 이산식 생고기 무침
ก้อยเนื้อขมๆ=쓴맛이 나는 태국 이산식 생고기 무침
ก้อยเนื้อขมขม=쓴맛이 나는 태국 이산식 생고기 무침
ดีขม=쓴맛을 내는 소의 쓸개즙 / 쓴맛 양념
ใส่ดีขม=쓴맛을 내는 소의 쓸개즙을 넣다
ก้อยกุ้ง=태국식 생새우 무침
กุ้งเต้น=살아있는 새우를 양념해 먹는 태국식 새우 샐러드
ซอยจุ๊=태국 이산식 생고기 회
ลาบ=라브 / 태국 이산식 다진 고기 샐러드
ลาบหมู=돼지고기 라브
ลาบเนื้อ=소고기 라브
ต้มแซ่บ=태국 이산식 매운탕
ต้มส้ม=새콤한 태국식 탕
แกงอ่อม=태국 이산식 허브 찌개
ตำบักหุ่ง=쏨땀 / 태국 이산식 파파야 샐러드
ปลาร้า/ปลาแดก=태국식 발효 생선 소스
แจ่วบอง=발효 생선 매운 소스
ปลาจ่อม=태국식 발효 작은 생선
กุ้งจ่อม=태국식 발효 새우
ส้มหมู=태국식 발효 돼지고기
ส้มเนื้อ=태국식 발효 소고기
ส้มปลา=태국식 발효 생선
แหนม=태국식 발효 돼지고기 소시지
ไส้กรอกอีสาน=태국 이산식 발효 소시지
ข้าวเหนียว=찹쌀밥
ข้าวคั่ว=볶은 쌀가루
Rule: ก้อยเนื้อ is Thai-Isan raw beef salad, NOT 꼬리 and NOT tail.
Rule: ขมๆ / ขมขม means bitter taste, not tough.
`;

const ISAN_CEREMONY_FESTIVAL_VOCAB = `
[บ้านงาน / งานบุญ / พิธีกรรม / เทศกาล]
บ้านงาน=행사가 있는 집 / 의식이나 잔치가 열리는 집
งานบ้าน=집안 행사 / 가족 행사
ไปบ้านงาน=행사 있는 집에 가다
ช่วยงาน=행사를 도와주다
เจ้าภาพ=행사 주최자 / 상주 또는 주인
ซองงาน=축의금 봉투 / 부의금 봉투 ตามบริบท
ใส่ซอง=봉투에 돈을 넣다 / 축의금 또는 부의금을 내다
กินดอง=결혼식 / 결혼 잔치 / 이산식 결혼식
งานกินดอง=결혼 잔치
งานแต่ง=결혼식
เจ้าบ่าว=신랑
เจ้าสาว=신부
สินสอด=지참금 / 결혼 예물금
ผูกแขน=손목에 실을 묶어 축복하다
บายศรี=바이씨 / 태국식 축복 의식
สู่ขวัญ=수콴 / 태국식 영혼 축복 의식
งานศพ=장례식
สวดศพ=장례 예불 / 장례 기도
เผาศพ=화장하다
งานบุญ=불교 공덕 행사 / 마을 축제
กฐิน=카틴 / 승려에게 가사를 봉헌하는 불교 행사
ผ้าป่า=불교 기부 행사
สงกรานต์=송끄란 / 태국 새해 물 축제
ลอยกระทง=러이끄라통
หมอลำ=몰람 / 이산식 민속 공연
ลำซิ่ง=람씽 / 빠른 리듬의 이산 공연
มื้อนี้=วันนี้=오늘
มื้ออื่น=พรุ่งนี้=내일
มื้อวาน=เมื่อวาน=어제
`;

const MOBILE_SIM_VOCAB = `
[มือถือ / ซิม / ค่าโทร / อินเทอร์เน็ต]
ซิม / ซิมการ์ด=유심 / 유심카드
เปิดซิม=유심 개통하다
เปิดเบอร์=번호를 개통하다
เบอร์โทร=전화번호
เบอร์นี้ยังใช้ได้ไหม=이 번호 아직 사용할 수 있어요?
ซิมนี้ใช้ได้ไหม=이 유심 사용할 수 있어요?
ซิมนี้ใช้กับ LG ได้ไหม=이 유심은 LG에서 사용할 수 있어요?
LG / แอลจี=LG유플러스 / LG U+
KT / เคที=KT
SKT / เอสเคที=SKT
เครือข่ายมือถือ=통신사
ย้ายค่าย=통신사 이동
เปลี่ยนซิม=유심을 바꾸다
ซิมหาย=유심을 잃어버렸어요
ซิมเสีย=유심이 고장 났어요
ซิมใช้ไม่ได้=유심이 안 돼요
ไม่มีสัญญาณ=신호가 안 잡혀요
เน็ตไม่ขึ้น=인터넷이 안 돼요
เน็ตช้า=인터넷이 느려요
โทรไม่ได้=전화를 못 걸어요
ข้อความยืนยัน=인증 문자
รหัสยืนยัน=인증번호
ไม่ได้รับรหัสยืนยัน=인증번호를 못 받았어요
ค่าโทร=휴대폰 요금 / 통신비
ค่าเน็ต=인터넷 요금 / 데이터 요금
ยอดค้าง=미납금
หักเงินอัตโนมัติ=자동이체
ซิมเป็นชื่อใคร=유심이 누구 명의예요?
`;

const CAR_TRADE_VOCAB = `
[ซื้อขายรถยนต์มือสอง / Used Car Trade]
รถยนต์=자동차
รถมือสอง=중고차
ขายรถ=차를 팔다
ซื้อรถ=차를 사다
ดูรถ=차를 보러 가다
ทดลองขับ=시승하다
ทะเบียนรถ=차량 번호 / 자동차 번호판
เล่มรถ / เอกสารรถ=자동차등록증
ชื่อเจ้าของรถ=차량 명의자
เจ้าของเดิม=전 차주
เปลี่ยนชื่อ / โอนชื่อ=명의이전
โอนรถ=차량 명의이전
ค่าธรรมเนียมโอน=명의이전 비용
โอนได้ไหม=명의이전 가능해요?
รถติดไฟแนนซ์ไหม=할부나 저당이 남아 있어요?
ภาษีรถ=자동차세
ประกันรถ=자동차 보험
ราคาเท่าไหร่=가격이 얼마예요?
ลดได้ไหม=깎아 줄 수 있어요?
ผ่อนได้ไหม=할부 가능해요?
ขายดาวน์=계약금 승계 / 할부 승계
เงินดาวน์=계약금 / 선수금
ค่างวด=월 할부금
ดอกเบี้ย=이자
ไฟแนนซ์=할부 금융 / 캐피탈
รถเคยชนไหม=사고 이력이 있어요?
รถไม่มีอุบัติเหตุ=무사고 차량
รถมีอุบัติเหตุ=사고 차량
น้ำท่วมไหม=침수 이력이 있어요?
เลขไมล์=주행거리
ไมล์แท้ไหม=실주행거리 맞아요?
ไมล์กรอไหม=주행거리 조작된 거 아니에요?
ใบตรวจสภาพ=성능점검기록부
ขอดูใบตรวจสภาพได้ไหม=성능점검기록부 볼 수 있어요?
ซ่อมรถ=차를 수리하다
อู่ซ่อมรถ=카센터 / 정비소
ค่าซ่อมเท่าไหร่=수리비가 얼마예요?
Rule: โอนรถ means vehicle ownership transfer, not money transfer.
Rule: เล่มรถ means car registration document, not a book.
`;

const ONLINE_SHOPPING_CORE_VOCAB = `
[Online shopping core]
คู팡/Coupang=쿠팡
คูพัง/กูพัง/คูปัง=쿠팡, this is Coupang app name, NOT broken item
แอปคูพัง/แอปกูพัง/แอปคูปัง=쿠팡 앱
สั่งของในคู팡=쿠팡에서 주문하다
ซื้อของในคู팡=쿠팡에서 물건을 사다
ซื้อของออนไลน์=온라인으로 물건을 사다 / 온라인 쇼핑하다
สั่งของออนไลน์=온라인으로 주문하다
สั่งของ=주문하다
ออเดอร์=주문 / 주문건
คำสั่งซื้อ=주문
รายการสั่งซื้อ=주문 내역
สินค้า=상품
ของที่สั่ง=주문한 물건 / 주문한 상품
ร้านค้า=상점 / 판매자
ผู้ขาย/คนขาย=판매자
ลูกค้า=고객
แอป=앱
เว็บไซต์=웹사이트
Naver Shopping=네이버쇼핑
ช้อปปี้/Shopee=쇼피
ลาซาด้า/Lazada=라자다
AliExpress=알리익스프레스
ตะกร้า=장바구니
ใส่ตะกร้า=장바구니에 담다
ของหมด=품절
มีของไหม=재고 있어요?
พร้อมส่ง=바로 배송 가능
ของแท้=정품
ของปลอม=가품 / 짝퉁
รีวิว=리뷰
`;

const ONLINE_ORDER_PAYMENT_VOCAB = `
[Order / Payment]
ราคาเท่าไหร่=가격이 얼마예요?
รวมส่งไหม=배송비 포함인가요?
ค่าส่งเท่าไหร่=배송비가 얼마예요?
ฟรีค่าส่ง=무료배송
ส่วนลด=할인
คูปอง=쿠폰
ชำระเงิน=결제하다
จ่ายเงิน=결제하다
ชำระแล้ว=결제했어요
ยังไม่ได้ชำระ=아직 결제하지 않았어요
โอนเงินแล้ว=입금했어요
บัตรเครดิต=신용카드
เก็บเงินปลายทาง=착불 / 현금결제 배송 / COD
ใบเสร็จ=영수증
หักเงินแล้วแต่คำสั่งซื้อไม่ขึ้น=돈은 빠져나갔는데 주문이 안 보여요
`;

const ONLINE_DELIVERY_PARCEL_VOCAB = `
[Delivery / Parcel]
พัสดุ=택배
จัดส่ง=배송
จัดส่งแล้ว=배송완료
พัสดุจัดส่งแล้ว=배송 완료된 택배
ตามพัสดุ=택배를 확인하다 / 배송 상태를 확인하다
ตามของ=주문한 물건을 확인하다
ส่งพัสดุ=택배를 보내다
รับพัสดุ=택배를 받다
บริษัทขนส่ง=택배사
คนส่งของ=택배 기사님
เลขพัสดุ=운송장번호 / 송장번호
เลขแทร็ก/เลขแทรค=운송장번호 / 배송 추적 번호
เช็คพัสดุ=배송 조회하다
ของถึงไหนแล้ว=택배가 어디쯤 왔어요?
ของยังไม่ถึง=택배가 아직 도착하지 않았어요
พัสดุหาย=택배가 분실됐어요
ส่งผิดบ้าน=다른 집으로 배송됐어요
ที่อยู่ผิด=주소가 잘못됐어요
ไม่เห็นพัสดุ=택배가 안 보여요
ไม่เห็นของ=택배가 안 보여요
ไม่เห็นที่หน้าห้อง=문 앞에 택배가 안 보여요
ไม่เห็นที่หน้าประตู=문 앞에 택배가 안 보여요
หน้าห้อง=문 앞 / 현관 앞
หน้าประตู=문 앞 / 현관 앞
วางไว้หน้าประตู=문 앞에 놓아 주세요
ฝากไว้ที่ยาม=경비실에 맡겨 주세요
โทรมาก่อนส่ง=배송 전에 전화해 주세요
`;

const ONLINE_RETURN_REFUND_VOCAB = `
[Return / Refund / Claim]
คืนสินค้า=반품하다
ขอคืนสินค้า=반품 신청하고 싶어요
คืนเงิน=환불
ขอคืนเงิน=환불해 주세요
เปลี่ยนสินค้า=교환하다
ขอเปลี่ยนสินค้า=교환하고 싶어요
เคลมสินค้า=클레임 신청하다 / AS 요청하다
ยกเลิกออเดอร์=주문을 취소하다
ของผมพัง=제가 주문한 물건이 망가졌어요
ของฉันพัง=제가 주문한 물건이 망가졌어요
ของหนูพัง=제가 주문한 물건이 망가졌어요
สินค้าพัง=상품이 망가졌어요
สินค้าเสีย=상품이 불량이에요
ของเสีย=불량품이에요 / 상품이 고장 났어요
ของแตก=상품이 깨졌어요 / 파손됐어요
ของชำรุด=상품이 파손됐어요 / 불량이에요
ของไม่ตรงปก=상품이 설명과 달라요 / 사진과 달라요
ส่งผิด=잘못 배송됐어요 / 다른 상품이 왔어요
ได้ของผิด=다른 상품을 받았어요
ได้ของไม่ครบ=상품이 누락됐어요 / 일부만 왔어요
ไซซ์ผิด=사이즈가 잘못 왔어요
สีผิด=색상이 잘못 왔어요
แตกตั้งแต่ได้รับของ=받았을 때부터 깨져 있었어요
มีรูปหลักฐาน=증거 사진이 있어요
ค่าคืนสินค้าต้องใครจ่าย=반품 배송비는 누가 부담해요?
`;

const ONLINE_SELLER_CHAT_VOCAB = `
[Seller chat / Customer service]
ทักร้าน=판매자에게 문의하다
แชทร้าน=판매자와 채팅하다
ร้านยังไม่ตอบ=판매자가 아직 답장을 안 했어요
ติดต่อร้านไม่ได้=판매자와 연락이 안 돼요
ส่งรูปให้ดู=사진을 보내 드릴게요
ส่งวิดีโอให้ดู=영상을 보내 드릴게요
ขอรายละเอียดสินค้า=상품 상세 정보를 알려 주세요
ขนาดเท่าไหร่=사이즈가 어떻게 돼요?
มีประกันไหม=보증이 있어요?
ฝ่ายบริการลูกค้า=고객센터
ร้องเรียน=불만 접수하다 / 항의하다
รีวิวไม่ดี=나쁜 리뷰
ให้คะแนนต่ำ=낮은 별점을 주다
`;
 

const KOREAN_SHORT_RESPONSE_AMBIGUITY_VOCAB = `
[Korean short response ambiguity]
네=ครับ/ค่ะ, ใช่, ได้, รับทราบ — do not always translate as ใช่
예=ครับ/ค่ะ, ใช่, ได้, รับทราบ — more formal than 네
네, 안녕하세요=ครับ/ค่ะ สวัสดีครับ/ค่ะ
네, 알겠습니다=ครับ/ค่ะ เข้าใจแล้วครับ/ค่ะ
네, 맞아요=ครับ/ค่ะ ถูกต้องครับ/ค่ะ
네, 괜찮아요=ครับ/ค่ะ ไม่เป็นไรครับ/ค่ะ
네, 잠시만요=ครับ/ค่ะ รอสักครู่ครับ/ค่ะ
그래요=อย่างนั้นเหรอ / ใช่ / ได้, depending on context
그래요?=อย่างนั้นเหรอครับ/คะ
아 그래요=อ๋อ อย่างนั้นเหรอครับ/คะ
아 그렇군요=อ๋อ เข้าใจแล้วครับ/ค่ะ
그렇군요=เข้าใจแล้วครับ/ค่ะ / อย่างนั้นเหรอครับ/คะ
그렇죠=ใช่ครับ/ค่ะ / ใช่ไหมครับ/คะ, depending on punctuation and context
맞아요=ถูกต้องครับ/ค่ะ
맞죠?=ถูกใช่ไหมครับ/คะ
됐어요=พอแล้ว / ได้แล้ว / ไม่ต้องแล้ว, depending on context
다 됐어요=เสร็จหมดแล้วครับ/ค่ะ
이제 됐어요=ตอนนี้ได้แล้วครับ/ค่ะ / พอแล้วครับ/ค่ะ
안 해도 돼요=ไม่ต้องทำก็ได้ครับ/ค่ะ
가도 돼요=ไปได้ครับ/ค่ะ
해도 돼요=ทำได้ครับ/ค่ะ
하면 안 돼요=ทำไม่ได้ครับ/ค่ะ / ห้ามทำครับ/ค่ะ
괜찮아요=ไม่เป็นไร / โอเค / สบายดี / ใช้ได้, depending on context
괜찮으세요?=เป็นอะไรไหมครับ/คะ / โอเคไหมครับ/คะ
아니에요=ไม่ใช่ครับ/ค่ะ / ไม่เป็นไรครับ/ค่ะ
아니요, 괜찮아요=ไม่เป็นไรครับ/ค่ะ
잠깐만요=รอสักครู่ครับ/ค่ะ
잠시만요=รอสักครู่ครับ/ค่ะ
기다려 주세요=กรุณารอครับ/ค่ะ
이쪽으로 오세요=เชิญมาทางนี้ครับ/ค่ะ
저쪽으로 가세요=ไปทางนั้นครับ/ค่ะ
여기에 앉으세요=นั่งตรงนี้ครับ/ค่ะ
여기 서명해 주세요=เซ็นตรงนี้ครับ/ค่ะ
`;

const PUBLIC_OFFICE_VOCAB = `
[Public office / 주민센터]
주민센터=ศูนย์บริการชุมชน / สำนักงานเขตย่อย
동사무소=สำนักงานเขตย่อย
구청=สำนักงานเขต
시청=ศาลากลางเมือง / สำนักงานเมือง
민원실=ห้องบริการประชาชน
번호표=บัตรคิว
대기번호=หมายเลขคิว
접수하다=ลงทะเบียน / รับเรื่อง
신청서=ใบสมัคร / แบบคำร้อง
작성하다=กรอกเอกสาร
서명하다=เซ็นชื่อ
도장=ตราประทับ
신분증=บัตรประจำตัว
외국인등록증=บัตรต่างด้าว
여권=พาสปอร์ต
주소지=ที่อยู่ปัจจุบัน
주소 변경=เปลี่ยนที่อยู่
전입신고=แจ้งย้ายเข้า
전출신고=แจ้งย้ายออก
등본=สำเนาทะเบียน / เอกสารทะเบียน
초본=เอกสารทะเบียนแบบละเอียด
가족관계증명서=ใบรับรองความสัมพันธ์ครอบครัว
혼인관계증명서=ใบรับรองสถานภาพสมรส
출생증명서=สูติบัตร / ใบเกิด
번역공증=แปลและรับรองเอกสาร
공증=รับรองเอกสาร
원본=ต้นฉบับ
사본=สำเนา
복사본=สำเนาถ่ายเอกสาร
제출하다=ยื่นเอกสาร
발급하다=ออกเอกสาร
재발급=ออกใหม่
처리 기간=ระยะเวลาดำเนินการ
수수료=ค่าธรรมเนียม
번호표 뽑으세요=กดบัตรคิวก่อนครับ/ค่ะ
신청서 작성해 주세요=กรุณากรอกแบบฟอร์มครับ/ค่ะ
신분증 보여 주세요=ขอดูบัตรประจำตัวครับ/ค่ะ
서류가 부족해요=เอกสารยังไม่ครบครับ/ค่ะ
원본이 필요해요=ต้องใช้ตัวจริงครับ/ค่ะ
`;

const POLICE_ACCIDENT_REPORT_VOCAB = `
[Police / accident / report]
경찰서=สถานีตำรวจ
파출소=ป้อมตำรวจ
경찰관=ตำรวจ
신고하다=แจ้งความ / แจ้งเหตุ
신고 접수=รับแจ้งความ
신고 접수증=ใบรับแจ้งความ
사건번호=หมายเลขคดี
진술서=บันทึกคำให้การ
진술하다=ให้ปากคำ
피해자=ผู้เสียหาย
가해자=ผู้กระทำผิด
목격자=พยาน
증거=หลักฐาน
CCTV=กล้องวงจรปิด
블랙박스=กล้องหน้ารถ
도난=ถูกขโมย
분실=ทำหาย
폭행=ทำร้ายร่างกาย
협박=ข่มขู่
사기=โกง / ฉ้อโกง
교통사고=อุบัติเหตุจราจร
접촉사고=รถเฉี่ยว / รถชนเบา
뺑소니=ชนแล้วหนี
음주운전=เมาแล้วขับ
무면허=ไม่มีใบขับขี่
면허증=ใบขับขี่
보험 처리=ให้ประกันจัดการ
합의=การตกลงชดใช้ / ประนีประนอม
합의금=เงินชดเชย
벌금=ค่าปรับ
과태료=ค่าปรับทางปกครอง / ใบสั่ง
경찰에 신고해 주세요=ช่วยแจ้งตำรวจให้หน่อยครับ/ค่ะ
신고하고 싶어요=อยากแจ้งความครับ/ค่ะ
교통사고가 났어요=เกิดอุบัติเหตุรถชนครับ/ค่ะ
상대방이 도망갔어요=คู่กรณีหนีไปครับ/ค่ะ
보험 처리하고 싶어요=อยากให้ประกันจัดการครับ/ค่ะ
`;

const POST_CUSTOMS_VOCAB = `
[Post office / international parcel / customs]
우체국=ไปรษณีย์
국제택배=พัสดุระหว่างประเทศ
국제우편=ไปรษณีย์ระหว่างประเทศ
EMS=EMS
항공편=ทางอากาศ
선편=ทางเรือ
택배 접수=ฝากส่งพัสดุ
송장=ใบส่งของ / ใบปะหน้า
운송장번호=เลขพัสดุ
받는 사람=ผู้รับ
보내는 사람=ผู้ส่ง
주소=ที่อยู่
우편번호=รหัสไปรษณีย์
무게=น้ำหนัก
부피=ขนาดปริมาตร
배송비=ค่าส่ง
보험=ประกันพัสดุ
파손주의=ระวังแตก
취급주의=ระวังของเสียหาย
세관=ศุลกากร
통관=ผ่านศุลกากร
관세=ภาษีนำเข้า
금지품목=ของต้องห้าม
식품=อาหาร
액체류=ของเหลว
배터리=แบตเตอรี่
화장품=เครื่องสำอาง
중고물품=ของมือสอง
태국으로 택배 보내고 싶어요=อยากส่งพัสดุกลับไทยครับ/ค่ะ
배송비가 얼마예요?=ค่าส่งเท่าไหร่ครับ/คะ
며칠 걸려요?=ใช้เวลากี่วันครับ/คะ
세관에서 걸렸어요=ติดศุลกากรครับ/ค่ะ
금지품목이에요=เป็นของต้องห้ามครับ/ค่ะ
`;

const HOUSING_DETAIL_VOCAB = `
[Housing detailed]
부동산=ร้านนายหน้าอสังหา
중개인=นายหน้า
중개수수료=ค่านายหน้า
임대인=ผู้ให้เช่า
임차인=ผู้เช่า
임대차계약서=สัญญาเช่า
계약금=เงินทำสัญญา
보증금=เงินมัดจำ
월세=ค่าเช่ารายเดือน
전세=เช่าแบบวางเงินก้อน
관리비=ค่าส่วนกลาง
공과금=ค่าน้ำค่าไฟ / ค่าสาธารณูปโภค
전기세=ค่าไฟ
수도세=ค่าน้ำ
가스비=ค่าแก๊ส
인터넷비=ค่าอินเทอร์เน็ต
입주일=วันย้ายเข้า
퇴실일=วันย้ายออก
계약 만료=หมดสัญญา
계약 연장=ต่อสัญญา
해지=ยกเลิกสัญญา
위약금=ค่าปรับผิดสัญญา
원룸=ห้องเดี่ยว / one-room
투룸=ห้องสองห้อง / two-room
오피스텔=officetel
고시원=โกชีวอน
반지하=ห้องกึ่งใต้ดิน
옥탑방=ห้องดาดฟ้า
보일러=บอยเลอร์ / เครื่องทำน้ำร้อน
난방=ฮีตเตอร์ / ระบบทำความร้อน
에어컨=แอร์
누수=น้ำรั่ว
곰팡이=เชื้อรา
벌레=แมลง
바퀴벌레=แมลงสาบ
층간소음=เสียงดังจากห้องข้างบน/ข้างล่าง
방음=การกันเสียง
수리=ซ่อม
집주인=เจ้าของบ้าน
보증금은 언제 돌려받을 수 있어요?=เงินมัดจำจะคืนได้เมื่อไหร่ครับ/คะ
관리비에 뭐가 포함돼요?=ค่าส่วนกลางรวมอะไรบ้างครับ/คะ
물이 새요=น้ำรั่วครับ/ค่ะ
`;

const REPAIR_APPLIANCE_DEVICE_VOCAB = `
[Repair / appliance / device]
수리하다=ซ่อม
수리점=ร้านซ่อม
서비스센터=ศูนย์บริการ
고장 나다=เสีย
작동이 안 돼요=ใช้งานไม่ได้
전원이 안 켜져요=เปิดไม่ติด
전원이 꺼져요=เครื่องดับ
화면이 깨졌어요=หน้าจอแตก
화면이 안 나와요=หน้าจอไม่ขึ้น
소리가 안 나요=ไม่มีเสียง
충전이 안 돼요=ชาร์จไม่เข้า
배터리가 빨리 닳아요=แบตหมดเร็ว
물에 빠졌어요=ตกน้ำ
데이터 복구=กู้ข้อมูล
비밀번호를 잊어버렸어요=ลืมรหัสผ่าน
세탁기=เครื่องซักผ้า
냉장고=ตู้เย็น
에어컨=แอร์
전자레인지=ไมโครเวฟ
청소기=เครื่องดูดฝุ่น
세탁기가 탈수를 안 해요=เครื่องซักผ้าไม่ปั่นแห้ง
냉장고가 안 시원해요=ตู้เย็นไม่เย็น
에어컨이 시원하지 않아요=แอร์ไม่เย็น
수리비=ค่าซ่อม
견적=ใบประเมินราคา / ราคาประเมิน
`;

const SCHOOL_UNIVERSITY_VOCAB = `
[School / university]
대학교=มหาวิทยาลัย
학과=สาขาวิชา
전공=เอก / วิชาเอก
교수님=อาจารย์
강의=การบรรยาย / คาบเรียน
수업=คลาสเรียน
출석=การเข้าเรียน / เช็กชื่อ
결석=ขาดเรียน
지각=มาสาย
조퇴=ออกจากห้องก่อนเวลา
과제=งานส่ง / การบ้าน
발표=พรีเซนต์
시험=สอบ
중간고사=สอบกลางภาค
기말고사=สอบปลายภาค
성적=เกรด
성적표=ใบเกรด
성적증명서=ใบแสดงผลการเรียน
재학증명서=ใบรับรองการเป็นนักศึกษา
졸업증명서=ใบรับรองจบการศึกษา
휴학=พักการเรียน
복학=กลับเข้าเรียน
등록금=ค่าเทอม
장학금=ทุนการศึกษา
수강신청=ลงทะเบียนเรียน
학점=หน่วยกิต
졸업요건=เงื่อนไขจบการศึกษา
오늘 수업 있어요?=วันนี้มีเรียนไหมครับ/คะ
과제 제출했어요?=ส่งงานแล้วหรือยังครับ/คะ
`;

const HAIR_NAIL_SALON_VOCAB = `
[Hair / nail / salon]
미용실=ร้านทำผม
머리 자르다=ตัดผม
커트=ตัดผม
앞머리=หน้าม้า
옆머리=ผมด้านข้าง
뒷머리=ผมด้านหลัง
끝만 다듬다=เล็มปลายผม
짧게 잘라 주세요=ตัดสั้นให้หน่อย
조금만 잘라 주세요=ตัดออกนิดเดียว
펌=ดัดผม
매직=ยืดผม
염색=ทำสีผม
탈색=กัดสีผม
뿌리염색=เติมสีโคนผม
검은색=สีดำ
갈색=สีน้ำตาล
밝은 색=สีสว่าง
상한 머리=ผมเสีย
트리트먼트=ทรีตเมนต์
네일샵=ร้านทำเล็บ
젤네일=เล็บเจล
네일 제거=ล้างเล็บ
손톱=เล็บมือ
발톱=เล็บเท้า
속눈썹 연장=ต่อขนตา
눈썹 문신=สักคิ้ว
끝만 조금 다듬어 주세요=เล็มปลายผมนิดเดียวครับ/ค่ะ
너무 짧게 자르지 말아 주세요=อย่าตัดสั้นเกินไปครับ/ค่ะ
이 사진처럼 해 주세요=ทำแบบในรูปนี้ครับ/ค่ะ
`;

const HOSPITAL_ADMIN_CHECKUP_VOCAB = `
[Hospital admin / checkup]
접수=ลงทะเบียน / รับบัตรคิว
진료 접수=ลงทะเบียนพบหมอ
예약=จองคิว
예약 확인=ยืนยันการจอง
초진=มาครั้งแรก
재진=มาตรวจซ้ำ
문진표=แบบสอบถามอาการ
보험증=บัตรประกันสุขภาพ
건강보험=ประกันสุขภาพ
비급여=ไม่ครอบคลุมประกัน
진료비=ค่ารักษา
수납=ชำระเงิน
검사 결과=ผลตรวจ
정상=ปกติ
이상 있음=มีความผิดปกติ
추가 검사=ตรวจเพิ่ม
재검사=ตรวจซ้ำ
금식=งดอาหาร
공복=ท้องว่าง
혈압=ความดัน
체온=อุณหภูมิร่างกาย
맥박=ชีพจร
채혈=เจาะเลือด
소변검사=ตรวจปัสสาวะ
대변검사=ตรวจอุจจาระ
심전도=ตรวจคลื่นไฟฟ้าหัวใจ
내시경=ส่องกล้อง
위내시경=ส่องกล้องกระเพาะ
대장내시경=ส่องกล้องลำไส้ใหญ่
예약하셨어요?=ได้จองไว้ไหมครับ/คะ
처음 오셨어요?=มาครั้งแรกใช่ไหมครับ/คะ
문진표 작성해 주세요=กรุณากรอกแบบสอบถามอาการครับ/ค่ะ
오늘 금식하셨어요?=วันนี้งดอาหารมาไหมครับ/คะ
검사 결과는 언제 나와요?=ผลตรวจออกเมื่อไหร่ครับ/คะ
`;

const LABOR_DETAIL_VOCAB = `
[Labor detailed / accident at work]
노동청=สำนักงานแรงงาน
고용노동부=กระทรวงแรงงาน
산재=อุบัติเหตุจากการทำงาน / ประกันอุบัติเหตุงาน
산재보험=ประกันอุบัติเหตุจากการทำงาน
업무상 재해=บาดเจ็บจากการทำงาน
산재 신청=ยื่นเรื่อง 산재
임금체불=ค้างจ่ายค่าแรง
최저임금=ค่าแรงขั้นต่ำ
주휴수당=ค่าวันหยุดประจำสัปดาห์
연차수당=ค่าเงินวันลาพักร้อน
야근수당=ค่าโอทีกลางคืน
퇴직금=เงินแทจิก / เงินเกษียณ
해고예고수당=ค่าชดเชยกรณีเลิกจ้างไม่แจ้งล่วงหน้า
근로계약서=สัญญาจ้าง
계약 위반=ผิดสัญญา
무단결근=ขาดงานโดยไม่แจ้ง
사업장 변경=เปลี่ยนที่ทำงาน
근무시간=เวลาทำงาน
휴게시간=เวลาพัก
일하다가 다쳤어요=บาดเจ็บระหว่างทำงานครับ/ค่ะ
산재 신청하고 싶어요=อยากยื่นเรื่องอุบัติเหตุจากการทำงานครับ/ค่ะ
월급을 못 받았어요=ยังไม่ได้รับเงินเดือนครับ/ค่ะ
퇴직금을 받을 수 있어요?=รับเงินแทจิกได้ไหมครับ/คะ
`;


const AIRPORT_IMMIGRATION_ROOM_VOCAB = `
[Airport immigration / ห้องเย็น / secondary inspection]
ห้องเย็น=ห้องตรวจสอบเพิ่มเติมของ ตม. / 2차 심사실 / 입국심사 조사실 / 대기실, not literal cold room unless food/storage context
ห้องเย็นที่สนามบิน=입국심사 2차 심사실 / 입국심사 조사실
ตม.=출입국심사 / 입국심사 / 출입국관리
เจ้าหน้าที่ ตม.=입국심사관 / 출입국 직원
ด่านตรวจคนเข้าเมือง=입국심사대
ตรวจคนเข้าเมือง=입국심사
เข้าเมือง=입국하다
จุดประสงค์ในการเข้าประเทศ=입국 목적
มาเที่ยว=관광하러 왔어요
มาดูคอนเสิร์ต=콘서트를 보러 왔어요
มาเยี่ยมเพื่อน=친구를 만나러 왔어요
พักที่ไหน=어디에서 지내세요?
ที่อยู่ที่พัก=숙소 주소
ใบจองโรงแรม=호텔 예약 확인서
ตั๋วขากลับ=귀국 항공권 / 왕복 항공권
แผนเที่ยว=여행 일정
หลักฐานการเงิน=재정 증명
จดหมายเชิญ=초청장
สัมภาษณ์เข้าเมือง=입국심사 인터뷰
ตรวจสอบเพิ่มเติม=추가 심사 / 2차 심사
พาไปห้องเย็น=2차 심사실로 데려가다
ถูกกักที่ ตม.=입국심사에서 대기하게 됐어요 / 억류됐어요
ปฏิเสธเข้าเมือง=입국 거부 / 입국 불허
ถูกส่งตัวกลับ=강제송환되다
입국 목적이 뭐예요?=จุดประสงค์ในการเข้าประเทศคืออะไรครับ/คะ
체류 기간이 얼마나 돼요?=จะอยู่กี่วันครับ/คะ
숙소 주소가 있어요?=มีที่อยู่ที่พักไหมครับ/คะ
왕복 항공권 있어요?=มีตั๋วไปกลับไหมครับ/คะ
호텔 예약 확인서 보여 주세요=ขอดูใบจองโรงแรมครับ/ค่ะ
2차 심사실로 가셔야 합니다=ต้องไปห้องตรวจสอบเพิ่มเติมของ ตม.ครับ/ค่ะ
`;

const AIRPORT_FLIGHT_VOCAB = `
[Airport / flight / baggage]
สนามบิน=공항
เที่ยวบิน=항공편
ตั๋วเครื่องบิน=항공권
สายการบิน=항공사
เช็กอินสายการบิน=항공사 체크인
โหลดกระเป๋า=수하물 위탁
กระเป๋าเดินทาง=캐리어 / 여행가방
กระเป๋าถือขึ้นเครื่อง=기내 수하물
น้ำหนักกระเป๋า=수하물 무게
น้ำหนักเกิน=초과 수하물
เคาน์เตอร์เช็กอิน=체크인 카운터
บอร์ดดิ้งพาส=탑승권
ประตูขึ้นเครื่อง=탑승구
ขึ้นเครื่อง=탑승하다
เครื่องดีเลย์=비행기가 지연됐어요 / 항공편이 지연됐어요
ยกเลิกเที่ยวบิน=항공편이 취소됐어요
ต่อเครื่อง=환승
รับกระเป๋า=수하물 찾기
กระเป๋าหาย=수하물이 없어졌어요
กระเป๋าเสียหาย=수하물이 파손됐어요
ผ่าน ตม.=입국심사를 통과하다
ตรวจศุลกากร=세관 검사
탑승구가 어디예요?=ประตูขึ้นเครื่องอยู่ที่ไหนครับ/คะ
항공편이 지연됐어요=เที่ยวบินดีเลย์ครับ/ค่ะ
수하물이 안 나와요=กระเป๋ายังไม่ออกครับ/ค่ะ
수하물이 없어졌어요=กระเป๋าหายครับ/ค่ะ
`;

const HOTEL_TRAVEL_STAY_VOCAB = `
[Hotel / tourist stay]
โรงแรม=호텔
เช็กอิน/เช็คอิน=체크인
เช็กเอาต์/เช็คเอาท์=체크아웃
จองห้อง=객실 예약
ห้องพัก=객실
ห้องเดี่ยว=싱글룸
ห้องคู่=더블룸 / 트윈룸
เตียงเดี่ยว=싱글 침대
เตียงคู่=더블 침대
อาหารเช้า=조식
ฝากกระเป๋า=짐 보관
คีย์การ์ด=객실 카드키
เลขห้อง=객실 번호
ชั้น=층
ลิฟต์=엘리베이터
ผ้าเช็ดตัว=수건
น้ำอุ่น=따뜻한 물
แอร์=에어컨
ฮีตเตอร์=난방
ห้องไม่สะอาด=방이 깨끗하지 않아요
แอร์ไม่เย็น=에어컨이 시원하지 않아요
น้ำอุ่นไม่ออก=따뜻한 물이 안 나와요
ขอเปลี่ยนห้อง=방을 바꿔 주세요
ฝากกระเป๋าได้ไหม=짐을 맡길 수 있을까요?
체크인하고 싶어요=อยากเช็กอินครับ/ค่ะ
체크아웃 몇 시예요?=เช็กเอาต์กี่โมงครับ/คะ
조식 포함인가요?=รวมอาหารเช้าไหมครับ/คะ
`;

const CONCERT_KPOP_ENTERTAINMENT_VOCAB = `
[Concert / K-pop / entertainment]
คอนเสิร์ต=콘서트
แฟนมีต/แฟนมีตติ้ง=팬미팅
บัตรคอนเสิร์ต=콘서트 티켓
บัตรยืน=스탠딩석
บัตรนั่ง=좌석
โซนที่นั่ง=구역
แถว=열
เลขที่นั่ง=좌석 번호
เข้างาน=입장
ประตูเข้างาน=입구
ของหน้างาน/กู๊ดส์=현장 굿즈 / 굿즈
สินค้าไอดอล=아이돌 굿즈
แท่งไฟ=응원봉
ถ่ายรูปได้ไหม=사진 찍어도 돼요?
ห้ามถ่ายวิดีโอ=영상 촬영 금지
บัตรหมด=매진됐어요
ไอดอล=아이돌
นักร้อง=가수
นักแสดง=배우
วงดนตรี=그룹
เกิร์ลกรุ๊ป=걸그룹
บอยแบนด์=보이그룹
แฟนคลับ=팬
เมน=최애
เมนรอง=차애
อัลบั้ม=앨범
โฟโต้การ์ด=포토카드
ลายเซ็น=사인
งานแจกลายเซ็น=팬사인회
BLACKPINK/แบล็กพิงก์/แบล็คพิงค์=블랙핑크
BTS=방탄소년단 / BTS
TWICE=트와이스
SEVENTEEN=세븐틴
Stray Kids=스트레이 키즈
NewJeans=뉴진스
aespa=에스파
IVE=아이브
LE SSERAFIM=르세라핌
사진 찍어도 돼요?=ถ่ายรูปได้ไหมครับ/คะ
영상 촬영 금지입니다=ห้ามถ่ายวิดีโอครับ/ค่ะ
응원봉 어디서 사요?=ซื้อแท่งไฟได้ที่ไหนครับ/คะ
`;

const TOURISM_PHOTO_ATTRACTION_VOCAB = `
[Tourism / photo / attraction]
สถานที่ท่องเที่ยว=관광지
ถ่ายรูป=사진 찍다
ช่วยถ่ายรูปให้หน่อย=사진 좀 찍어 주세요
จุดถ่ายรูป=포토존
ไปทางไหน=어디로 가요?
ใกล้สถานีไหน=어느 역에서 가까워요?
ต้องจองไหม=예약해야 해요?
เปิดกี่โมง=몇 시에 열어요?
ปิดกี่โมง=몇 시에 닫아요?
ค่าเข้าเท่าไหร่=입장료가 얼마예요?
คนเยอะไหม=사람 많아요?
ร้านดัง=유명한 가게
คาเฟ่ดัง=유명한 카페
พระราชวัง=궁궐
ตลาด=시장
ฮงแด=홍대
เมียงดง=명동
คังนัม=강남
นัมซาน=남산
경복궁=คยองบกกุง / พระราชวังคยองบก
남산타워=นัมซานทาวเวอร์
사진 좀 찍어 주세요=ช่วยถ่ายรูปให้หน่อยครับ/ค่ะ
입장료가 얼마예요?=ค่าเข้าเท่าไหร่ครับ/คะ
몇 시에 닫아요?=ปิดกี่โมงครับ/คะ
`;

const SHOPPING_TAXFREE_COSMETICS_VOCAB = `
[Shopping / tax refund / cosmetics]
ปลอดภาษี=면세
ดิวตี้ฟรี=면세점 / 듀티프리
คืนภาษี=택스리펀드 / 세금 환급
ทำ Tax refund ได้ไหม=택스리펀드 가능해요?
พาสปอร์ตต้องใช้ไหม=여권 필요해요?
ร้านเครื่องสำอาง=화장품 가게
Olive Young/โอลีฟยัง=올리브영
สกินแคร์=스킨케어
กันแดด=선크림
มาสก์หน้า=마스크팩
ลิปสติก=립스틱
รองพื้น=파운데이션
คุชชั่น=쿠션
โทนเนอร์=토너
เซรั่ม=세럼
ของแท้ไหม=정품이에요?
ลดราคาไหม=할인해요?
ใบเสร็จ=영수증
택스리펀드 가능해요?=ทำ Tax refund ได้ไหมครับ/คะ
여권 필요해요?=ต้องใช้พาสปอร์ตไหมครับ/คะ
정품이에요?=เป็นของแท้ไหมครับ/คะ
`;


const MASSAGE_PROFESSIONAL_SAFETY_VOCAB = `
[Professional massage / boundary safety]
นวด=마사지
นวดไทย=타이 마사지
นวดน้ำมัน=오일 마사지
นวดอโรม่า=아로마 마사지
นวดสปอร์ต=스포츠 마사지
นวดคอ=목 마사지
นวดไหล่=어깨 마사지
นวดหลัง=등 마사지
นวดเอว=허리 마사지
นวดขา=다리 마사지
นวดเท้า=발 마사지
กดแรงขึ้น=조금 더 세게 해 주세요
กดเบาลง=조금 약하게 해 주세요
เจ็บไหม=아프세요?
เจ็บตรงไหน=어디가 아프세요?
พลิกตัว=몸을 뒤집어 주세요
นอนคว่ำ=엎드려 주세요
นอนหงาย=바로 누워 주세요
ผ่อนคลาย=편하게 쉬세요
น้ำมันนวด=마사지 오일
ผ้าขนหนู=수건
ห้องเปลี่ยนเสื้อผ้า=탈의실
สเต็ปหนึ่ง/สเต็ปสอง/สเต็ปสาม=1단계/2단계/3단계 หรือ 1번 코스/2번 코스/3번 코스 ตามบริบท
คอร์ส=코스
เวลานวด=마사지 시간
ต่อเวลา=시간 연장

[Boundary / safety]
ที่นี่ให้บริการนวดเพื่อสุขภาพเท่านั้น=여기는 건강 마사지 서비스만 제공합니다.
ไม่มีบริการพิเศษ=특별 서비스는 없습니다.
ไม่มีบริการทางเพศ=성적인 서비스는 제공하지 않습니다.
กรุณาอย่าพูดแบบนั้น=그런 말씀은 하지 말아 주세요.
กรุณาให้เกียรติพนักงาน=직원을 존중해 주세요.
กรุณาอย่าแตะตัวพนักงาน=직원을 만지지 말아 주세요.
ถ้ายังพูดแบบนี้ จะหยุดบริการ=계속 그런 말씀을 하시면 서비스를 중단하겠습니다.
ถ้ายังทำแบบนี้ จะเรียกผู้จัดการ=계속 그러시면 매니저를 부르겠습니다.
ถ้ายังล่วงเกิน จะโทรแจ้งตำรวจ=계속 성희롱하시면 경찰에 신고하겠습니다.
ฉันรู้สึกไม่สบายใจ=저는 불쾌합니다.
ฉันรู้สึกไม่ปลอดภัย=저는 안전하지 않다고 느껴요.
นี่เป็นการล่วงละเมิดทางเพศ=이건 성희롱입니다.
กรุณาออกจากห้อง=방에서 나가 주세요.

[Risky customer phrases — understand and translate only]
특별 서비스 있어요?=มีบริการพิเศษไหม
2차 가능해요?=ไปต่อ/มีบริการต่อได้ไหม
추가 요금 내면 돼요?=ถ้าเพิ่มเงินได้ไหม
얼마 더 주면 돼요?=ต้องจ่ายเพิ่มเท่าไหร่
끝나고 같이 갈래요?=เสร็จแล้วไปด้วยกันไหม
개인적으로 만날 수 있어요?=เจอกันส่วนตัวได้ไหม
연락처 주세요=ขอเบอร์ติดต่อหน่อย
술 한잔할래요?=ไปดื่มด้วยกันไหม
만져도 돼요?=จับได้ไหม
손 잡아도 돼요?=จับมือได้ไหม
몸매가 좋네요=รูปร่างดีนะ
남자친구 있어요?=มีแฟนหรือยัง
혼자 살아요?=อยู่คนเดียวไหม
어디 살아?=พักอยู่แถวไหน
손님이 성희롱 발언을 했어요=ลูกค้าพูดจาล่วงเกิน
손님이 직원을 만졌어요=ลูกค้าแตะตัวพนักงาน
손님이 나가지 않아요=ลูกค้าไม่ยอมออกไป
손님이 협박했어요=ลูกค้าข่มขู่
매니저를 불러 주세요=ช่วยเรียกผู้จัดการ
경찰에 전화해 주세요=ช่วยโทรตำรวจ
`;

const PHARMACY_WOMEN_HEALTH_VOCAB = `
[Pharmacy / women health / medicine]
ร้านขายยา=약국
ยา=약
เภสัชกร=약사
ใบสั่งยา=처방전
ต้องใช้ใบสั่งยา=처방전이 필요해요
ไม่ต้องใช้ใบสั่งยา=처방전 없이 살 수 있어요
ยาเม็ด=알약 / 정제
ยาแคปซูล=캡슐
ยาน้ำ=시럽 / 물약
ยาทา=연고
แผ่นแปะ=패치
ยาแก้ปวด=진통제
พาราเซตามอล=아세트아미노펜 / 타이레놀 계열
ไอบูโพรเฟน=이부프로펜
ยาแก้อักเสบ=소염제
ยาปฏิชีวนะ/ยาฆ่าเชื้อ=항생제
ยาแก้แพ้=알레르기약 / 항히스타민제
ยาแก้ไอ=기침약
ยาแก้เจ็บคอ=인후통 약
ยาแก้ท้องเสีย=설사약
ยาแก้ท้องผูก=변비약
ยาลดกรด=제산제
ยาแก้เมารถ=멀미약
ยานอนหลับ=수면제
ยาหยอดตา=안약
สเปรย์พ่นจมูก=코 스프레이
แพ้ยา=약 알레르기가 있어요
ผลข้างเคียง=부작용
กินหลังอาหาร=식후에 복용하세요
กินก่อนอาหาร=식전에 복용하세요
วันละกี่ครั้ง=하루에 몇 번 복용해요?

[Contraception / sexual health / women health]
ยาคุมกำเนิด=피임약
ยาคุมฉุกเฉิน=사후피임약 / 응급피임약
ถุงยางอนามัย=콘돔
เจลหล่อลื่น=윤활젤
ที่ตรวจครรภ์/ชุดตรวจครรภ์=임신 테스트기
ตั้งครรภ์=임신
ประจำเดือน/เมนส์=생리
ปวดท้องประจำเดือน=생리통
ประจำเดือนมาไม่ปกติ=생리가 불규칙해요
เลือดออกผิดปกติ=비정상 출혈
ตกขาว=질 분비물
คันช่องคลอด=질 가려움
ช่องคลอดอักเสบ=질염
ปัสสาวะแสบ=소변 볼 때 아파요
กระเพาะปัสสาวะอักเสบ=방광염
โรคติดต่อทางเพศสัมพันธ์=성병 / 성매개감염
ตรวจโรคติดต่อทางเพศ=성병 검사를 받고 싶어요
ฉันต้องการปรึกษาเภสัชกร=약사님과 상담하고 싶어요
ยานี้กินยังไง=이 약은 어떻게 먹어요?
ยานี้มีผลข้างเคียงอะไรไหม=이 약은 부작용이 있어요?
`;

const DO_NOT_HARD_MAP_AMBIGUOUS_KOREAN_VOCAB = `
[Do not hard-map these Korean words]
네=ครับ/ค่ะ / ใช่ / ได้ / รับทราบ depending on context
그래요=ใช่ / อย่างนั้นเหรอ / ได้ depending on context
됐어요=ได้แล้ว / พอแล้ว / ไม่ต้องแล้ว depending on context
괜찮아요=ไม่เป็นไร / โอเค / สบายดี depending on context
아니에요=ไม่ใช่ / ไม่เป็นไร depending on context
좋아요=ดี / ได้ / เอาแบบนี้ depending on context
잠깐만요=รอสักครู่ / เดี๋ยวก่อน depending on context
그러면=ถ้าอย่างนั้น / งั้น
일단=ก่อนอื่น / เอาไว้ก่อน
따로=แยกต่างหาก
그냥=เฉย ๆ / แค่ / ไม่ต้องพิเศษ
`;
