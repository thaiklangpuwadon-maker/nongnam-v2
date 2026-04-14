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

  const sourceLang =
    fromLang === 'th' || fromLang === 'thai'
      ? 'Thai'
      : 'Korean';

  const targetLang = sourceLang === 'Thai' ? 'Korean' : 'Thai';

  const unclearReply =
    targetLang === 'Korean'
      ? '잘 못 들었습니다. 다시 말씀해 주세요.'
      : 'ฟังไม่ชัด ช่วยพูดอีกครั้งได้ไหมคะ';

  const failReply =
    targetLang === 'Korean'
      ? '번역할 수 없습니다.'
      : 'ไม่สามารถแปลได้ค่ะ';

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
        messages: [
          {
            role: 'user',
            content: userContent
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error?.message || 'API error');
    }

    const data = await response.json();
    return (data?.content || [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }

  // STEP 1: normalize transcript and restore question / statement intent
  const NORMALIZE_SYSTEM = `You are a transcript normalizer for Thai and Korean speech-to-text output.

Your job:
- Clean up spoken transcript text without changing meaning.
- Preserve every word, every sentence, every request, every reason.
- Do not shorten.
- Do not summarize.
- Do not omit details.
- Do not add new content.
- Only restore natural sentence boundaries and punctuation.

Very important:
- Decide whether each sentence is a question or a statement based on context and grammar.
- Add question marks when the sentence is clearly a question.
- Keep statements as statements.
- Do not turn statements into questions.
- Do not turn questions into statements.

Question detection hints:
- Korean endings/patterns that are often questions:
  요, 까요, 니까, 죠, 어때요, 어디예요, 뭐예요, 어떻게 해요, 왜 그래요, 가능해요, 있어요, 없어요
- Thai patterns that are often questions:
  ไหม, หรือเปล่า, หรือยัง, กี่, เท่าไหร่, ที่ไหน, เมื่อไหร่, ทำไม, ยังไง, ใช่ไหม, ได้ไหม

Conversation intent:
- Everyday expressions must remain natural.
- Example:
  밥 먹었어요 -> if used as a question, normalize to 밥 먹었어요?
  밥 먹었어요 -> if clearly a statement, keep as 밥 먹었어요.

Output:
- Output only the cleaned text in the same source language.
- No explanation.
- No notes.
- No labels.`;

  const normalizePrompt = `Language: ${sourceLang}
Please normalize this transcript and restore punctuation/question intent without changing meaning.

Text:
${cleanedText}`;

  // STEP 2: translate normalized text
  const TRANSLATE_SYSTEM = `You are a Thai-Korean interpreter for real spoken conversation.

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
- If the source sentence is a question, translate it as a question.
- Preserve question meaning, question tone, and question form.
- Do not turn questions into statements.
- Translate conversational expressions naturally, not mechanically word by word.
- If a phrase is a common everyday expression, translate it in the way real people naturally say it.
- Do not produce unnatural literal phrasing.
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
ใบกาม่า = 외국인등록증
บัตรกาม่า = 외국인등록증
กาม่า = 외국인등록증
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

[INSURANCE / KUKMIN / TAX]
กุ๊กมิน = 국민연금
กุกมิน = 국민연금
กูมิน = 국민연금
เงินกุกมิน = 국민연금
เงินกุกมินสะสม = 국민연금 적립금
เงินกุกมินที่จ่าย = 국민연금 납부금
ขอเงินกุกมินคืน = 국민연금 환급 신청하다
รับเงินกุกมินคืน = 국민연금 환급받다
เทจิก = 퇴직금
แทจิก = 퇴직금
เตจิก = 퇴직금
เงินเทจิก = 퇴직금
เงินแทจิก = 퇴직금
ประกันสังคม = 사회보험 / 4대보험
ประกันสุขภาพ = 건강보험
ประกันอุบัติเหตุ = 산재보험
ประกันการจ้างงาน = 고용보험
เงินประกันเดินทาง = 출국만기보험금
เงินประกันกลับประเทศ = 귀국비용보험금
เงินประกันครบสัญญา = 만기보험금
เงินประกันนายจ้าง = 보증보험금
เงินสะสม = 적립금
เงินคืน = 환급금
เงินมัดจำ = 보증금
ภาษี = 세금
ภาษีเงินได้ = 소득세
ภาษีท้องถิ่น = 지방세
หักภาษี = 세금을 공제하다
โดนหักภาษี = 세금을 공제당하다
คืนภาษี = 세금 환급
ขอคืนภาษี = 세금 환급 신청
ได้รับเงินคืนภาษี = 세금을 환급받다
ยื่นภาษี = 세금 신고하다
ยื่นภาษีประจำปี = 연말정산
รายได้ = 소득
รายได้รวม = 총소득
รายได้สุทธิ = 순소득
เงินเดือนสุทธิ = 실수령액
เงินเดือนก่อนหัก = 세전 월급
รายการหัก = 공제 내역
หักประกัน = 보험 공제
หักภาษี = 세금 공제
ค่าล่วงเวลา = 초과근무수당
ค่าโอที = 야근수당
เงินค้างจ่าย = 미지급 임금
เงินเดือนค้าง = 체불임금
บัญชีธนาคาร = 은행 계좌
เปิดบัญชี = 계좌를 개설하다
สมุดบัญชี = 통장
โอนเงิน = 송금하다
โอนเงินกลับไทย = 해외송금하다
ค่าธรรมเนียมโอน = 송금 수수료
ยอดเงิน = 잔액
ยอดคงเหลือ = 남은 금액
สัญญาจ้าง = 근로계약서
หมดสัญญา = 계약 만료
ต่อสัญญา = 계약 연장
เงินชดเชย = 보상금
เงินชดเชยออกงาน = 퇴직금
ออกจากงาน = 퇴사하다
เลิกจ้าง = 해고되다

Examples:
Thai: สวัสดีครับ ผมมาจากเมืองไทยนะครับ ยินดีที่ได้รู้จักนะครับ
Korean: 안녕하세요. 저는 태국에서 왔습니다. 만나서 반갑습니다.

Thai: ผมปวดหัวมากครับ อยากได้ยาแก้ปวดหัวครับ
Korean: 머리가 너무 아파요. 두통약을 주세요.

Korean: 비자를 연장하려면 어떤 서류가 필요해요?
Thai: ถ้าจะต่อวีซ่า ต้องใช้เอกสารอะไรบ้าง

Korean: 어디가 아파요?
Thai: เจ็บตรงไหนคะ

Korean: 언제부터 아팠어요?
Thai: เริ่มปวดตั้งแต่เมื่อไหร่คะ

Korean: 약은 어떻게 먹어요?
Thai: ยานี้ต้องกินยังไงคะ

Korean: 오늘 출근할 수 있어요?
Thai: วันนี้มาทำงานได้ไหม

Korean: 밥 먹었어요?
Thai: กินข้าวหรือยัง

Korean: 밥 먹었어요.
Thai: กินข้าวแล้ว

Thai: กินข้าวหรือยัง
Korean: 밥 먹었어요?

Thai: กินข้าวแล้ว
Korean: 밥 먹었어요.`;

  try {
    const normalizedText = await callAnthropic(
      NORMALIZE_SYSTEM,
      normalizePrompt,
      1000
    );

    const translation = await callAnthropic(
      TRANSLATE_SYSTEM,
      normalizedText,
      1600
    );

    const ip = req.headers['x-forwarded-for'] || 'unknown';
    console.log(
      'USAGE:',
      JSON.stringify({
        time: new Date().toISOString(),
        fromLang,
        chars: cleanedText.length,
        normalizedChars: normalizedText.length,
        ip: String(ip).split(',')[0].trim()
      })
    );

    return res.status(200).json({ translation });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
