// api/translate.js
// ============================================================
// Nongnam Thai-Korean Interpreter API
// Stable trigger-based version
// Main focus:
// - Thai <-> Korean interpreter only
// - Isan dialect
// - Hospital sub-vocab: dental / body / wound / allergy
// - Mobile SIM / telecom
// - Online shopping / Coupang / parcel / refund / return
// - Used car / car repair
// - Hobby / fishing / snooker
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

    let cleanedText = normalizeAll(String(text || ''));
    cleanedText = addQuestionMarksLight(cleanedText, fromLang);

    const sourceLang = isThaiLang(fromLang) ? 'Thai' : 'Korean';
    const targetLang = sourceLang === 'Thai' ? 'Korean' : 'Thai';

    const unclearReply =
      targetLang === 'Korean'
        ? '잘 못 들었습니다. 다시 말씀해 주세요.'
        : 'ฟังไม่ชัด ช่วยพูดอีกครั้งได้ไหมคะ';

    const failReply =
      targetLang === 'Korean'
        ? '번역할 수 없습니다.'
        : 'ไม่สามารถแปลได้ค่ะ';

    const uiSit = detectSituationFromUIContext(context);
    const finalSit = autoDetectSituation(cleanedText, uiSit);

    const hard = hardTranslate(cleanedText, fromLang);
    if (hard) {
      logToSheetSafe(req, {
        fromLang,
        situation: finalSit,
        chars: cleanedText.length,
        keywords: detectKeywords(cleanedText, finalSit).join(', '),
        orig: cleanedText.substring(0, 160),
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
      orig: cleanedText.substring(0, 160),
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

function getCleanIP(req) {
  const ipHeader =
    req.headers['x-forwarded-for'] ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown';

  return String(ipHeader).split(',')[0].trim();
}

// ============================================================
// Normalization
// ============================================================

function normalizeAll(input) {
  let t = String(input || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const pairs = [
    [/ใหมครับ/g, 'ไหมครับ'],
    [/ใหมคะ/g, 'ไหมคะ'],
    [/ใหมค่ะ/g, 'ไหมคะ'],
    [/มัยครับ/g, 'ไหมครับ'],
    [/มัยคะ/g, 'ไหมคะ'],
    [/หรือปล่าว/g, 'หรือเปล่า'],
    [/ป่าว/g, 'หรือเปล่า'],

    // Coupang speech variants
    [/คู พัง/g, 'คู팡'],
    [/คูพัง/g, 'คู팡'],
    [/กู พัง/g, 'คู팡'],
    [/กูพัง/g, 'คู팡'],
    [/คู ปัง/g, 'คู팡'],
    [/คูปัง/g, 'คู팡'],
    [/คู ปอง/g, 'คู팡'],
    [/คูปอง/g, 'คู팡'],

    // Product damage, not Coupang
    [/ของ ผม พัง/g, 'ของผมพัง'],
    [/ของ ฉัน พัง/g, 'ของฉันพัง'],
    [/ของ หนู พัง/g, 'ของหนูพัง'],
    [/สินค้า พัง/g, 'สินค้าพัง'],
    [/ของ แตก/g, 'ของแตก'],
    [/สินค้า แตก/g, 'สินค้าแตก'],
    [/ของ ชำรุด/g, 'ของชำรุด'],
    [/สินค้า ชำรุด/g, 'สินค้าชำรุด'],

    // Online shopping
    [/สั่ง ของ/g, 'สั่งของ'],
    [/ซื้อ ของ ออนไลน์/g, 'ซื้อของออนไลน์'],
    [/ซื้อ ออนไลน์/g, 'ซื้อออนไลน์'],
    [/ส่ง พัสดุ/g, 'ส่งพัสดุ'],
    [/รับ พัสดุ/g, 'รับพัสดุ'],
    [/เลข พัสดุ/g, 'เลขพัสดุ'],
    [/เลข แทรค/g, 'เลขแทร็ก'],
    [/เลข แทร็ก/g, 'เลขแทร็ก'],
    [/เช็ค พัสดุ/g, 'เช็คพัสดุ'],
    [/คืน ของ/g, 'คืนสินค้า'],
    [/คืน สินค้า/g, 'คืนสินค้า'],
    [/เปลี่ยน สินค้า/g, 'เปลี่ยนสินค้า'],
    [/ของ ไม่ ตรง ปก/g, 'ของไม่ตรงปก'],
    [/ยก เลิก ออเดอร์/g, 'ยกเลิกออเดอร์'],
    [/เก็บ เงิน ปลาย ทาง/g, 'เก็บเงินปลายทาง'],
    [/ชำระ เงิน/g, 'ชำระเงิน'],

    // Telecom
    [/แอลจี/g, 'LG'],
    [/เเอลจี/g, 'LG'],
    [/เคที/g, 'KT'],
    [/เอสเคที/g, 'SKT'],
    [/ยู ซิม/g, '유심'],
    [/ยูซิม/g, '유심'],

    // Car
    [/ไฟแน้น/g, 'ไฟแนนซ์'],
    [/ไฟแนน/g, 'ไฟแนนซ์'],
    [/เลขไม/g, 'เลขไมล์'],
    [/ใบตรวจสภาพรถ/g, 'ใบตรวจสภาพ'],
    [/ใบเช็คสภาพรถ/g, 'ใบตรวจสภาพ'],

    // Isan fishing
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

    // Fishing bait
    [/ไส้ เดือน/g, 'ไส้เดือน'],
    [/ขี้ กะ เดียน/g, 'ขี้กะเดียน'],
    [/ขี้ กะ เดี้ย/g, 'ขี้กะเดี้ย'],
    [/ขี้ ไก่ เดียน/g, 'ขี้ไก่เดียน'],
    [/ขี้ ไก่ เดี้ย/g, 'ขี้ไก่เดี้ย'],
    [/ส่อน กุ้ง/g, 'ส่อนกุ้ง'],
    [/ช้อน กุ้ง/g, 'ส่อนกุ้ง'],
    [/ซ่อน กุ้ง/g, 'ส่อนกุ้ง'],

    // Isan time and ceremony
    [/มื้อ นี่/g, 'มื้อนี้'],
    [/มื้อ นี้/g, 'มื้อนี้'],
    [/มื้อ อื่น/g, 'มื้ออื่น'],
    [/มื้อ วาน/g, 'มื้อวาน'],
    [/บ้าน งาน/g, 'บ้านงาน'],
    [/กิน ดอง/g, 'กินดอง'],

    // Isan food
    [/ก้อย เนื้อ/g, 'ก้อยเนื้อ'],
    [/ก้อย กุ้ง/g, 'ก้อยกุ้ง'],
    [/ปลา ร้า/g, 'ปลาร้า'],
    [/ปลา แดก/g, 'ปลาแดก'],
    [/ตำ บัก หุ่ง/g, 'ตำบักหุ่ง'],
    [/ปลาร้า บอง/g, 'ปลาร้าบอง'],
    [/แจ่ว บอง/g, 'แจ่วบอง'],

    // Dental high risk
    [/ฟันคุดของฉันอยู่ใกล้เส้นประสาท/g, 'ฟันคุดฉันใกล้กับเส้นประสาท'],
    [/ฟันคุดของผมอยู่ใกล้เส้นประสาท/g, 'ฟันคุดฉันใกล้กับเส้นประสาท'],
    [/ฟันคุดผมอยู่ใกล้เส้นประสาท/g, 'ฟันคุดฉันใกล้กับเส้นประสาท'],
    [/ฟัน คุด/g, 'ฟันคุด'],
    [/ถอน ฟันคุด/g, 'ถอนฟันคุด'],
    [/ผ่า ฟันคุด/g, 'ผ่าฟันคุด'],
    [/เส้น ประสาท/g, 'เส้นประสาท'],
    [/ไก่กับเส้นประสาท/g, 'ใกล้กับเส้นประสาท'],

    // Wound / pus
    [/เป็น หนอง/g, 'เป็นหนอง'],
    [/มี หนอง/g, 'มีหนอง'],
    [/แผล เป็นหนอง/g, 'แผลเป็นหนอง'],

    // Water place
    [/ห้วย หนอง คลอง บึง/g, 'ห้วยหนองคลองบึง'],
    [/หนอง น้ำ/g, 'หนองน้ำ'],
    [/ไป ใส่ เบ็ด/g, 'ไปใส่เบ็ด'],
    [/ใส่ เบ็ด/g, 'ใส่เบ็ด']
  ];

  for (const [from, to] of pairs) {
    t = t.replace(from, to);
  }

  // Light repeated speech cleanup
  t = t.replace(/(.{3,40})\1{3,}/g, '$1');
  t = t.replace(/\b(네|예|아니요|맞아요|그래요)\s*\1\s*\1\s*/g, '$1 ');
  t = t.replace(/(ครับ|ค่ะ|คะ)\s*\1\s*\1/g, '$1');

  return t.trim();
}

function addQuestionMarksLight(text, fromLang) {
  const t = String(text || '').trim();
  if (!t) return t;
  if (/[?？]$/.test(t)) return t;

  if (isThaiLang(fromLang)) {
    const thaiQuestion =
      /(ไหม|มั้ย|หรือเปล่า|หรือไม่|เหรอ|หรอ|บ่|เบาะ|แม่นบ่|ได้ไหม|ได้บ่|อะไร|ใคร|ที่ไหน|อยู่ไส|ไปไส|เท่าไหร่|เท่าไร|กี่โมง|เมื่อไหร่|ยามใด๋|ยามได๋|ยังไง|อย่างไร|ทำไม)(ครับ|ค่ะ|คะ|เด้อ|เนาะ|น้อ|น้า)?$/;

    if (thaiQuestion.test(t)) return `${t}?`;
  } else {
    const koreanQuestion =
      /(까요|니까|나요|어요|예요|이에요|있어요|없어요|어때요|뭐예요|누구예요|어디예요|얼마예요)\??$/;

    if (koreanQuestion.test(t)) return `${t}?`;
  }

  return t;
}

// ============================================================
// Hard translate rules
// ============================================================

function hardTranslate(text, fromLang) {
  if (!isThaiLang(fromLang)) return '';

  const raw = String(text || '').trim();

  const compact = raw
    .replace(/\s+/g, '')
    .replace(/[?？。.!！,，]/g, '')
    .trim();

  // Coupang hard rules
  if (
    /คู팡|คูพัง|กูพัง|คูปัง/.test(compact) &&
    /(เช็คพัสดุ|พัสดุ|ของถึงไหน|เลขพัสดุ|เลขแทร็ก|배송|택배)/.test(compact)
  ) {
    return '쿠팡 앱에서 배송 조회는 어디서 해요?';
  }

  if (
    /คู팡|คูพัง|กูพัง|คูปัง/.test(compact) &&
    /(สั่งของ|ซื้อของ|ซื้อ|สั่ง|แอป|แอพ|주문|구매)/.test(compact)
  ) {
    return '쿠팡에서 주문한 건에 대해 문의하고 싶어요.';
  }

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

  if (/พัสดุยังไม่ถึง|ของยังไม่ถึง/.test(compact)) {
    return '택배가 아직 도착하지 않았어요.';
  }

  if (/ขอคืนเงิน/.test(compact)) {
    return '환불받을 수 있을까요?';
  }

  if (/ขอเปลี่ยนสินค้า|เปลี่ยนสินค้าได้ไหม/.test(compact)) {
    return '교환할 수 있을까요?';
  }

  // Dental high-risk hard rules
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

  if (/ถอนฟันคุด/.test(compact)) {
    return '사랑니를 발치하고 싶어요.';
  }

  if (/ผ่าฟันคุด/.test(compact)) {
    return '사랑니 수술 발치를 하고 싶어요.';
  }

  const map = {
    // Fishing / hobby
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

    // Isan common
    'เป็นจั่งได๋นิ': '어때요?',
    'อีหยัง': '뭐예요?',
    'เว้าเบิ่ง': '말해 봐요.',
    'เลิกงานแล้วบ่': '퇴근했어요?',
    'กินข้าวแล้วบ่': '밥 먹었어요?',

    // Online
    'แอปคู팡': '쿠팡 앱',
    'แอปกูพัง': '쿠팡 앱',
    'แอปคูพัง': '쿠팡 앱'
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
  if (/อีสาน|Isaan/.test(c)) return 'isaan';

  return 'general';
}

function autoDetectSituation(text, fallback = 'general') {
  const t = String(text || '');

  if (/ช่วยด้วย|ฉุกเฉิน|รถพยาบาล|ตำรวจ|โดนทำร้าย|ไฟไหม้|หมดสติ|119|112|응급|구급차|경찰|화재|의식/.test(t)) return 'emergency';

  if (shouldLoadDentalVocab(t) || shouldLoadMedicalBodyDetailVocab(t)) return 'hospital';
  if (shouldLoadOnlineShoppingVocab(t)) return 'online';
  if (shouldLoadMobileVocab(t)) return 'mobile';
  if (shouldLoadCarTradeVocab(t)) return 'car';
  if (shouldLoadHobbyVocab(t) || shouldLoadWaterPlaceVocab(t)) return 'hobby';

  if (/บ้านงาน|กินดอง|งานกินดอง|งานบุญ|บุญบ้าน|บุญข้าวจี่|บุญบั้งไฟ|บุญผะเหวด|กฐิน|ผ้าป่า|สงกรานต์|ลอยกระทง|บายศรี|สู่ขวัญ|ผูกแขน|งานศพ|หมอลำ|ลำซิ่ง/.test(t)) return 'isaan';

  if (/ก้อย|ลาบ|ต้มแซ่บ|ต้มส้ม|แกงอ่อม|ตำบักหุ่ง|ปลาแดก|ปลาร้า|แจ่วบอง|ปลาจ่อม|กุ้งจ่อม|ส้มหมู|ส้มเนื้อ|ส้มปลา|กุ้งเต้น|ซอยจุ๊/.test(t)) return 'isan_food';

  if (/ปวด|หมอ|ยา|โรงพยาบาล|ไข้|เจ็บ|คลินิก|ใบรับรองแพทย์|ตรวจเลือด|เอ็กซเรย์|ผ่าตัด|ท้องเสีย|แพ้ยา/.test(t)) return 'hospital';
  if (/เถ้าแก่|นายจ้าง|หัวหน้า|ลาออก|เงินเดือน|สัญญา|โรงงาน|โอที|สลิปเงินเดือน|ทำงาน|กะกลางคืน|กะเช้า|ของเสีย|งานเสีย|เครื่องเสีย/.test(t)) return 'work';
  if (/วีซ่า|กาม่า|บัตรต่างด้าว|ตม|พาสปอร์ต|ต่อวีซ่า|สถานทูต|กงสุล|ไฮโคเรีย|HiKorea|ทะเบียนบ้าน|สูติบัตร/.test(t)) return 'visa';
  if (/ธนาคาร|เปิดบัญชี|โอนเงิน|รายการเดินบัญชี|statement|ใบรับรองยอดเงิน|บัตรเอทีเอ็ม|สมุดบัญชี/.test(t)) return 'bank';
  if (/กุกมิน|กุ๊กมิน|เทจิก|แทจิก|ภาษี|ประกัน|คืนภาษี|ประกันสุขภาพ/.test(t)) return 'money';
  if (/ร้านอาหาร|เมนู|สั่งอาหาร|ห่อกลับ|กินข้าว|หิว|อยากกิน/.test(t)) return 'food';
  if (/แท็กซี่|รถเมล์|รถไฟ|สถานี|หลงทาง|ไปทางไหน|เดินทาง/.test(t)) return 'travel';
  if (/ห้องเช่า|บ้านเช่า|ค่าเช่า|มัดจำ|วอลเซ|โบจึง|ย้ายบ้าน|น้ำไม่ไหล|ไฟดับ/.test(t)) return 'housing';
  if (/ศัลยกรรม|เสริมจมูก|ทำตา|โบทอก|ฟิลเลอร์|ดูดไขมัน|ทำนม|จัดฟัน|เลเซอร์/.test(t)) return 'beauty';

  if (/아프|병원|의사|약|증상|진료|진단서|처방전|수술|검사|치아|사랑니/.test(t)) return 'hospital';
  if (/사장|공장|월급|계약|퇴사|야근|급여|근무/.test(t)) return 'work';
  if (/비자|여권|외국인등록|출입국|하이코리아|대사관|영사관/.test(t)) return 'visa';
  if (/은행|송금|계좌|잔액|거래내역|통장|체크카드/.test(t)) return 'bank';
  if (/택배|배송|쿠팡|주문|환불|반품|교환|결제/.test(t)) return 'online';

  if (looksLikeIsan(t)) return 'isaan';

  return fallback || 'general';
}

function looksLikeIsan(text) {
  const t = String(text || '');

  return /ข่อย|เจ้า|เฮา|เพิ่น|อ้าย|เอื้อย|บ่|แม่น|หยัง|ไผ|ไส|อยู่ไส|ไปไส|เว้า|เบิ่ง|เฮ็ด|ฟ้าว|พ้อ|เมือ|คัก|ม่วน|แซ่บ|เด้อ|เนาะ|น้อ|ซื่อหยัง|มื้อนี้|มื้ออื่น|มื้อวาน|เกิบ|ข่อยเสีย|ห่าขั่ว|ห่ากินหัว|ฮ่วย|ป๊าด|งึด|หนหวย/.test(t);
}

// ============================================================
// Trigger checks
// ============================================================

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
  return /ออนไลน์|สั่งของ|ซื้อของออนไลน์|ซื้อออนไลน์|คู팡|คูพัง|กูพัง|คูปัง|쿠팡|พัสดุ|택배|배송|ส่งพัสดุ|เลขพัสดุ|เลขแทร็ก|ของพัง|ของเสีย|ของแตก|ชำรุด|ของไม่ตรงปก|คืนสินค้า|คืนเงิน|เปลี่ยนสินค้า|ยกเลิกออเดอร์|เก็บเงินปลายทาง|환불|교환|반품|결제|장바구니|판매자/.test(t);
}

function shouldLoadOnlineOrderVocab(text) {
  const t = String(text || '');
  return /สั่งของ|ซื้อของออนไลน์|กดสั่ง|ออเดอร์|สั่งซื้อ|ตะกร้า|ชำระเงิน|จ่ายเงิน|บัตรเครดิต|คูปอง|ส่วนลด|주문|구매|장바구니|결제|쿠폰|할인/.test(t);
}

function shouldLoadDeliveryParcelVocab(text) {
  const t = String(text || '');
  return /พัสดุ|택배|배송|ส่งพัสดุ|รับพัสดุ|เลขพัสดุ|เลขแทร็ก|เช็คพัสดุ|ของถึงไหน|ของยังไม่ถึง|배송조회|운송장|송장번호|택배사/.test(t);
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
  return /ห้วย|หนองน้ำ|หนอง|คลอง|บึง|บ่อปลา|แม่น้ำ/.test(t) && /ซิดเบ็ด|ตกปลา|หาปลา|ใส่เบ็ด|ลงเบ็ด|เหยื่อ|คันเบ็ด|ไส้เดือน|ขี้กะเดียน/.test(t);
}

function shouldLoadThaiSiaAmbiguity(text) {
  const t = String(text || '');
  return /เสีย|ซะ|สิ|ของเสีย|งานเสีย|เครื่องเสีย|รถเสีย|เกิบเสีย|พัง|แตก|ชำรุด/.test(t);
}

function shouldLoadIsanBanterVocab(text) {
  const t = String(text || '');
  return /ห่า|ห่าขั่ว|ห่ากินหัว|บักห่า|ฮ่วย|ป๊าด|บักปึก|ตอแหล|งึด|หนหวย|มึง|กู/.test(t);
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

function buildVocabHint(text, finalSit, uiSit) {
  const sections = [VOCAB_CORE];

  if (finalSit === 'isaan' || looksLikeIsan(text)) {
    sections.push(ISAN_CORE_COMPACT, ISAN_AMBIGUITY_RULES);
  }

  if (VOCAB_BY_SITUATION[finalSit]) {
    sections.push(VOCAB_BY_SITUATION[finalSit]);
  } else if (VOCAB_BY_SITUATION[uiSit]) {
    sections.push(VOCAB_BY_SITUATION[uiSit]);
  }

  if (shouldLoadThaiSiaAmbiguity(text)) sections.push(THAI_SIA_AMBIGUITY_VOCAB);

  if (shouldLoadDentalVocab(text)) sections.push(DENTAL_VOCAB);
  if (shouldLoadMedicalBodyDetailVocab(text)) sections.push(MEDICAL_BODY_DETAIL_VOCAB);

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
    if (userGender === 'male') {
      return 'The Thai speaker is MALE. Korean output should be polite and natural.';
    }

    if (userGender === 'female') {
      return 'The Thai speaker is FEMALE. Korean output should be polite and natural.';
    }
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

THAI QUESTION DETECTION:
Words such as ไหม, มั้ย, หรือเปล่า, เหรอ, หรอ, อะไร, ใคร, ที่ไหน, อยู่ไส, ไปไส, เท่าไหร่, กี่โมง, เมื่อไหร่, ทำไม, ยังไง, ได้ไหม, ได้บ่, เบาะ, แม่นบ่ usually make the sentence a question.

ISAN CONTEXT:
- ซิดเบ็ด / ซิสเบ็ด / สิดเบ็ด / สิทเบ็ด / สิบเบ็ด / 10เบ็ด means ตกเบ็ด / ตกปลา / 낚시하다. Never treat as number ten.
- มื้อนี้ means วันนี้, not meal.
- มื้ออื่น means พรุ่งนี้, not another meal.
- มื้อวาน means เมื่อวาน.
- กินดอง means wedding feast / wedding ceremony, not eating pickled food.
- บ้านงาน means a house where a ceremony/event is held.
- หนอง in medical context means pus / 고름.
- หนอง in rural Isan/fishing/water context means pond / 연못.

ONLINE SHOPPING:
- คูพัง / กูพัง / คูปัง means 쿠팡 / Coupang app, NOT broken item.
- Only translate as broken item when phrase clearly says ของผมพัง / ของฉันพัง / ของหนูพัง / สินค้าพัง / ของแตก / ชำรุด.
- ของไม่ตรงปก = product does not match photo/description.
- เลขพัสดุ / เลขแทร็ก = 운송장번호.
- เก็บเงินปลายทาง = cash on delivery.
- Do not translate พัง as emotional breakdown when product/order context exists.

DENTAL SAFETY:
- ฟันคุด = 사랑니, never 충치 and never 앞니.
- ฟันผุ = 충치.
- ฟันหน้า = 앞니.
- เส้นประสาทฟัน = 치아 신경.

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
    /(저는 통역사|저는 AI|질문에 답변할 수|답변할 수 없습니다|설명해 드리|도와드릴 수 없습니다|I am an AI|I am an interpreter|cannot answer|cannot respond)/i;

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
    'ฟันคุด': 'ทันตกรรม/ฟันคุด',
    'เส้นประสาท': 'ทันตกรรม/เส้นประสาท',
    'ถอนฟัน': 'ทันตกรรม/ถอนฟัน',
    'ผ่าฟันคุด': 'ทันตกรรม/ผ่าฟันคุด',
    'เป็นหนอง': 'แผล/หนอง',
    'หนอง': 'หนอง/กำกวม',
    'กระดูก': 'กระดูก',
    'ข้อศอก': 'ข้อศอก',
    'เข่า': 'เข่า',

    'คู팡': 'ออนไลน์/Coupang',
    'คูพัง': 'ออนไลน์/Coupang',
    'กูพัง': 'ออนไลน์/Coupang',
    'คูปัง': 'ออนไลน์/Coupang',
    'สั่งของ': 'ออนไลน์/สั่งของ',
    'ซื้อของออนไลน์': 'ออนไลน์/ซื้อของ',
    'พัสดุ': 'ออนไลน์/พัสดุ',
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

    'ซิม': 'มือถือ/ซิม',
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
    'เถ้าแก่': 'นายจ้าง',
    'ธนาคาร': 'ธนาคาร',
    'โอนเงิน': 'โอนเงิน',
    'กุกมิน': 'ประกัน/กุกมิน',
    'เทจิก': 'เทจิก/ออกงาน'
  };

  for (const [kw, label] of Object.entries(keywordMap)) {
    if (t.includes(kw) && !found.includes(label)) {
      found.push(label);
    }
  }

  if (situation && !found.includes(`หมวด:${situation}`)) {
    found.unshift(`หมวด:${situation}`);
  }

  return found.slice(0, 12);
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

[Common ambiguity]
사장님 when Korean calls Thai person politely can mean คุณ/ท่าน, not always เถ้าแก่.
괜찮아요 can mean ไม่เป็นไร / โอเค / สบายดี depending on context.
네 means ครับ/ค่ะ/ใช่.
그래요 can mean ใช่ / อย่างนั้นเหรอ depending on tone.
`;

const SITUATION_CONTEXT = {
  general: '',
  hospital: 'Hospital/clinic. Thai user is usually the patient. Korean speaker may be doctor/nurse.',
  work: 'Workplace/factory. Focus on labor, boss, salary, overtime, resignation, contract, defective work, broken machine.',
  visa: 'Immigration/government/embassy. Focus on visa, alien registration card, documents, appointments.',
  bank: 'Bank. Focus on account, bank statement, transfer, balance certificate.',
  money: 'Money/insurance/tax. Focus on pension, severance pay, tax refund, insurance.',
  food: 'Restaurant/food. Focus on ordering food, taste, ingredients.',
  online: 'Online shopping / Coupang / parcel / delivery / refund / return / product claim / seller chat.',
  shop: 'Shopping/retail.',
  travel: 'Travel/directions/transportation.',
  housing: 'Housing/rent/utilities.',
  emergency: 'Emergency. Prioritize urgent help.',
  beauty: 'Beauty clinic/plastic surgery.',
  isaan: 'Isan dialect mode. Translate Isan meaning by context.',
  isan_food: 'Thai-Isan food context. Translate food names by meaning, not word-by-word.',
  mobile: 'Mobile phone / SIM card / telecom / phone bill / authentication code.',
  car: 'Used car buying/selling, car transfer, insurance, repair, vehicle inspection, financing.',
  hobby: 'Hobby/leisure context. Focus on fishing, fishing gear, bait, snooker, sports, karaoke, games, free-time activities.'
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
บ่=ไม่
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
