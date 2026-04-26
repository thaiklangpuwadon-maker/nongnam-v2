// api/translate.js
// ============================================================
// Nongnam Thai-Korean Interpreter API
// Real-user improved version
// Trigger-based vocabulary:
// - Isan dialect
// - Isan food
// - Isan ceremony/festival
// - SIM / mobile / telecom
// - Used car trade / car repair
// - Hobby / fishing / fishing gear / snooker / leisure
// - Thai ambiguity: เสีย / ซะ / สิ / lost / damaged
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

      // Optional analytics fields from frontend
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

    let cleanedText = String(text)
      .replace(/\r\n/g, '\n')
      .replace(/\u00A0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    cleanedText = preNormalizeCommon(cleanedText);
    cleanedText = preNormalizeIsan(cleanedText);
    cleanedText = preNormalizeHobby(cleanedText);
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

    const sitKeyFromUI = detectSituationFromUIContext(context);
    const finalSit = autoDetectSituation(cleanedText, sitKeyFromUI);

    const situationCtx =
      SITUATION_CONTEXT[finalSit] ||
      SITUATION_CONTEXT[sitKeyFromUI] ||
      '';

    const genderInstruction = buildGenderInstruction(fromLang, user_gender, partner_gender);
    const turnHint = buildTurnHint(fromLang, prev_turn);
    const topicHint = buildTopicHint(fromLang, last_th);
    const historyHint = buildHistoryHint(history);

    const vocabSections = [];

    vocabSections.push(VOCAB_CORE);

    if (finalSit === 'isaan' || looksLikeIsan(cleanedText)) {
      vocabSections.push(ISAN_CORE_COMPACT);
      vocabSections.push(ISAN_AMBIGUITY_RULES);
    }

    if (VOCAB_BY_SITUATION[finalSit]) {
      vocabSections.push(VOCAB_BY_SITUATION[finalSit]);
    } else if (VOCAB_BY_SITUATION[sitKeyFromUI]) {
      vocabSections.push(VOCAB_BY_SITUATION[sitKeyFromUI]);
    }

    const extraTriggeredVocab = buildExtraVocabByTriggers(cleanedText, finalSit, sitKeyFromUI);
    vocabSections.push(...extraTriggeredVocab);

    const vocabHint = vocabSections.filter(Boolean).join('\n\n');

    const systemPrompt = buildSystemPrompt({
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

    const ipHeader =
      req.headers['x-forwarded-for'] ||
      req.headers['x-real-ip'] ||
      req.socket?.remoteAddress ||
      'unknown';

    const cleanIP = String(ipHeader).split(',')[0].trim();

    console.log('USAGE:', JSON.stringify({
      time: new Date().toISOString(),
      fromLang,
      chars: cleanedText.length,
      situation: finalSit,
      inputTokens,
      outputTokens,
      totalTokens,
      model,
      ip: cleanIP
    }));

    logToSheet({
      fromLang,
      situation: finalSit,
      chars: cleanedText.length,
      keywords: detectKeywords(cleanedText, finalSit).join(', '),
      orig: cleanedText.substring(0, 160),
      trans: translation.substring(0, 160),
      normalized: cleanedText.substring(0, 160),
      userGender: user_gender || '',
      partnerGender: partner_gender || '',
      ip: cleanIP,
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
// Language helpers
// ============================================================

function isThaiLang(fromLang) {
  return fromLang === 'th' || fromLang === 'thai' || fromLang === 'TH';
}

function containsThai(s) {
  return /[ก-๙]/.test(String(s || ''));
}

function containsKorean(s) {
  return /[가-힣]/.test(String(s || ''));
}

// ============================================================
// Pre-normalization
// ============================================================

function preNormalizeCommon(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/ใหมครับ/g, 'ไหมครับ')
    .replace(/ใหมคะ/g, 'ไหมคะ')
    .replace(/ใหมค่ะ/g, 'ไหมคะ')
    .replace(/มัยครับ/g, 'ไหมครับ')
    .replace(/มัยคะ/g, 'ไหมคะ')
    .replace(/หรือปล่าว/g, 'หรือเปล่า')
    .replace(/ป่าว/g, 'หรือเปล่า')

    // Telecom speech variations
    .replace(/แอลจี/g, 'LG')
    .replace(/เเอลจี/g, 'LG')
    .replace(/เคที/g, 'KT')
    .replace(/เอสเคที/g, 'SKT')
    .replace(/ยูซิม/g, '유심')
    .replace(/ยู ซิม/g, '유심')

    // Car speech variations
    .replace(/ไฟแน้น/g, 'ไฟแนนซ์')
    .replace(/ไฟแนน/g, 'ไฟแนนซ์')
    .replace(/เลขไม/g, 'เลขไมล์')
    .replace(/ใบตรวจสภาพรถ/g, 'ใบตรวจสภาพ')
    .replace(/ใบเช็คสภาพรถ/g, 'ใบตรวจสภาพ')
    .trim();
}

function preNormalizeIsan(text) {
  return String(text || '')
    // ซิดเบ็ด / ตกปลา
    .replace(/10\s*เบ็ด/g, 'ซิดเบ็ด')
    .replace(/สิบ\s*เบ็ด/g, 'ซิดเบ็ด')
    .replace(/ซิส\s*เบ็ด/g, 'ซิดเบ็ด')
    .replace(/สิด\s*เบ็ด/g, 'ซิดเบ็ด')
    .replace(/สิท\s*เบ็ด/g, 'ซิดเบ็ด')
    .replace(/ซิสเบ็ด/g, 'ซิดเบ็ด')
    .replace(/สิดเบ็ด/g, 'ซิดเบ็ด')
    .replace(/สิทเบ็ด/g, 'ซิดเบ็ด')
    .replace(/ตก\s*เบ็ด/g, 'ตกเบ็ด')

    // Isan time / ceremony
    .replace(/มื้อ นี่/g, 'มื้อนี้')
    .replace(/มื้อ นี้/g, 'มื้อนี้')
    .replace(/มื้อ อื่น/g, 'มื้ออื่น')
    .replace(/มื้อ วาน/g, 'มื้อวาน')
    .replace(/บ้าน งาน/g, 'บ้านงาน')
    .replace(/กิน ดอง/g, 'กินดอง')

    // Isan food
    .replace(/ก้อย เนื้อ/g, 'ก้อยเนื้อ')
    .replace(/ก้อย กุ้ง/g, 'ก้อยกุ้ง')
    .replace(/ปลา ร้า/g, 'ปลาร้า')
    .replace(/ปลา แดก/g, 'ปลาแดก')
    .replace(/ตำ บัก หุ่ง/g, 'ตำบักหุ่ง')
    .replace(/ปลาร้า บอง/g, 'ปลาร้าบอง')
    .replace(/แจ่ว บอง/g, 'แจ่วบอง')
    .trim();
}

function preNormalizeHobby(text) {
  return String(text || '')
    // Fishing / hobby words often misheard
    .replace(/คัน เบ็ด/g, 'คันเบ็ด')
    .replace(/คัน เบ็ดตกปลา/g, 'คันเบ็ดตกปลา')
    .replace(/รอก ตกปลา/g, 'รอกตกปลา')
    .replace(/สาย เอ็น/g, 'สายเอ็น')
    .replace(/ตัว เบ็ด/g, 'ตัวเบ็ด')
    .replace(/เหยื่อ ปลา/g, 'เหยื่อปลา')
    .replace(/เหยื่อ ปลอม/g, 'เหยื่อปลอม')
    .replace(/เหยื่อ สด/g, 'เหยื่อสด')
    .replace(/ไส้ เดือน/g, 'ไส้เดือน')
    .replace(/กุ้ง ฝอย/g, 'กุ้งฝอย')
    .replace(/ส่อน กุ้ง/g, 'ส่อนกุ้ง')
    .replace(/ช้อน กุ้ง/g, 'ส่อนกุ้ง')
    .replace(/ซ่อน กุ้ง/g, 'ส่อนกุ้ง')
    .replace(/บ่อ ตก ปลา/g, 'บ่อตกปลา')
    .replace(/บ่อ ตกปลา/g, 'บ่อตกปลา')
    .replace(/ตก ปลา ทะเล/g, 'ตกปลาทะเล')
    .replace(/ตก ปลา น้ำจืด/g, 'ตกปลาน้ำจืด')

    // Snooker
    .replace(/แทง สนุ๊ก/g, 'แทงสนุ๊ก')
    .replace(/แทง สนุ้ก/g, 'แทงสนุ้ก')
    .replace(/เล่น สนุ๊ก/g, 'เล่นสนุ๊ก')
    .replace(/เล่น สนุ้ก/g, 'เล่นสนุ้ก')
    .replace(/โต๊ะ สนุ๊ก/g, 'โต๊ะสนุ๊ก')
    .replace(/โต๊ะ สนุ้ก/g, 'โต๊ะสนุ้ก')
    .replace(/ไม้ คิว/g, 'ไม้คิว')
    .replace(/ลูก สนุ๊ก/g, 'ลูกสนุ๊ก')
    .replace(/ลูก สนุ้ก/g, 'ลูกสนุ้ก')
    .trim();
}

function addQuestionMarksLight(text, fromLang) {
  const t = String(text || '').trim();
  if (!t) return t;
  if (/[?？]$/.test(t)) return t;

  if (isThaiLang(fromLang)) {
    const thaiQuestion =
      /(ไหม|มั้ย|หรือเปล่า|หรือไม่|เหรอ|หรอ|บ่|เบาะ|แม่นบ่|ได้ไหม|ได้บ่|อะไร|ใคร|ที่ไหน|อยู่ไส|ไปไส|เท่าไหร่|เท่าไร|กี่โมง|เมื่อไหร่|ยามใด๋|ยามได๋|ยังไง|อย่างไร|ทำไม)(ครับ|ค่ะ|คะ|เด้อ|เนาะ|น้อ|น้า)?$/;

    if (thaiQuestion.test(t)) return `${t}?`;

    if (/(ไหม|มั้ย|หรือเปล่า|ได้ไหม|ได้บ่|อยู่ไส|ไปไส|ชื่อหยัง|ซื่อหยัง|ยามใด๋|เท่าไหร่|ใช่ไหม|ถูกไหม)(ครับ|ค่ะ|คะ|เด้อ|เนาะ)?/.test(t)) {
      return `${t}?`;
    }
  } else {
    const koreanQuestion =
      /(까요|니까|나요|어요|예요|이에요|있어요|없어요|어때요|뭐예요|누구예요|어디예요|얼마예요)\??$/;

    if (koreanQuestion.test(t)) return `${t}?`;
  }

  return t;
}

// ============================================================
// Situation detection
// ============================================================

function detectSituationFromUIContext(context) {
  const c = String(context || '');

  if (c.includes('โรงพยาบาล') || c.includes('medical') || c.includes('hospital')) return 'hospital';
  if (c.includes('ทำงาน') || c.includes('แรงงาน') || c.includes('work')) return 'work';
  if (c.includes('ราชการ') || c.includes('วีซ่า') || c.includes('immigration') || c.includes('legal')) return 'visa';
  if (c.includes('ธนาคาร') || c.includes('bank')) return 'bank';
  if (c.includes('เงิน') || c.includes('ประกัน') || c.includes('tax') || c.includes('insurance')) return 'money';
  if (c.includes('ร้านอาหาร') || c.includes('food')) return 'food';
  if (c.includes('ช้อปปิ้ง') || c.includes('shop')) return 'shop';
  if (c.includes('เดินทาง') || c.includes('travel')) return 'travel';
  if (c.includes('ที่พัก') || c.includes('housing')) return 'housing';
  if (c.includes('ฉุกเฉิน') || c.includes('emergency')) return 'emergency';
  if (c.includes('ศัลยกรรม') || c.includes('ความงาม') || c.includes('beauty')) return 'beauty';
  if (c.includes('อีสาน') || c.includes('Isaan')) return 'isaan';

  return 'general';
}

function autoDetectSituation(text, fallback = 'general') {
  const t = String(text || '');

  if (/ช่วยด้วย|ฉุกเฉิน|รถพยาบาล|ตำรวจ|โดนทำร้าย|ไฟไหม้|หมดสติ|119|112/.test(t)) return 'emergency';
  if (/응급|구급차|경찰|도와|화재|의식/.test(t)) return 'emergency';

  if (shouldLoadMobileVocab(t)) return 'mobile';
  if (shouldLoadCarTradeVocab(t)) return 'car';
  if (shouldLoadHobbyVocab(t)) return 'hobby';

  if (/ซิดเบ็ด|ซิสเบ็ด|สิดเบ็ด|สิทเบ็ด|สิบเบ็ด|10เบ็ด|ตกเบ็ด|ตกปลา|หาปลา|ใส่เบ็ด/.test(t)) return 'hobby';

  if (/บ้านงาน|กินดอง|งานกินดอง|งานบุญ|บุญบ้าน|บุญข้าวจี่|บุญบั้งไฟ|บุญผะเหวด|กฐิน|ผ้าป่า|เข้าพรรษา|ออกพรรษา|สงกรานต์|ลอยกระทง|บายศรี|สู่ขวัญ|ผูกแขน|งานศพ|เผาศพ|สวดศพ|ใส่ซอง|หมอลำ|ลำซิ่ง/.test(t)) return 'isaan';

  if (/ก้อย|ลาบ|ต้มแซ่บ|ต้มส้ม|แกงอ่อม|ตำบักหุ่ง|ปลาแดก|ปลาร้า|แจ่วบอง|ปลาจ่อม|กุ้งจ่อม|ส้มหมู|ส้มเนื้อ|ส้มปลา|กุ้งเต้น|ซอยจุ๊|ดีขม/.test(t)) return 'isan_food';

  if (/ปวด|หมอ|ยา|โรงพยาบาล|ไข้|เจ็บ|คลินิก|ใบรับรองแพทย์|ตรวจเลือด|เอ็กซเรย์|ผ่าตัด|ท้องเสีย|แพ้ยา/.test(t)) return 'hospital';
  if (/เถ้าแก่|นายจ้าง|หัวหน้า|ลาออก|เงินเดือน|สัญญา|โรงงาน|โอที|สลิปเงินเดือน|ทำงาน|กะกลางคืน|กะเช้า|ของเสีย|งานเสีย|เครื่องเสีย/.test(t)) return 'work';
  if (/วีซ่า|กาม่า|บัตรต่างด้าว|ตม|พาสปอร์ต|ต่อวีซ่า|สถานทูต|กงสุล|ใบรับรองโสด|หนังสือมอบอำนาจ|ไฮโคเรีย|HiKorea|ทะเบียนบ้าน|สูติบัตร/.test(t)) return 'visa';
  if (/ธนาคาร|เปิดบัญชี|โอนเงิน|รายการเดินบัญชี|statement|ใบรับรองยอดเงิน|บัตรเอทีเอ็ม|สมุดบัญชี/.test(t)) return 'bank';
  if (/กุกมิน|กุ๊กมิน|เทจิก|แทจิก|ภาษี|ประกัน|คืนภาษี|ประกันสุขภาพ/.test(t)) return 'money';
  if (/ร้านอาหาร|เมนู|สั่งอาหาร|ห่อกลับ|กินข้าว|หิว|อยากกิน/.test(t)) return 'food';
  if (/แท็กซี่|รถเมล์|รถไฟ|สถานี|หลงทาง|ไปทางไหน|เดินทาง/.test(t)) return 'travel';
  if (/ห้องเช่า|บ้านเช่า|ค่าเช่า|มัดจำ|วอลเซ|โบจึง|ย้ายบ้าน|น้ำไม่ไหล|ไฟดับ/.test(t)) return 'housing';
  if (/ศัลยกรรม|เสริมจมูก|ทำตา|โบทอก|ฟิลเลอร์|ดูดไขมัน|ทำนม|จัดฟัน|เลเซอร์/.test(t)) return 'beauty';

  if (/아프|병원|의사|약|증상|진료|진단서|처방전|수술|검사/.test(t)) return 'hospital';
  if (/사장|공장|월급|계약|퇴사|야근|급여|근무/.test(t)) return 'work';
  if (/비자|여권|외국인등록|출입국|하이코리아|대사관|영사관/.test(t)) return 'visa';
  if (/은행|송금|계좌|잔액|거래내역|통장|체크카드/.test(t)) return 'bank';
  if (/국민연금|퇴직금|보험|세금|환급/.test(t)) return 'money';
  if (/택시|지하철|버스|환승|역/.test(t)) return 'travel';
  if (/성형|쌍꺼풀|코 수술|보톡스|필러|레이저/.test(t)) return 'beauty';

  if (looksLikeIsan(t)) return 'isaan';

  return fallback || 'general';
}

function looksLikeIsan(text) {
  const t = String(text || '');

  return /ข่อย|เจ้า|เฮา|เพิ่น|อ้าย|เอื้อย|บ่|แม่น|หยัง|ไผ|ไส|อยู่ไส|ไปไส|เว้า|เบิ่ง|เฮ็ด|ฟ้าว|พ้อ|เมือ|คัก|ม่วน|แซ่บ|เด้อ|เนาะ|น้อ|ซื่อหยัง|มื้อนี้|มื้ออื่น|มื้อวาน|เกิบ|ข่อยเสีย/.test(t);
}

// ============================================================
// Trigger-based vocab controls
// ============================================================

function shouldLoadIsanActivityVocab(text) {
  const t = String(text || '');
  return /ซิดเบ็ด|ซิสเบ็ด|สิดเบ็ด|สิทเบ็ด|สิบเบ็ด|10เบ็ด|ตกเบ็ด|ตกปลา|หาปลา|ใส่เบ็ด|เบ็ด|หนอง|คลอง|บ่อปลา|แม่น้ำ/.test(t);
}

function shouldLoadIsanFoodVocab(text, situation, uiSituation) {
  const t = String(text || '');

  const foodIntent =
    /อยากกิน|หิว|กิน|ซื่อกิน|ซื้อกิน|สั่ง|เฮ็ดกิน|ทำกิน|กับข้าว|แซ่บ|บ่แซ่บ|ร้านอาหาร|เมนู|ข้าว|ข้าวเหนียว|กับแกล้ม|ตำให้|เอาเผ็ด|ใส่ปลาร้า|บ่ใส่ปลาร้า/.test(t);

  const strongIsanFoodWords =
    /ก้อย|ลาบ|ต้มแซ่บ|ต้มส้ม|แกงอ่อม|อ่อม|หมก|ป่น|แจ่ว|แจ่วบอง|ปลาแดก|ปลาร้า|ปลาจ่อม|กุ้งจ่อม|ส้มตำ|ตำบักหุ่ง|ตำปูปลาร้า|ตำซั่ว|ตำมั่ว|ส้มหมู|ส้มเนื้อ|ส้มปลา|แหนม|กุ้งเต้น|ซอยจุ๊|ดีขม|ขมขม|ขมๆ|ข้าวคั่ว|ผักแพว|ไส้กรอกอีสาน/.test(t);

  const weakIsanFoodWords =
    /เผ็ดคัก|แซ่บคัก|ข้าวเหนียว|ข้าวคั่ว|ผักแพว|น้ำตก|ตับหวาน/.test(t);

  if (strongIsanFoodWords) return true;
  if ((situation === 'isaan' || uiSituation === 'isaan') && (foodIntent || weakIsanFoodWords)) return true;
  if ((situation === 'food' || uiSituation === 'food') && (foodIntent || strongIsanFoodWords)) return true;

  return false;
}

function shouldLoadIsanCeremonyVocab(text, situation, uiSituation) {
  const t = String(text || '');

  const ceremonyWords =
    /บ้านงาน|งานบ้าน|กินดอง|งานกินดอง|แต่งงาน|งานแต่ง|งานบุญ|บุญบ้าน|บุญข้าวจี่|บุญบั้งไฟ|บุญผะเหวด|บุญมหาชาติ|กฐิน|ผ้าป่า|เข้าพรรษา|ออกพรรษา|สงกรานต์|ลอยกระทง|ปีใหม่|แห่|ขบวนแห่|หมอลำ|ลำซิ่ง|บายศรี|สู่ขวัญ|ผูกแขน|ผูกข้อไม้ข้อมือ|งานศพ|เผาศพ|สวดศพ|ทำบุญ|ถวายพระ|ใส่บาตร|พระ|วัด|โรงทาน|ญาติพี่น้อง|เจ้าภาพ|ซองงาน|ช่วยงาน|ไปงาน/.test(t);

  const isanTimeOrSocial =
    /มื้อนี้|มื้ออื่น|มื้อวาน|มื้อฮือ|เซ้า|แลง|ค่ำ|ยามใด๋|ยามได๋|ยามเช้า|ยามแลง|พี่น้อง|หมู่บ้าน|ผู้เฒ่า|พ่อใหญ่|แม่ใหญ่/.test(t);

  return ceremonyWords || ((situation === 'isaan' || uiSituation === 'isaan') && isanTimeOrSocial);
}

function shouldLoadMobileVocab(text) {
  const t = String(text || '');

  return /ซิม|ซิมการ์ด|ยูซิม|유심|เบอร์|เบอร์โทร|โทรศัพท์|มือถือ|ค่าโทร|ค่าเน็ต|อินเทอร์เน็ต|เน็ตไม่ขึ้น|เน็ตช้า|ไม่มีสัญญาณ|เปิดซิม|เปิดเบอร์|ยกเลิกเบอร์|ยกเลิกซิม|เติมเงิน|ข้อความยืนยัน|รหัสยืนยัน|LG|KT|SKT|แอลจี|เคที|เอสเคที|통신사|휴대폰|전화번호|인증번호|미납|자동이체|명의/.test(t);
}

function shouldLoadCarTradeVocab(text) {
  const t = String(text || '');

  return /รถ|รถยนต์|รถมือสอง|ทะเบียน|เลขไมล์|ไมล์แท้|กิโล|โอนรถ|เล่มรถ|ประกันรถ|ประกันเหลือ|ภาษีรถ|ตรวจสภาพ|ใบตรวจสภาพ|อุบัติเหตุ|ชนหนัก|ชนเบา|ทำสี|สีเดิม|น้ำท่วม|จำนำ|ไฟแนนซ์|ผ่อน|ดาวน์|ดอกเบี้ย|ค่างวด|เจ้าของเดิม|ขายดาวน์|เปลี่ยนชื่อ|ค่าธรรมเนียมโอน|ยาง|แบตเตอรี่|เครื่องยนต์|เกียร์|เบรก|ช่วงล่าง|หม้อน้ำ|แอร์รถ|น้ำมันเครื่อง|ซ่อมรถ|อู่|ศูนย์บริการ|카센터|중고차|명의이전|보험|자동차세|사고차|무사고|침수차|주행거리|할부|리스|압류|저당/.test(t);
}

function shouldLoadHobbyVocab(text) {
  const t = String(text || '');

  return /งานอดิเรก|เวลาว่าง|พักผ่อน|ไปเที่ยว|เล่นกีฬา|ออกกำลังกาย|เล่นเกม|ดูหนัง|ถ่ายรูป|ร้องเพลง|คาราโอเกะ|노래방|취미|운동|게임|영화|사진|ตกปลา|ซิดเบ็ด|ซิสเบ็ด|สิดเบ็ด|สิทเบ็ด|สิบเบ็ด|10เบ็ด|คันเบ็ด|รอกตกปลา|รอก|สายเอ็น|ตัวเบ็ด|ทุ่น|ตะกั่ว|เหยื่อ|เหยื่อปลา|เหยื่อสด|เหยื่อปลอม|ไส้เดือน|กุ้งฝอย|ส่อนกุ้ง|ช้อนกุ้ง|ซ่อนกุ้ง|เหยื่อหมัก|บ่อตกปลา|ตกปลาทะเล|ตกปลาน้ำจืด|ปลากินเบ็ด|ปลาไม่กินเบ็ด|ปลาหลุด|낚시|낚싯대|릴|낚싯줄|미끼|지렁이|루어|낚시터|แทงสนุ๊ก|แทงสนุ้ก|เล่นสนุ๊ก|เล่นสนุ้ก|สนุ๊กเกอร์|สนุ้กเกอร์|โต๊ะสนุ๊ก|โต๊ะสนุ้ก|ไม้คิว|ลูกสนุ๊ก|ลูกสนุ้ก|ลูกขาว|ลูกแดง|แทงพลาด|แทงแม่น|당구|스누커|큐대|당구공/.test(t);
}

function shouldLoadThaiSiaAmbiguity(text, situation, uiSituation) {
  const t = String(text || '');

  return /เสีย|ซะ|สิ|ซิ|ของเสีย|งานเสีย|ทำงานเสีย|เครื่องเสีย|รถเสีย|เกิบเสีย|ข่อยเสีย|เสียเงิน|เสียเวลา|สูญหาย|หาย|พัง|ขาด|แตก|ใช้บ่ได้/.test(t);
}

function buildExtraVocabByTriggers(cleanedText, finalSit, uiSituation) {
  const extras = [];

  if (shouldLoadThaiSiaAmbiguity(cleanedText, finalSit, uiSituation)) {
    extras.push(THAI_SIA_AMBIGUITY_VOCAB);
  }

  if (shouldLoadIsanActivityVocab(cleanedText)) {
    extras.push(ISAN_ACTIVITY_FIXES);
  }

  if (shouldLoadIsanFoodVocab(cleanedText, finalSit, uiSituation)) {
    extras.push(ISAN_FOOD_VOCAB);
  }

  if (shouldLoadIsanCeremonyVocab(cleanedText, finalSit, uiSituation)) {
    extras.push(ISAN_CEREMONY_FESTIVAL_VOCAB);
  }

  if (shouldLoadMobileVocab(cleanedText)) {
    extras.push(MOBILE_SIM_VOCAB);
  }

  if (shouldLoadCarTradeVocab(cleanedText)) {
    extras.push(CAR_TRADE_VOCAB);
  }

  if (shouldLoadHobbyVocab(cleanedText)) {
    extras.push(HOBBY_FISHING_SNOOKER_VOCAB);
  }

  return extras;
}

// ============================================================
// Prompt construction
// ============================================================

function buildGenderInstruction(fromLang, userGender, partnerGender) {
  if (!isThaiLang(fromLang)) {
    if (partnerGender === 'female') {
      return `
[GENDER RULE - MANDATORY]
The Korean speaker is FEMALE.
Thai output should use female speech naturally.
Use: ดิฉัน / หนู / ค่ะ / คะ / นะคะ
Avoid male endings: ผม / ครับ / นะครับ
`;
    }

    if (partnerGender === 'male') {
      return `
[GENDER RULE - MANDATORY]
The Korean speaker is MALE.
Thai output should use male speech naturally.
Use: ผม / ครับ / นะครับ
Avoid female endings: ดิฉัน / ค่ะ / นะคะ
`;
    }
  } else {
    if (userGender === 'male') {
      return `
[GENDER RULE - MANDATORY]
The Thai speaker is MALE.
Korean output should be polite and natural.
`;
    }

    if (userGender === 'female') {
      return `
[GENDER RULE - MANDATORY]
The Thai speaker is FEMALE.
Korean output should be polite and natural.
`;
    }
  }

  return '';
}

function buildTurnHint(fromLang, prevTurn) {
  if (isThaiLang(fromLang)) return '';
  if (!prevTurn || prevTurn === 'none') return '';

  return `
[TURN CONTEXT]
The previous Thai message was a ${prevTurn === 'question' ? 'QUESTION' : 'STATEMENT'}.
Use this only to resolve ambiguous Korean responses such as 네, 그래요, 괜찮아요.
`;
}

function buildTopicHint(fromLang, lastThai) {
  if (isThaiLang(fromLang)) return '';
  if (!lastThai || !String(lastThai).trim()) return '';

  return `
[PREVIOUS THAI CONTEXT - DO NOT TRANSLATE]
${String(lastThai).trim().substring(0, 120)}
Use only to resolve ambiguous Korean words. Never include this Thai text in output.
`;
}

function buildHistoryHint(history) {
  if (!Array.isArray(history) || history.length === 0) return '';

  const safeHistory = history
    .slice(-3)
    .map((h, idx) => {
      const from = h?.from || h?.fromLang || '';
      const orig = String(h?.orig || '').substring(0, 80);
      const trans = String(h?.trans || '').substring(0, 80);
      return `${idx + 1}. ${from}: ${orig} -> ${trans}`;
    })
    .join('\n');

  if (!safeHistory) return '';

  return `
[RECENT CONVERSATION CONTEXT - DO NOT REPEAT]
${safeHistory}
Use only for context. Translate only the newest input.
`;
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
  const contextHint = context ? `\n[USER UI CONTEXT]\n${context}\n` : '';

  return `
You are "Nongnam", a professional Thai-Korean interpreter.

ABSOLUTE ROLE:
- You are a translation pipe between two people.
- Thai input -> Korean output only.
- Korean input -> Thai output only.
- Output translation only.
- Do not answer questions as yourself.
- Do not explain.
- Do not add notes.
- Do not summarize.
- Do not moralize.
- Do not add markdown.
- Preserve meaning, emotion, tone, questions, and statements.

SOURCE LANGUAGE: ${sourceLang}
TARGET LANGUAGE: ${targetLang}

${contextHint}
${situationCtx ? `[SITUATION]\n${situationCtx}\n` : ''}
${genderInstruction}
${turnHint}
${topicHint}
${historyHint}

CORE TRANSLATION RULES:
1. Translate the spoken sentence only.
2. Preserve questions as questions.
3. Preserve statements as statements.
4. Preserve names by sound. Never translate Thai or Korean names by meaning.
5. If input asks "คุณคือใคร" or "당신은 누구예요", translate the question. Never answer it.
6. If input is Isan dialect, convert meaning internally to standard Thai, then translate to Korean.
7. If Korean is ambiguous, use context but do not invent facts.
8. If audio is truly unclear, output exactly: ${unclearReply}
9. If the input is explicit sexual harassment or a direct violent threat, output exactly: ${failReply}

THAI QUESTION DETECTION:
Words such as ไหม, มั้ย, หรือเปล่า, เหรอ, หรอ, อะไร, ใคร, ที่ไหน, อยู่ไส, ไปไส, เท่าไหร่, กี่โมง, เมื่อไหร่, ทำไม, ยังไง, ได้ไหม, ได้บ่, เบาะ, แม่นบ่ usually make the sentence a question.

ISAN CONTEXT RULES:
- ซิดเบ็ด / ซิสเบ็ด / สิดเบ็ด / สิทเบ็ด / สิบเบ็ด / 10เบ็ด means ตกเบ็ด / ตกปลา / 낚시하다. Never treat 10เบ็ด as number ten.
- มื้อนี้ means วันนี้, not meal.
- มื้ออื่น means พรุ่งนี้, not another meal.
- มื้อวาน means เมื่อวาน.
- กินดอง means wedding feast / wedding ceremony, not eating pickled food.
- บ้านงาน means a house where a ceremony/event is held, not workplace house.
- เกิบ means shoes.
- If input is Isan slang or rural cultural context, translate meaning by context. Do not translate word-by-word.

REQUEST VS OFFER:
- ช่วย...ได้ไหม / ได้บ่ / ได้มั้ย = asking someone to help.
- จะ...ให้ / จะช่วย = offering to help.
Example:
ไม่มีรถ ช่วยส่งได้บ่ -> 차가 없어요. 데려다 줄 수 있어요?
Do not flip request into offer.

HOSPITAL ROLE:
If Thai speaker says คุณหมอ / ผมมาหาหมอ / มาตรวจร่างกาย, the Thai speaker is the patient, not the doctor.

HOBBY CONTEXT:
- เหยื่อ in fishing context means bait, not victim.
- รอก in fishing context means fishing reel, not waiting.
- แทงสนุ๊ก / แทงสนุ้ก means playing snooker/billiards, not stabbing.
- ส่อนกุ้ง means catching small shrimp with a net/basket, not hiding shrimp.

VOCABULARY:
${vocabHint}

FINAL OUTPUT:
Return only the translation in ${targetLang}. No explanation.
`.trim();
}

// ============================================================
// Anthropic call
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
    'ซิดเบ็ด': 'ตกปลา/ซิดเบ็ด',
    'ซิสเบ็ด': 'ตกปลา/ซิดเบ็ด',
    'สิดเบ็ด': 'ตกปลา/ซิดเบ็ด',
    'สิทเบ็ด': 'ตกปลา/ซิดเบ็ด',
    '10เบ็ด': 'ตกปลา/ซิดเบ็ด',
    'ตกปลา': 'ตกปลา',
    'คันเบ็ด': 'อุปกรณ์ตกปลา',
    'รอกตกปลา': 'อุปกรณ์ตกปลา',
    'รอก': 'อุปกรณ์ตกปลา',
    'สายเอ็น': 'อุปกรณ์ตกปลา',
    'เหยื่อ': 'เหยื่อตกปลา',
    'ไส้เดือน': 'เหยื่อตกปลา',
    'กุ้งฝอย': 'เหยื่อตกปลา',
    'ส่อนกุ้ง': 'จับกุ้ง/ตกปลา',
    'แทงสนุ๊ก': 'สนุ๊กเกอร์',
    'แทงสนุ้ก': 'สนุ๊กเกอร์',
    'สนุ๊กเกอร์': 'สนุ๊กเกอร์',
    'งานอดิเรก': 'งานอดิเรก',

    'ก้อย': 'อาหารอีสาน',
    'ก้อยเนื้อ': 'อาหารอีสาน',
    'ลาบ': 'อาหารอีสาน',
    'ตำบักหุ่ง': 'อาหารอีสาน',
    'ปลาร้า': 'อาหารอีสาน',
    'ปลาแดก': 'อาหารอีสาน',
    'ส้มหมู': 'อาหารอีสาน',
    'ส้มเนื้อ': 'อาหารอีสาน',
    'กุ้งเต้น': 'อาหารอีสาน',

    'กินดอง': 'งานแต่ง/กินดอง',
    'บ้านงาน': 'บ้านงาน/พิธี',
    'งานบุญ': 'งานบุญ',
    'งานศพ': 'งานศพ',
    'สงกรานต์': 'เทศกาล',
    'ลอยกระทง': 'เทศกาล',
    'บุญบั้งไฟ': 'เทศกาลอีสาน',
    'บายศรี': 'พิธีอีสาน',
    'สู่ขวัญ': 'พิธีอีสาน',
    'ผูกแขน': 'พิธีอีสาน',
    'มื้อนี้': 'คำบอกเวลาอีสาน',
    'มื้ออื่น': 'คำบอกเวลาอีสาน',
    'มื้อวาน': 'คำบอกเวลาอีสาน',

    'เกิบ': 'อีสาน/รองเท้า',
    'เสีย': 'คำกำกวม/เสีย',

    'ซิม': 'มือถือ/ซิม',
    'เบอร์': 'มือถือ/เบอร์โทร',
    'ค่าโทร': 'มือถือ/ค่าโทร',
    'ยอดค้าง': 'มือถือ/ยอดค้าง',
    'LG': 'มือถือ/LG',
    'KT': 'มือถือ/KT',
    'SKT': 'มือถือ/SKT',
    'หักเงินอัตโนมัติ': 'มือถือ/หักเงิน',

    'รถมือสอง': 'ซื้อขายรถยนต์',
    'โอนรถ': 'โอนรถ',
    'เลขไมล์': 'เลขไมล์',
    'ไมล์แท้': 'เลขไมล์',
    'ใบตรวจสภาพ': 'ใบตรวจสภาพรถ',
    'ประกันรถ': 'ประกันรถ',
    'ไฟแนนซ์': 'ไฟแนนซ์รถ',
    'ผ่อน': 'ผ่อนรถ',
    'ขายดาวน์': 'ขายดาวน์รถ',
    'ชนหนัก': 'ประวัติอุบัติเหตุ',
    'น้ำท่วม': 'รถน้ำท่วม',
    'ซ่อมรถ': 'ซ่อมรถ',

    'บัตรกาม่า': 'บัตรต่างด้าว',
    'กาม่า': 'บัตรต่างด้าว',
    'บัตรต่างด้าว': 'บัตรต่างด้าว',
    'วีซ่า': 'วีซ่า',
    'พาสปอร์ต': 'พาสปอร์ต',
    'สถานทูต': 'สถานทูต',

    'ใบรับรองแพทย์': 'ใบรับรองแพทย์',
    'หมอ': 'หมอ/โรงพยาบาล',
    'ยา': 'ยา',
    'ปวด': 'อาการปวด',
    'ไข้': 'ไข้',

    'เงินเดือน': 'เงินเดือน',
    'โอที': 'โอที',
    'สลิปเงินเดือน': 'สลิปเงินเดือน',
    'เถ้าแก่': 'นายจ้าง',

    'ธนาคาร': 'ธนาคาร',
    'โอนเงิน': 'โอนเงิน',
    'รายการเดินบัญชี': 'รายการเดินบัญชี',
    'statement': 'รายการเดินบัญชี',
    'ใบรับรองยอดเงิน': 'ใบรับรองยอดเงิน',

    'กุกมิน': 'ประกัน/กุกมิน',
    'กุ๊กมิน': 'ประกัน/กุกมิน',
    'เทจิก': 'เทจิก/ออกงาน',
    'แทจิก': 'เทจิก/ออกงาน'
  };

  for (const [kw, label] of Object.entries(keywordMap)) {
    if (t.includes(kw) && !found.includes(label)) {
      found.push(label);
    }
  }

  if (situation && !found.includes(`หมวด:${situation}`)) {
    found.unshift(`หมวด:${situation}`);
  }

  return found.slice(0, 10);
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

  const cost = (inputTokens / 1000) * inputPer1k + (outputTokens / 1000) * outputPer1k;

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

[Thai-Korean common ambiguity]
사장님 when Korean calls Thai person politely can mean คุณ/ท่าน, not always เถ้าแก่.
괜찮아요 can mean ไม่เป็นไร / โอเค / สบายดี depending on context.
네 means ครับ/ค่ะ/ใช่.
그래요 can mean ใช่ / อย่างนั้นเหรอ depending on tone.
`;

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
ค่อย=เดี๋ยว/ค่อยๆ depending on context
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
เจ้ากะดายเนาะ=คุณนี่ก็นะ / พี่ก็น้อ
มะซาง=มาสักที / กลับมาสักที depending on context
วาแท้=จริงๆนะ / ว่าจริงๆ
`;

const ISAN_AMBIGUITY_RULES = `
[Isan ambiguity rules]
อ้าย at beginning or end = older brother / friendly male address, not AI.
เอื้อย = older sister / friendly female address.
เกิบ = shoes.
เกิบเสีย = shoes are missing/lost, unless context says broken.
เกิบข่อยเสีย = my shoes are missing/lost.
เกิบข่อยขาด = my shoes are torn.
เกิบพื้นหลุด = shoe sole came off.
มื้อนี้ = today.
มื้ออื่น = tomorrow.
มื้อวาน = yesterday.
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

2) Lost / missing / wasted:
เกิบเสีย=신발이 없어졌어요 / 신발을 잃어버렸어요
เกิบข่อยเสีย=제 신발이 없어졌어요 / 제 신발을 잃어버렸어요
กระเป๋าข่อยเสีย=제 가방이 없어졌어요 / 제 가방을 잃어버렸어요
โทรศัพท์ข่อยเสีย=제 휴대폰이 없어졌어요 / 제 휴대폰을 잃어버렸어요, if context means missing
เสียเงิน=돈이 들었어요 / 돈을 잃었어요
เสียเวลา=시간을 낭비했어요
เสียโอกาส=기회를 잃었어요

3) Command particle:
Only interpret "เสีย" as "ซะ/สิ" when clear command markers exist:
รีบ..., ไป..., ทำให้เสร็จ..., กิน..., พูด..., ลอง..., เอา..., รีบทำ...
คุณรีบทำงานเสียสิ=빨리 일하세요
รีบทำงานซะสิ=빨리 일하세요
ไปทำงานเสีย=일하러 가세요 / 일하세요
ทำให้เสร็จเสีย=끝내세요

If context is workplace and sentence is only "คุณทำงานเสีย", interpret as damage/mistake, NOT command.
`;

const SITUATION_CONTEXT = {
  general: '',
  hospital: 'Hospital/clinic. Thai user is usually the patient. Korean speaker may be doctor/nurse.',
  work: 'Workplace/factory. Focus on labor, boss, salary, overtime, resignation, contract, defective work, broken machine.',
  visa: 'Immigration/government/embassy. Focus on visa, alien registration card, documents, appointments.',
  bank: 'Bank. Focus on account, bank statement, transfer, balance certificate.',
  money: 'Money/insurance/tax. Focus on pension, severance pay, tax refund, insurance.',
  food: 'Restaurant/food. Focus on ordering food, taste, ingredients.',
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
ปวดหัว=머리가 아프다
ปวดท้อง=배가 아프다
ปวดหลัง=허리가 아프다
มีไข้=열이 나다
เจ็บคอ=목이 아프다
ไอ=기침하다
น้ำมูก=콧물
ท้องเสีย=설사
อาเจียน=구토하다
แพ้ยา=약 알레르기가 있다
ใบรับรองแพทย์=진단서
ใบรับรองการรักษา=진료확인서
ใบเสร็จค่ารักษา=진료비 영수증
รายละเอียดค่ารักษา=진료비 세부내역서
ตรวจเลือด=피검사
เอ็กซเรย์=엑스레이
MRI=MRI
CT=CT
ใบสั่งยา=처방전
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
ใบหักภาษี=원천징수영수증
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
ซุลลิก=출입국관리사무소
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
แจ้งย้ายที่อยู่=전입신고
ใบรับรองข้อเท็จจริงเข้าออกประเทศ=출입국사실증명서
สถานทูตไทย=태국 대사관
สถานกงสุล=영사관
หนังสือมอบอำนาจ=위임장
แปลเอกสาร=서류 번역
แปลรับรอง=번역 공증
ใบรับรองโสด=미혼증명서
ใบสมรส=혼인증명서
ใบเกิด/สูติบัตร=출생증명서
ทะเบียนบ้าน=호적등본
E-9=E-9 비자
E-7-4=E-7-4 비자
E-7-4R=E-7-4R 비자
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
ลืมรหัส=비밀번호를 잊어버렸다
ใบรับรองบัญชี=계좌개설확인서
ใบรับรองยอดเงิน=잔액증명서
รายการเดินบัญชี=거래내역서
statement=거래내역서
รายการเดินบัญชี 3 เดือน=최근 3개월 거래내역서
รายการเดินบัญชี 6 เดือน=최근 6개월 거래내역서
รายการเดินบัญชี 1 ปี=최근 1년 거래내역서
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
ภาษีเงินได้=소득세
คืนภาษี=세금 환급
ยื่นภาษีประจำปี=연말정산
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

  shop: `
[Shopping]
ราคาเท่าไหร่=얼마예요?
แพงไป=너무 비싸요
ลดหน่อย=좀 깎아 주세요
ขอถุง=봉투 주세요
ขอใบเสร็จ=영수증 주세요
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
ราคาเท่าไหร่=비용이 얼마예요?
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

const ISAN_ACTIVITY_FIXES = `
[กิจกรรมอีสาน / คำที่ Speech Recognition มักฟังผิด]
ซิดเบ็ด=낚시하다 / ตกเบ็ด / ตกปลา
ซิสเบ็ด=ซิดเบ็ด / 낚시하다
สิดเบ็ด=ซิดเบ็ด / 낚시하다
สิทเบ็ด=ซิดเบ็ด / 낚시하다
สิบเบ็ด=ซิดเบ็ด ไม่ใช่เลข 10
10เบ็ด=ซิดเบ็ด ไม่ใช่เลข 10
ซิดเบ็ดอยู่ไส=어디서 낚시하고 있어요?
ไปซิดเบ็ด=낚시하러 가다
สิไปซิดเบ็ด=낚시하러 갈 거예요
มื้อนี้สิไปซิดเบ็ด=오늘 낚시하러 갈 거예요
ใส่เบ็ด=낚싯대를 놓다 / 낚시를 하다
ตกปลา=낚시하다
หาปลา=물고기를 잡다
บ่อปลา=낚시터 / 물고기 연못
หนองน้ำ=연못
คลอง=수로
แม่น้ำ=강
`;

const HOBBY_FISHING_SNOOKER_VOCAB = `
[งานอดิเรก / Hobby & Leisure]
งานอดิเรก=취미
เวลาว่าง=여가 시간 / 자유 시간
พักผ่อน=쉬다 / 휴식하다
ไปเที่ยว=놀러 가다
เล่นกีฬา=운동하다 / 스포츠를 하다
ออกกำลังกาย=운동하다
เล่นเกม=게임하다
ร้องเพลง=노래하다
คาราโอเกะ=노래방
ดูหนัง=영화 보다
ถ่ายรูป=사진 찍다
ขับรถเล่น=드라이브하다
เดินเล่น=산책하다
ปั่นจักรยาน=자전거를 타다
วิ่งออกกำลังกาย=조깅하다
ฟิตเนส=헬스장 / 피트니스
ฟุตบอล=축구
แบดมินตัน=배드민턴
วอลเลย์บอล=배구
บาสเกตบอล=농구
ว่ายน้ำ=수영
ปีนเขา=등산
ตั้งแคมป์=캠핑하다

[ตกปลา / Fishing]
ตกปลา=낚시하다
ซิดเบ็ด=낚시하다 / ตกเบ็ด / ตกปลา
ซิสเบ็ด=ซิดเบ็ด / 낚시하다
สิดเบ็ด=ซิดเบ็ด / 낚시하다
สิทเบ็ด=ซิดเบ็ด / 낚시하다
ไปซิดเบ็ด=낚시하러 가다
ไปตกปลา=낚시하러 가다
คันเบ็ด=낚싯대
คันเบ็ดตกปลา=낚싯대
รอกตกปลา / รอก=낚시 릴 / 릴
สายเอ็น=낚싯줄
สายหน้า=목줄
เบ็ด / ตัวเบ็ด=낚시바늘
ทุ่น=찌
ตะกั่วถ่วง=봉돌
ตะกร้อ=밑밥통 / 미끼통 ตามบริบท
สวิง=뜰채
กระชังปลา=살림망
กล่องใส่อุปกรณ์=태클박스
เหยื่อปลา=미끼
เหยื่อสด=생미끼
เหยื่อปลอม=루어 / 가짜 미끼
เหยื่อหมัก=발효 미끼
เหยื่อปั้น=떡밥
เหยื่อขนมปัง=빵 미끼
ไส้เดือน=지렁이
หนอน=구더기 / 애벌레
กุ้งฝอย=작은 새우
กุ้งเป็น=살아있는 새우
ส่อนกุ้ง=뜰채로 작은 새우를 잡다
ช้อนกุ้ง=뜰채로 작은 새우를 건지다
กุ้งตาย=죽은 새우
อาหารปลา=물고기 먹이
บ่อตกปลา=낚시터
บ่อตกกุ้ง=새우 낚시터
ตกปลาทะเล=바다낚시
ตกปลาน้ำจืด=민물낚시
ตกปลาตามคลอง=수로에서 낚시하다
ตกปลาตามแม่น้ำ=강에서 낚시하다
ตกปลาตามบ่อ=낚시터에서 낚시하다
ปลาไม่กินเบ็ด=물고기가 미끼를 안 물어요
ปลากินเบ็ดแล้ว=물고기가 미끼를 물었어요
ปลาติดเบ็ดแล้ว=물고기가 걸렸어요
ดึงเบ็ด=낚싯대를 당기다
วัดเบ็ด=챔질하다
ปลาหลุด=물고기를 놓쳤어요
สายขาด=낚싯줄이 끊어졌어요
เบ็ดเกี่ยวมือ=낚시바늘이 손에 걸렸어요
ได้ปลากี่ตัว=물고기 몇 마리 잡았어요?
วันนี้ปลาไม่กินเบ็ดเลย=오늘은 물고기가 미끼를 전혀 안 물어요
วันนี้ได้ปลาหลายตัว=오늘 물고기를 많이 잡았어요
ปลาตัวใหญ่=큰 물고기
ปลาตัวเล็ก=작은 물고기
ปลาดุก=메기
ปลานิล=틸라피아
ปลาช่อน=가물치
ปลาคาร์พ=잉어
ปลาไหล=장어
ปลาหมึก=오징어
กุ้ง=새우
หอย=조개
ปู=게

[สนุ๊กเกอร์ / Billiards / Snooker]
แทงสนุ๊ก=당구 치다 / 스누커 치다
แทงสนุ้ก=당구 치다 / 스누커 치다
เล่นสนุ๊กเกอร์=스누커를 치다 / 당구를 치다
เล่นสนุ้กเกอร์=스누커를 치다 / 당구를 치다
โต๊ะสนุ๊ก=당구대 / 스누커 테이블
โต๊ะสนุ้ก=당구대 / 스누커 테이블
ไม้คิว=큐대
หัวคิว=큐 팁
ลูกสนุ๊ก=당구공
ลูกสนุ้ก=당구공
ลูกขาว=흰 공
ลูกแดง=빨간 공
ลูกสี=색깔 공
ลงหลุม=포켓에 넣다
แทงพลาด=샷을 실수하다
แทงแม่น=샷이 정확하다
แทงเบาๆ=살살 치다
แทงแรงๆ=세게 치다
จัดลูก=공을 세팅하다
เล่นกันไหม=같이 칠래요?
ชั่วโมงละเท่าไหร่=한 시간에 얼마예요?
แพ้ชนะ=승패
ใครแพ้จ่าย=지는 사람이 계산해요
เล่นขำๆ=그냥 재미로 치는 거예요

[กฎกันแปลผิดงานอดิเรก]
ซิดเบ็ด / ซิสเบ็ด / สิดเบ็ด / สิทเบ็ด / สิบเบ็ด / 10เบ็ด = 낚시하다, not number ten.
เหยื่อ in fishing context means bait, not victim.
รอก in fishing context means fishing reel, not waiting.
ส่อนกุ้ง means catching small shrimp with a net/basket, not hiding shrimp.
ช้อนกุ้ง in rural Thai context means scooping/catching small shrimp with a net.
แทงสนุ๊ก / แทงสนุ้ก means play snooker/billiards, not stab.
ไม้คิว means cue stick, not queue wood.
ลูกขาว / ลูกแดง in snooker context are billiard balls.
`;

const ISAN_FOOD_VOCAB = `
[อาหารอีสาน / Thai-Isan Food]
ก้อย=고이 / 태국 이산식 생고기 또는 생선 무침
ก้อยเนื้อ=고이 느아 / 태국 이산식 생고기 무침
ก้อยเนื้อขมๆ=쓴맛이 나는 태국 이산식 생고기 무침
ก้อยเนื้อขมขม=쓴맛이 나는 태국 이산식 생고기 무침
ดีขม=쓴맛을 내는 소의 쓸개즙 / 쓴맛 양념
ใส่ดีขม=쓴맛을 내는 소의 쓸개즙을 넣다
ก้อยกุ้ง=고이 꿍 / 태국식 생새우 무침
กุ้งเต้น=꿍 뗀 / 살아있는 새우를 양념해 먹는 태국식 새우 샐러드
ซอยจุ๊=소이쭈 / 태국 이산식 생고기 회
ลาบ=라브 / 태국 이산식 다진 고기 샐러드
ลาบหมู=돼지고기 라브
ลาบเนื้อ=소고기 라브
ลาบเป็ด=오리고기 라브
ลาบไก่=닭고기 라브
ลาบดิบ=생고기 라브
น้ำตกหมู=남똑 무 / 구운 돼지고기 매운 샐러드
น้ำตกเนื้อ=남똑 느아 / 구운 소고기 매운 샐러드
ตับหวาน=땁완 / 돼지간 매운 샐러드
ต้มแซ่บ=똠쌥 / 태국 이산식 매운탕
ต้มแซ่บกระดูกหมู=돼지등뼈 매운탕
ต้มส้ม=똠쏨 / 새콤한 태국식 탕
ต้มส้มปลา=새콤한 생선탕
แกงอ่อม=깽옴 / 태국 이산식 허브 찌개
อ่อมเนื้อ=소고기 이산식 허브 찌개
อ่อมไก่=닭고기 이산식 허브 찌개
หมก=목 / 바나나잎에 싸서 찐 음식
หมกปลา=바나나잎에 싼 생선찜
หมกหน่อไม้=죽순 허브찜
ป่น=뽄 / 태국 이산식 찍어 먹는 양념장
ป่นปลา=생선 양념장
แจ่ว=쨈 / 태국 이산식 매운 찍어 먹는 소스
แจ่วบอง=쨈봉 / 발효 생선 매운 소스
ปลาร้า=쁠라라 / 태국식 발효 생선 소스
ปลาแดก=쁠라댁 / 태국 이산식 발효 생선
ปลาร้าบอง=발효 생선 매운 양념
ปลาจ่อม=쁠라쩜 / 태국식 발효 작은 생선
กุ้งจ่อม=꿍쩜 / 태국식 발효 새우
ส้มตำ=쏨땀 / 태국식 파파야 샐러드
ตำบักหุ่ง=쏨땀 / 태국 이산식 파파야 샐러드
ตำปูปลาร้า=게와 발효 생선 소스를 넣은 파파야 샐러드
ตำไทย=태국식 달콤새콤 파파야 샐러드
ตำลาว=라오스/이산식 발효 생선 파파야 샐러드
ตำแตง=오이 쏨땀
ตำถั่ว=긴콩 쏨땀
ตำซั่ว=쌀국수 넣은 쏨땀
ตำมั่ว=여러 재료를 섞은 이산식 쏨땀
ตำข้าวโพด=옥수수 쏨땀
ตำทะเล=해산물 쏨땀
เผ็ดน้อย=덜 맵게
เผ็ดมาก=아주 맵게
ไม่ใส่ปลาร้า=발효 생선 소스는 빼 주세요
ใส่ปลาร้า=발효 생선 소스를 넣어 주세요
ส้มหมู=발효 돼지고기 / 태국식 발효 돼지고기
ส้มเนื้อ=발효 소고기 / 태국식 발효 소고기
ส้มปลา=발효 생선 / 태국식 발효 생선
แหนม=냄 / 태국식 발효 돼지고기 소시지
แหนมซี่โครง=발효 돼지갈비
ไส้กรอกอีสาน=이산 소시지 / 태국 이산식 발효 소시지
ไส้กรอกวุ้นเส้น=당면이 들어간 이산 소시지
หมูยอ=무요 / 태국식 돼지고기 소시지
กุนเชียง=태국식 중국 소시지
ข้าวเหนียว=찹쌀밥
ข้าวเหนียวร้อนๆ=따뜻한 찹쌀밥
ข้าวคั่ว=볶은 쌀가루
พริกป่น=고춧가루
น้ำปลา=피시소스
มะนาว=라임
ผักแพว=베트남 고수 / 락사 잎
ผักชีฝรั่ง=쿨란트로
สะระแหน่=민트
ใบมะกรูด=카피르 라임 잎
ข่า=갈랑가
ตะไคร้=레몬그라스
หอมแดง=샬롯

[กฎกันแปลผิดอาหารอีสาน]
ก้อยเนื้อ is Thai-Isan raw beef salad, NOT 꼬리 and NOT tail.
ก้อย is a food name. Keep as 고이 or explain as 태국 이산식 생고기 무침.
ขมๆ / ขมขม means bitter taste, translate as 쓴맛이 나는, NOT 질기다.
ส้มหมู / ส้มเนื้อ / ส้มปลา means fermented meat/fish, NOT orange.
ปลาแดก / ปลาร้า means fermented fish sauce/paste, NOT rotten fish.
ตำบักหุ่ง means ส้มตำ / papaya salad.
กุ้งเต้น means live shrimp salad/dancing shrimp salad, NOT shrimp dancing literally.
`;

const ISAN_CEREMONY_FESTIVAL_VOCAB = `
[บ้านงาน / งานบุญ / พิธีกรรม / เทศกาลอีสานและไทย]
บ้านงาน=행사가 있는 집 / 의식이나 잔치가 열리는 집
งานบ้าน=집안 행사 / 가족 행사
ไปบ้านงาน=행사 있는 집에 가다
ช่วยงาน=행사를 도와주다
เจ้าภาพ=행사 주최자 / 상주 또는 주인
ซองงาน=축의금 봉투 / 부의금 봉투 ตามบริบท
ใส่ซอง=봉투에 돈을 넣다 / 축의금 หรือ 부의금을 내다
พี่น้อง=친척 / 가족 / 고향 사람들 ตามบริบท
ญาติพี่น้อง=친척들
หมู่บ้าน=마을
ผู้เฒ่า=어르신
พ่อใหญ่=할아버지 / 어르신
แม่ใหญ่=할머니 / 어르신

[งานแต่ง / กินดอง]
กินดอง=결혼식 / 결혼 잔치 / 이산식 결혼식
งานกินดอง=결혼 잔치
งานแต่ง=결혼식
แต่งงาน=결혼하다
เจ้าบ่าว=신랑
เจ้าสาว=신부
สินสอด=지참금 / 결혼 예물금
ผูกแขน=손목에 실을 묶어 축복하다
ผูกข้อไม้ข้อมือ=손목에 실을 묶는 축복 의식
บายศรี=바이씨 / 태국식 축복 의식
สู่ขวัญ=수콴 / 태국식 영혼 축복 의식
ขบวนแห่ขันหมาก=신랑 측 혼례 행렬
แห่ขันหมาก=혼례 예물 행렬
รดน้ำสังข์=결혼 축복 물 붓기 의식
โต๊ะจีน=중국식 연회 테이블
เลี้ยงแขก=손님을 대접하다

[งานศพ]
งานศพ=장례식
บ้านงานศพ=장례식이 있는 집
สวดศพ=장례 예불 / 장례 기도
เผาศพ=화장하다
เมรุ=화장장
วัด=절
พระ=스님
เจ้าภาพงานศพ=상주 / 장례 주최자
ใส่ซองงานศพ=부의금을 내다
พวงหรีด=근조 화환
ไว้อาลัย=애도하다
ทำบุญให้ผู้ตาย=고인을 위해 공덕을 쌓다

[งานบุญ / วัด]
งานบุญ=불교 공덕 행사 / 마을 축제
บุญบ้าน=마을 공덕 행사
ทำบุญ=공덕을 쌓다 / 절에 시주하다
ใส่บาตร=탁발 공양을 하다
ถวายพระ=스님께 공양하다
โรงทาน=무료 음식 나눔 장소
กฐิน=카틴 / 승려에게 가사를 봉헌하는 불교 행사
ผ้าป่า=파파 / 불교 기부 행사
เข้าพรรษา=입안거 / 승려의 우기 수행 기간 시작
ออกพรรษา=출안거 / 우기 수행 기간 종료
บุญข้าวจี่=분 카오찌 / 찹쌀구이 공덕 축제
บุญบั้งไฟ=분방파이 / 로켓 축제
บุญผะเหวด=분 파웻 / 베산타라 본생담 축제
บุญมหาชาติ=대설법 불교 행사

[เทศกาล]
สงกรานต์=송끄란 / 태국 새해 물 축제
ลอยกระทง=러이끄라통 / 등불과 꽃배를 띄우는 축제
ปีใหม่=새해
ปีใหม่ไทย=태국 새해
แห่เทียนพรรษา=입안거 초 축제 행렬
หมอลำ=몰람 / 이산식 민속 공연
ลำซิ่ง=람씽 / 빠른 리듬의 이산 공연
ขบวนแห่=축제 행렬
ฟ้อนรำ=전통 춤을 추다
ดนตรีสด=라이브 음악
เครื่องเสียง=음향 장비
เวที=무대
งานวัด=절 축제 / 사찰 행사
ตลาดนัดงานวัด=축제 야시장

[คำบอกเวลาอีสาน]
มื้อนี้=วันนี้=오늘
มื้ออื่น=พรุ่งนี้=내일
มื้อวาน=เมื่อวาน=어제
มื้อฮือ=วันมะรืน=모레
เซ้า=เช้า=아침
ยามเซ้า=ตอนเช้า=아침에
แลง=เย็น=저녁
ยามแลง=ตอนเย็น=저녁에
ค่ำ=กลางคืน/ค่ำ=밤
ยามใด๋=เมื่อไหร่=언제
ยามได๋=เมื่อไหร่=언제
ตอนใด๋=ตอนไหน=언제
อยู่ไส=อยู่ที่ไหน=어디에 있어요?
ไปไส=ไปไหน=어디 가요?
มาแต่ไส=มาจากไหน=어디서 왔어요?

[กฎกันแปลผิดพิธีกรรม]
กินดอง means wedding feast / wedding ceremony, NOT eating pickles.
บ้านงาน means a house where an event is taking place.
มื้อนี้ / มื้ออื่น / มื้อวาน are time expressions, NOT meals.
ซองงาน depends on context:
- งานแต่ง / กินดอง → 축의금 봉투
- งานศพ → 부의금 봉투
- งานบุญ → 시주금 / 기부금
ผูกแขน / ผูกข้อไม้ข้อมือ is a blessing ritual.
`;

const MOBILE_SIM_VOCAB = `
[มือถือ / ซิม / ค่าโทร / อินเทอร์เน็ต]
ซิม / ซิมการ์ด=유심 / 유심카드
เปิดซิม=유심 개통하다
เปิดเบอร์=번호를 개통하다
เบอร์โทร=전화번호
เบอร์นี้=이 번호
เบอร์นี้ยังใช้ได้ไหม=이 번호 아직 사용할 수 있어요?
ซิมนี้ใช้ได้ไหม=이 유심 사용할 수 있어요?
ซิมนี้ใช้กับ LG ได้ไหม=이 유심은 LG에서 사용할 수 있어요?
ซิมนี้ใช้ LG ไหม=이 유심은 LG 통신사인가요?
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
รับสายไม่ได้=전화를 받을 수 없어요
ส่งข้อความไม่ได้=문자를 보낼 수 없어요
ข้อความยืนยัน=인증 문자
รหัสยืนยัน=인증번호
ไม่ได้รับรหัสยืนยัน=인증번호를 못 받았어요
เติมเงินมือถือ=휴대폰 요금을 충전하다
ค่าโทร=휴대폰 요금 / 통신비
ค่าเน็ต=인터넷 요금 / 데이터 요금
ค่าโทรค้าง=미납 통신요금
ยอดค้าง=미납금
ค้างจ่าย=미납
จ่ายค่าโทร=휴대폰 요금을 내다
หักเงินอัตโนมัติ=자동이체
ผูกบัญชี=계좌를 연결하다
ตัดเงินจากบัญชี=계좌에서 자동으로 빠져나가다
ทำไมเงินถูกหัก=왜 돈이 빠져나갔어요?
ยกเลิกเบอร์=번호를 해지하다
ยกเลิกซิม=유심을 해지하다
สัญญามือถือ=휴대폰 약정
ติดสัญญา=약정이 남아 있어요
ค่าปรับยกเลิก=위약금
เครื่องติดล็อก=기기가 잠겨 있어요
ปลดล็อกเครื่อง=기기 잠금 해제
ลงทะเบียนชื่อใคร=누구 명의로 등록되어 있어요?
ซิมเป็นชื่อใคร=유심이 누구 명의예요?
ชื่อเจ้าของเบอร์=명의자
บัตรต่างด้าวใช้เปิดซิมได้ไหม=외국인등록증으로 유심 개통할 수 있어요?
พาสปอร์ตเปิดซิมได้ไหม=여권으로 유심 개통할 수 있어요?

[กฎกันแปลผิดเรื่องซิม]
ซิม = 유심, not normal SIM in English only.
เบอร์นี้ยังใช้ได้ไหม = ask whether phone number is active.
ยอดค้าง / ค่าโทรค้าง = 미납금 / 미납 통신요금.
หักเงินอัตโนมัติ = 자동이체.
ชื่อเจ้าของเบอร์ / 명의 = registered owner name.
`;

const CAR_TRADE_VOCAB = `
[ซื้อขายรถยนต์มือสอง / Used Car Trade]
รถยนต์=자동차
รถมือสอง=중고차
ขายรถ=차를 팔다
ซื้อรถ=차를 사다
ดูรถ=차를 보러 가다
ทดลองขับ=시승하다
รถคันนี้=이 차
ทะเบียนรถ=차량 번호 / 자동차 번호판
เล่มรถ / เอกสารรถ=자동차등록증
ชื่อเจ้าของรถ=차량 명의자
เจ้าของเดิม=전 차주
เจ้าของคนเดียว=1인 소유
เปลี่ยนชื่อ / โอนชื่อ=명의이전
โอนรถ=차량 명의이전
ค่าธรรมเนียมโอน=명의이전 비용
โอนได้ไหม=명의이전 가능해요?
วันนี้โอนได้ไหม=오늘 명의이전 가능해요?
รถติดไฟแนนซ์ไหม=할부나 저당이 남아 있어요?
จำนำ / ติดจำนำ=저당 잡혀 있다
รถมีภาระไหม=압류나 저당이 있어요?
ไม่มีภาระ=압류나 저당이 없어요
ภาษีรถ=자동차세
ภาษีรถค้างไหม=자동차세 미납이 있어요?
ประกันรถ=자동차 보험
ประกันเหลือไหม=보험이 남아 있어요?
ประกันโอนได้ไหม=보험 승계 가능해요?
ประกันชั้นหนึ่ง=종합보험
ประกันบังคับ=의무보험
ต่อประกัน=보험을 갱신하다

[ราคา / ต่อรอง / ผ่อน]
ราคาเท่าไหร่=가격이 얼마예요?
ลดได้ไหม=깎아 줄 수 있어요?
ลดได้สุดเท่าไหร่=최종 가격이 얼마예요?
รวมค่าโอนหรือยัง=명의이전 비용 포함인가요?
เงินสด=현금
ผ่อนได้ไหม=할부 가능해요?
ขายดาวน์=계약금 승계 / 할부 승계
เงินดาวน์=계약금 / 선수금
ค่างวด=월 할부금
ผ่อนเดือนละเท่าไหร่=월 할부금이 얼마예요?
เหลือกี่งวด=할부가 몇 개월 남았어요?
ดอกเบี้ย=이자
ไฟแนนซ์=할부 금융 / 캐피탈
เครดิตผ่านไหม=할부 심사가 가능해요?

[สภาพรถ / อุบัติเหตุ]
รถเคยชนไหม=사고 이력이 있어요?
รถชนหนักไหม=큰 사고가 있었어요?
ชนเบา=경미한 사고
ชนหนัก=큰 사고
รถไม่มีอุบัติเหตุ=무사고 차량
รถมีอุบัติเหตุ=사고 차량
ทำสีมาไหม=도색한 적 있어요?
สีเดิมไหม=원도장인가요?
เปลี่ยนอะไหล่ไหม=부품 교체한 적 있어요?
น้ำท่วมไหม=침수 이력이 있어요?
รถน้ำท่วม=침수차
ไฟไหม้ไหม=화재 이력이 있어요?
เลขไมล์=주행거리
ไมล์แท้ไหม=실주행거리 맞아요?
ไมล์กรอไหม=주행거리 조작된 거 아니에요?
วิ่งมากี่กิโล=몇 킬로 탔어요?
ใบตรวจสภาพ=성능점검기록부
ขอดูใบตรวจสภาพได้ไหม=성능점검기록부 볼 수 있어요?
ประวัติซ่อม=정비 이력
ประวัติเข้าศูนย์=서비스센터 정비 이력
รถยังดีไหม=차 상태 괜찮아요?
มีปัญหาอะไรไหม=문제 있는 부분 있어요?

[เครื่องยนต์ / เกียร์ / อะไหล่]
เครื่องยนต์=엔진
เกียร์=미션 / 변속기
เกียร์ออโต้=자동변속기
เกียร์ธรรมดา=수동변속기
เบรก=브레이크
ช่วงล่าง=하체 / 서스펜션
พวงมาลัย=핸들
หม้อน้ำ=라디에이터
แอร์รถ=에어컨
แบตเตอรี่=배터리
ยางรถ=타이어
ยางเปลี่ยนเมื่อไหร่=타이어 언제 교체했어요?
แบตเปลี่ยนเมื่อไหร่=배터리 언제 교체했어요?
น้ำมันเครื่อง=엔진오일
เปลี่ยนน้ำมันเครื่องแล้วหรือยัง=엔진오일 교체했어요?
เสียงเครื่องแปลก=엔진 소리가 이상해요
เกียร์กระตุก=미션 충격이 있어요
เบรกมีเสียง=브레이크 소리가 나요
แอร์ไม่เย็น=에어컨이 시원하지 않아요
เครื่องสั่น=엔진이 떨려요
น้ำมันรั่ว=오일이 새요
ไฟเตือนขึ้น=경고등이 떠요
ไฟเครื่องยนต์ขึ้น=엔진 경고등이 떠요

[ซ่อมรถ / อู่ / ศูนย์บริการ]
อู่ซ่อมรถ=카센터 / 정비소
ศูนย์บริการ=서비스센터
ซ่อมรถ=차를 수리하다
ตรวจรถ=차를 점검하다
ค่าแรงซ่อม=공임
ค่าอะไหล่=부품값
ประเมินค่าซ่อม=수리비 견적
ค่าซ่อมเท่าไหร่=수리비가 얼마예요?
ต้องซ่อมอะไรบ้าง=어디를 수리해야 해요?
ซ่อมเสร็จเมื่อไหร่=수리 언제 끝나요?
รถลาก=견인차
เรียกรถลาก=견인차 불러 주세요

[กฎกันแปลผิดเรื่องรถ]
โอนรถ means vehicle ownership transfer, not money transfer.
เล่มรถ means car registration document, not a book.
ไฟแนนซ์ in Thai car context means auto loan/capital financing.
ขายดาวน์ means transfer remaining installment/loan contract.
เลขไมล์แท้ means genuine mileage.
ไมล์กรอ means odometer rollback.
รถน้ำท่วม means flood-damaged car.
ใบตรวจสภาพ in Korean used-car context usually means 성능점검기록부.
`;
