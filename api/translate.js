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
    prev_turn,
    last_th,
    user_gender,
    partner_gender
  } = req.body || {};

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

  const sourceLang = fromLang === 'th' || fromLang === 'thai' ? 'Thai' : 'Korean';
  const targetLang = sourceLang === 'Thai' ? 'Korean' : 'Thai';

  const unclearReply =
    targetLang === 'Korean'
      ? '잘 못 들었습니다. 다시 말씀해 주세요.'
      : 'ฟังไม่ชัด ช่วยพูดอีกครั้งได้ไหมคะ';

  const failReply =
    targetLang === 'Korean'
      ? '번역할 수 없습니다.'
      : 'ไม่สามารถแปลได้ค่ะ';

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const cleanIP = String(ip).split(',')[0].trim();

  const VOCAB_CORE = `
[คำพื้นฐานไทย-เกาหลีที่ใช้บ่อย]
เถ้าแก่/ซาจัง/ซาจังนิม/นายจ้าง=사장님
หัวหน้า/พันจัง/บันจัง=반장님
โรงงาน/คงจัง/กงจัง=공장
เงินเดือน=월급
สลิปเงินเดือน=급여명세서
รอแป๊บ=잠깐만요
ไม่เข้าใจ=이해 못 했어요
พูดช้าๆ=천천히 말해 주세요
พูดอีกที=다시 말해 주세요
ได้=돼요
ไม่ได้=안 돼요
ไม่เป็นไร=괜찮아요
ขอบคุณ=감사합니다
ขอโทษ=죄송합니다
ช่วยด้วย=도와 주세요
`;

  const VOCAB_ISAAN_CORE = `
[อีสานหลัก — คำที่ต้องเข้าใจก่อน]
ข่อย/ข้อย=ฉัน/ผม/หนู=저/나
เจ้า=คุณ/เธอ=당신/너
เฮา=เรา/ฉัน ตามบริบท=우리/나
เพิ่น=เขา/คนนั้น=그 사람
ไผ=ใคร=누구
ไส=ที่ไหน=어디
หยัง/อีหยัง=อะไร=뭐
จังได๋/จั่งได๋=ยังไง=어떻게
มื้อใด๋=วันไหน/เมื่อไหร่=언제/어느 날
ยามใด๋=เวลาไหน=언제/몇 시
ท่อใด๋=เท่าไหร่=얼마/얼마나
จัก=ไม่รู้/สัก/กี่ ตามบริบท=모르다/몇
บ่=ไม่/ไหม ตามท้ายประโยค=아니다/안/요?
แม่น=ใช่/ถูก=맞다
บ่แม่น=ไม่ใช่=아니다
บ่มี=ไม่มี=없다
มีบ่=มีไหม=있어요?
ได้บ่=ได้ไหม=돼요?
ไปบ่=ไปไหม=갈래요?
กินบ่=กินไหม=먹을래요?
เอาบ่=เอาไหม=할래요?/원해요?
มาเด้อ=มานะ=오세요
ไปเด้อ=ไปนะ=가요
ฟ้าว=รีบ=서두르다/빨리
ค่อย=เดี๋ยวค่อย/ช้าๆ ตามบริบท=이따가/천천히
เบิ่ง=ดู=보다
เว้า=พูด=말하다
เฮ็ด=ทำ=하다
ซอย=ช่วย=도와주다
พ้อ=เจอ=만나다
เมือ=กลับ=돌아가다
ฮอด=ถึง=도착하다
ย่าง=เดิน=걷다
แล่น=วิ่ง=뛰다
นั่ง=นั่ง=앉다
นอน=นอน=자다
ลุก=ลุก=일어나다
กิน=กิน=먹다
ดื่ม/กินน้ำ=ดื่มน้ำ=마시다
ซื้อ/ซื่อ=ซื้อ ตามบริบท=사다
ซื่อ=ชื่อ ถ้ามากับ ข่อย/ผม/เจ้า/ชื่อว่า=이름
ข่อยซื่อ=ฉันชื่อ=제 이름은
อ้าย=พี่ชาย/ผู้ชายที่สนิทหรืออายุมากกว่า=형/오빠
เอื้อย=พี่สาว=누나/언니
น้องหล่า/บักหล่า=น้องชาย/เด็กผู้ชาย=남동생/어린 남자
อีหล่า=น้องสาว/เด็กผู้หญิง=여동생/어린 여자
พ่อใหญ่=ปู่/ตา/ผู้ชายสูงอายุ=할아버지
แม่ใหญ่=ย่า/ยาย/ผู้หญิงสูงอายุ=할머니
หมู่=เพื่อน=친구
เสี่ยว=เพื่อนสนิท=절친
ผู้บ่าว=ผู้ชาย/แฟนผู้ชาย=남자/남자친구
ผู้สาว=ผู้หญิง/แฟนผู้หญิง=여자/여자친구
ผัว=สามี=남편
เมีย=ภรรยา=아내
ลูก=ลูก=아이/자녀
พ่อ=พ่อ=아버지
แม่=แม่=어머니
`;

  const VOCAB_ISAAN_TIME = `
[อีสานเวลา / วัน / ช่วงเวลา]
มื้อนี้=วันนี้=오늘
มื้ออื่น=พรุ่งนี้=내일
มื้อวาน=เมื่อวาน=어제
มื้อฮือ=วันมะรืน=모레
มื้อก่อน=วันก่อน=며칠 전/그저께 ตามบริบท
มื้อหลัง=วันหลัง=다음에
มื้อใด๋=วันไหน=어느 날/언제
ยามเช้า/ยามเซ้า=ตอนเช้า=아침
ยามสาย=สายๆ=오전 늦게
ยามเที่ยง=เที่ยง=점심때/정오
ยามบ่าย=บ่าย=오후
ยามแลง=ตอนเย็น=저녁
ยามค่ำ=ตอนกลางคืน=밤
ยามดึก=ดึก=늦은 밤
ตอนนี้/บัดนี้=ตอนนี้=지금
เดี๋ยวนี้=ตอนนี้/ทันที=지금 당장
จั๊กคราว=สักพัก=잠시
จักหน่อย=สักหน่อย=조금
อีกจักหน่อย=อีกสักพัก=조금 있다가
โดนบ่=นานไหม=오래 걸려요?
โดนแล้ว=นานแล้ว=오래됐어요
บ่โดน=ไม่นาน=오래 안 걸려요
เร็วๆ นี้=เร็วๆ นี้=곧
บัดใด๋=เมื่อไหร่=언제
ฮอดยามใด๋=ถึงกี่โมง=몇 시에 도착해요?
กลับยามใด๋=กลับกี่โมง=몇 시에 돌아가요?
ไปยามใด๋=ไปกี่โมง=몇 시에 가요?
`;

  const VOCAB_ISAAN_DAILY = `
[อีสานชีวิตประจำวัน]
กินข้าว=กินข้าว=밥 먹다
กินข้าวแล้วบ่=กินข้าวหรือยัง=밥 먹었어요?
กินแล้ว=กินแล้ว=먹었어요
ยังบ่ได้กิน=ยังไม่ได้กิน=아직 안 먹었어요
หิวข้าว=หิวข้าว=배고파요
อิ่มแล้ว=อิ่มแล้ว=배불러요
นอนบ่หลับ=นอนไม่หลับ=잠이 안 와요
ง่วงนอน=ง่วง=졸려요
ตื่นแล้ว=ตื่นแล้ว=일어났어요
อาบน้ำ=อาบน้ำ=샤워하다
ล้างหน้า=ล้างหน้า=세수하다
แปรงแข่ว=แปรงฟัน=양치하다
ไปตลาด=ไปตลาด=시장에 가다
ไปซื้อของ=ไปซื้อของ=물건 사러 가다
ไปเฮ็ดงาน=ไปทำงาน=일하러 가다
เลิกงานแล้ว=เลิกงานแล้ว=퇴근했어요
กลับบ้าน=กลับบ้าน=집에 가다/집에 돌아가다
อยู่บ้าน=อยู่บ้าน=집에 있다
อยู่ห้อง=อยู่ห้อง=방에 있다
เข้าห้องน้ำ=เข้าห้องน้ำ=화장실에 가다
ซักผ้า=ซักผ้า=빨래하다
ตากผ้า=ตากผ้า=빨래를 널다
ล้างจาน=ล้างจาน=설거지하다
กวาดบ้าน=กวาดบ้าน=청소하다
ถูบ้าน=ถูพื้น=걸레질하다
ทิ้งขยะ=ทิ้งขยะ=쓰레기를 버리다
แยกขยะ=แยกขยะ=분리수거하다
เปิดไฟ=เปิดไฟ=불을 켜다
ปิดไฟ=ปิดไฟ=불을 끄다
เปิดแอร์=เปิดแอร์=에어컨을 켜다
ปิดแอร์=ปิดแอร์=에어컨을 끄다
เปิดฮีตเตอร์=เปิดฮีตเตอร์=난방을 켜다
ปิดฮีตเตอร์=ปิดฮีตเตอร์=난방을 끄다
น้ำบ่ไหล=น้ำไม่ไหล=물이 안 나와요
ไฟดับ=ไฟดับ=전기가 나갔어요
เน็ตบ่ดี=อินเทอร์เน็ตไม่ดี=인터넷이 안 좋아요
ไวไฟบ่ติด=ไวไฟใช้ไม่ได้=와이파이가 안 돼요
แบตหมด=แบตหมด=배터리가 없어요
ชาร์จแบต=ชาร์จแบต=충전하다
โทรหา=โทรหา=전화하다
ส่งข้อความ=ส่งข้อความ=문자 보내다
`;

  const VOCAB_ISAAN_ACTIONS = `
[กริยาอีสานที่ใช้บ่อย]
เอา=เอา/ต้องการ=원하다/가지다
บ่เอา=ไม่เอา=원하지 않아요
อยากได้=อยากได้=갖고 싶어요
อยากไป=อยากไป=가고 싶어요
อยากมา=อยากมา=오고 싶어요
อยากกิน=อยากกิน=먹고 싶어요
อยากนอน=อยากนอน=자고 싶어요
อยากเว้า=อยากพูด=말하고 싶어요
อยากถาม=อยากถาม=물어보고 싶어요
ถามแน=ถามหน่อย=물어봐도 돼요?
บอกแน=บอกหน่อย=말해 주세요
ซอยแน=ช่วยหน่อย=도와주세요
พาไปแน=พาไปหน่อย=데려다 주세요
ไปส่งแน=ไปส่งหน่อย=데려다 주세요
รอแน=รอหน่อย=기다려 주세요
เอามาแน=เอามาให้หน่อย=가져다 주세요
เบิ่งแน=ดูหน่อย=봐 주세요
ฟังแน=ฟังหน่อย=들어 주세요
เว้าช้าๆ แน=พูดช้าๆ หน่อย=천천히 말해 주세요
เว้าอีกเทื่อแน=พูดอีกครั้งหน่อย=다시 말해 주세요
เฮ็ดหยัง=ทำอะไร=뭐 해요?
ไปไส=ไปไหน=어디 가요?
มาแต่ไส=มาจากไหน=어디서 왔어요?
อยู่ไส=อยู่ที่ไหน=어디에 있어요?
เอาไว้ไส=วางไว้ที่ไหน=어디에 뒀어요?
เห็นบ่=เห็นไหม=봤어요?
ฮู้บ่=รู้ไหม=알아요?
เข้าใจบ่=เข้าใจไหม=이해했어요?
`;

  const VOCAB_ISAAN_HEALTH = `
[อาการป่วยแบบอีสาน / โรงพยาบาล]
โตฮ้อน=ตัวร้อน/มีไข้=열이 나요/몸이 뜨거워요
ฮ้อนในโต=ร้อนในตัว=몸속이 뜨거운 느낌이에요
ไข้ขึ้น=มีไข้=열이 올랐어요
ไข้สูง=ไข้สูง=고열이에요
หนาวสั่น=หนาวสั่น=오한이 있어요
หนาวเข้ากระดูก=หนาวมาก=뼛속까지 춥고 떨려요
คันคิง=ครั่นเนื้อครั่นตัว/เหมือนจะป่วย=몸살 기운이 있어요
ปวดหัว=ปวดหัว=머리가 아파요
วินหัว=เวียนหัว=어지러워요
มึนหัว=มึนหัว=머리가 멍해요
หัวสิแตก=ปวดหัวมาก=머리가 깨질 듯이 아파요
เจ็บคอ=เจ็บคอ=목이 아파요
คอแห้ง=คอแห้ง=목이 말라요
กลืนบ่ลง=กลืนไม่ลง=삼키기 힘들어요
ไอ=ไอ=기침해요
ไอหลาย=ไอมาก=기침이 심해요
มีขี้มูก=มีน้ำมูก=콧물이 나요
ดั้งตัน=คัดจมูก=코가 막혔어요
หายใจบ่ออก=หายใจไม่ออก=숨이 안 쉬어져요
หายใจฟืดฟาด=หายใจเสียงดัง/ลำบาก=숨소리가 거칠어요
แน่นหน้าอก=แน่นหน้าอก=가슴이 답답해요
ใจสั่น=ใจสั่น=심장이 두근거려요
เจ็บท้อง=ปวดท้อง=배가 아파요
เจ็บท้องบิด=ปวดท้องบิด=배가 쥐어짜듯이 아파요
ท้องเสีย/ขี้แตก=ท้องเสีย=설사해요
ขี้ราก=ท้องเสียรุนแรง/ถ่ายเหลว=설사가 심해요
ฮาก=อาเจียน=토해요
คลื่นไส้=คลื่นไส้=메스꺼워요
กินบ่ได้=กินไม่ได้=먹을 수 없어요
นอนบ่ได้=นอนไม่ได้=잠을 못 자요
เบิ่งบ่เห็น=มองไม่เห็น=잘 안 보여요
ตาฟาง=ตามัว=시야가 흐려요
ตาแดง=ตาแดง=눈이 빨개요
หูอื้อ=หูอื้อ=귀가 먹먹해요
หูตึง=ได้ยินไม่ชัด=잘 안 들려요
แข่วปวด=ปวดฟัน=이가 아파요
แข่วโยก=ฟันโยก=이가 흔들려요
ปากแห้ง=ปากแห้ง=입이 말라요
เจ็บหลัง=ปวดหลัง=등이 아파요
ปวดเอว=ปวดเอว=허리가 아파요
เส้นยึด=กล้ามเนื้อตึง=근육이 뭉쳤어요
ตะคริวกิน=เป็นตะคริว=쥐가 났어요
มือชา=มือชา=손이 저려요
ตีนชา=เท้าชา=발이 저려요
บวม=บวม=부었어요
ช้ำ/ซ้ำ=ช้ำ=멍들었어요
เลือดออก=เลือดออก=피가 나요
แผลพอง=ตุ่มพอง/พอง=물집이 생겼어요
น้ำฮ้อนลวก=น้ำร้อนลวก=뜨거운 물에 데었어요
โดนมีดบาด=โดนมีดบาด=칼에 베였어요
ตะปูปักตีน=ตะปูตำเท้า=발에 못이 찔렸어요
กระดูกหัก=กระดูกหัก=뼈가 부러졌어요
กระดูกร้าว=กระดูกร้าว=뼈에 금이 갔어요
แพ้อาหาร=แพ้อาหาร=음식 알레르기가 있어요
ผื่นขึ้น=ผื่นขึ้น=두드러기가 났어요
คัน=คัน=가려워요
เป็นลม=เป็นลม=기절했어요
สิเป็นลม=เหมือนจะเป็นลม=기절할 것 같아요
หมดแรง=ไม่มีแรง=힘이 없어요
`;

  const VOCAB_ISAAN_WORK_LIFE = `
[แรงงาน / โรงงาน / ชีวิตคนไทยในเกาหลี แบบอีสาน]
ไปเฮ็ดงาน=ไปทำงาน=일하러 가요
เฮ็ดงานหนัก=ทำงานหนัก=일이 힘들어요
เมื่อยคัก=เหนื่อยมาก=너무 힘들어요
งานหลาย=งานเยอะ=일이 많아요
งานบ่แล้ว=งานไม่เสร็จ=일이 안 끝났어요
เลิกงานยามใด๋=เลิกงานกี่โมง=몇 시에 퇴근해요?
เข้ากะ=เข้ากะงาน=근무 들어가요
กะเว็น=กะกลางวัน=주간근무
กะคืน=กะกลางคืน=야간근무
โอที/จันอ็อบ=โอที=잔업/초과근무
ทึกกึน=ทำงานวันหยุด=특근
เถ้าแก่=นายจ้าง=사장님
พันจัง/บันจัง=หัวหน้า=반장님
ซาโมนิม=เมียเถ้าแก่/ภรรยาเจ้าของ=사모님
เงินออก=เงินเดือนออก=월급 나왔어요
เงินบ่ออก=เงินเดือนไม่ออก=월급이 안 나왔어요
เงินขาด=เงินไม่ครบ=월급이 모자라요
ถืกตัดเงิน=โดนหักเงิน=돈이 공제됐어요
อยากลาออก=อยากลาออก=퇴사하고 싶어요
ถืกไล่ออก=โดนไล่ออก=해고당했어요
ย้ายงาน=ย้ายงาน=사업장을 변경하다
สัญญาหมด=สัญญาหมด=계약이 만료됐어요
ต่อสัญญา=ต่อสัญญา=계약 연장
ผีน้อย=แรงงานผิดกฎหมาย=불법체류자
คนวี=คนมีวีซ่า=비자 있는 사람
โดดวี=อยู่เกินวีซ่า=비자 만료 후 체류
ตม.ลง=ตม./ตำรวจตรวจ=단속이 떴어요
ถืกจับ=โดนจับ=잡혔어요
ส่งกลับไทย=ถูกส่งกลับไทย=태국으로 추방됐어요
`;

  const VOCAB_ISAAN_PHRASES = `
[อีสาน Phrase Override — ประโยคที่ AI มักแปลผิด]
เจ้ากะดายเนาะอ้าย=พี่ก็น้อ / พี่นี่ก็จริงๆ เลย=형도 참... / 형도 진짜...
เจ้ากะดายเนาะเอื้อย=พี่สาวก็น้อ / พี่สาวนี่ก็จริงๆ เลย=누나도 참... / 언니도 참...
เจ้ากะดาย=คุณนี่ก็จริงๆ เลย=당신도 참...
งึดหลาย=งง/อึ้ง/ทึ่งมาก=정말 어이없어요 / 정말 신기해요
งึดคัก=งงมาก/อึ้งมาก=정말 어이없어요
เป็นตางึด=น่าอึ้ง/น่าแปลกใจ=신기해요/어이없어요
กลับมะซางวาแท้=กลับมาสักทีเถอะ จริงๆ นะ=정말 빨리 돌아와요
มะซางวาแท้=มาสักทีเถอะ จริงๆ นะ=정말 좀 와요
บ่ดายเด้อ=ไม่ได้นะ=안 돼요
วาแท้บ่=จริงเหรอ=진짜예요?
แมนบ่=ใช่ไหม=맞아요?
แม่นอีหลีบ่=จริงๆ ใช่ไหม=진짜 맞아요?
อ้ายซื่อหยัง=พี่ชื่ออะไร=형 이름이 뭐예요?
เอื้อยซื่อหยัง=พี่สาวชื่ออะไร=누나 이름이 뭐예요?/언니 이름이 뭐예요?
ข่อยซื่อแมนเด้อ=ฉันชื่อแมน=제 이름은 맨이에요
ข่อยบ่เข้าใจเด้อ=ฉันไม่เข้าใจนะ=이해 못 했어요
เว้าอีกเทื่อแน=พูดอีกครั้งหน่อย=다시 말해 주세요
เว้าซ้าๆ แน=พูดช้าๆ หน่อย=천천히 말해 주세요
เจ้าคือไผ=คุณคือใคร=당신은 누구예요?
เจ้าเป็นหยัง=คุณเป็นอะไร=무슨 일이에요?/왜 그래요?
ไปไสมา=ไปไหนมา=어디 갔다 왔어요?
มาแต่ไส=มาจากไหน=어디서 왔어요?
กินข้าวแล้วบ่=กินข้าวหรือยัง=밥 먹었어요?
ซอยแนอ้าย=ช่วยหน่อยพี่=형, 도와주세요
ซอยแนเอื้อย=ช่วยหน่อยพี่สาว=누나/언니, 도와주세요
บ่มีรถ ซอยไปส่งแน=ไม่มีรถ ช่วยไปส่งหน่อย=차가 없어요. 데려다 주세요
บ่มีรถ ซอยส่งได้บ่=ไม่มีรถ ช่วยไปส่งได้ไหม=차가 없어요. 데려다 줄 수 있어요?
กาม่าหาย=บัตรต่างด้าวหาย=외국인등록증을 분실했어요
ใบกาม่าหาย=บัตรต่างด้าวหาย=외국인등록증을 분실했어요
ไปซิสเบ็ด=ไปตกเบ็ด/ตกปลา=낚시하러 가요
ซิสเบ็ดบ่=ตกเบ็ดไหม=낚시할래요?
มื้อนี้ไปไส=วันนี้ไปไหน=오늘 어디 가요?
มื้ออื่นไปนำกันบ่=พรุ่งนี้ไปด้วยกันไหม=내일 같이 갈래요?
บ่สบายคักเด้อ=ไม่สบายมากนะ=많이 아파요
โตฮ้อนคัก=ตัวร้อนมาก=열이 많이 나요
`;

  const VOCAB_ISAAN_FEELINGS = `
[อารมณ์ / ความรู้สึก แบบอีสาน]
ม่วน=สนุก=재밌어요
ม่วนหลาย=สนุกมาก=정말 재밌어요
บ่ม่วน=ไม่สนุก=재미없어요
ดีใจหลาย=ดีใจมาก=정말 기뻐요
เสียใจ=เสียใจ=슬퍼요
น้อยใจ=น้อยใจ=서운해요
อุกใจ=อึดอัดใจ/หนักใจ=답답해요
อุกอั่ง=อึดอัดมาก=가슴이 답답해요
เหลือใจ=เจ็บใจ/น้อยใจมาก=속상해요/억울해요
คึดฮอด=คิดถึง=보고 싶어요
คึดฮอดบ้าน=คิดถึงบ้าน=고향이 그리워요
คึดฮอดหลาย=คิดถึงมาก=많이 보고 싶어요
ฮัก=รัก=사랑해요
ฮักหลาย=รักมาก=많이 사랑해요
ซัง=เกลียด/ไม่ชอบ=싫어해요
ซังหน้า=เกลียดหน้า/ไม่อยากเห็นหน้า=꼴 보기 싫어요
เคียด=โกรธ=화났어요
เคียดคัก=โกรธมาก=정말 화났어요
ศูนย์=โมโห=화나요
ศูนย์คัก=โมโหมาก=너무 화나요
หนหวย=รำคาญ/หงุดหงิด=짜증나요
ย่าน=กลัว=무서워요
ย่านหลาย=กลัวมาก=너무 무서워요
ตกใจ=ตกใจ=놀랐어요
ตื่นเต้น=ตื่นเต้น=설레요/긴장돼요
ออนซอน=ประทับใจ/ชื่นชม/อิจฉาเชิงดี=감동했어요/부러워요
เป็นตาฮัก=น่ารัก=귀여워요
เป็นตาซัง=น่าหมั่นไส้=얄미워요
เป็นตาลิโตน=น่าสงสาร=불쌍해요
เป็นตาหน่าย=น่าเบื่อ/น่าระอา=지겨워요
`;

  const VOCAB_ISAAN_FRIEND_TALK = `
[อีสานคุยเล่นกับเพื่อน / หยอกกัน / ไม่ใช่ราชการ]
บักหำน้อย=ไอ้น้อง/ไอ้เด็กน้อย แบบหยอก=이 녀석/꼬맹이
บักหล่า=น้องชาย/ไอ้น้อง=동생/이 녀석
อีหล่า=น้องสาว/เด็กผู้หญิง=여동생/꼬마 아가씨
บักอันนี่=ไอ้นี่/หมอนี่=이 녀석
อีอันนี่=ยัยนี่=이 여자애/이 녀석
บักปึก=ไอ้โง่/ซื่อบื้อ=멍청이
บักง่าว=ไอ้โง่=바보
บักควาย=ไอ้ควาย/ไอ้โง่=바보 자식
หัวสิเฮ็ดหยัง=จะทำอะไรเนี่ย=뭐 하려고 그래?
มึงเป็นหยัง=เป็นอะไรของมึง=너 왜 그래?
มึงไปไสมา=มึงไปไหนมา=너 어디 갔다 왔어?
มึงคือเป็นจั่งซี้=ทำไมมึงเป็นแบบนี้=너 왜 이래?
อย่ามาขี้ตั๋ว=อย่ามาโกหก=거짓말하지 마
อย่ามาตอแหล=อย่ามาโกหก/เสแสร้ง=거짓말하지 마/내숭 떨지 마
เว้าหลาย=พูดมาก=말이 많아
ปากหลาย=พูดมาก=말이 많아
ปากหมา=ปากไม่ดี=입이 더러워
กวนตีน=กวนประสาท=짜증나게 굴다/시비 걸다
อย่ามากวนตีน=อย่ามากวนประสาท=짜증나게 하지 마
เจ้าคือเว้าหลายแท้=ทำไมพูดมากจัง=왜 그렇게 말이 많아?
หัวเราะหยัง=หัวเราะอะไร=뭐가 웃겨?
อย่าหัว=อย่าหัวเราะ=웃지 마
มาๆ กินข้าว=มาๆ กินข้าว=와서 밥 먹어
ไปนำกัน=ไปด้วยกัน=같이 가자
นั่งนำกัน=นั่งด้วยกัน=같이 앉자
กินนำกัน=กินด้วยกัน=같이 먹자
`;

  const VOCAB_ISAAN_SLANG_SAFE = `
[คำสบถ / คำด่าเล่น / คำหยาบ — แปลเฉพาะเมื่อผู้พูดพูดจริง]
ฮ่วย=โธ่เว้ย/เอ้า/หงุดหงิด=아 진짜/아이씨
ป๊าด=โอ้โห=우와/대박
ป๊าดติโธ่=โอ้โหจริงๆ=세상에/대박
บ๊ะ=เฮ้ย=헐
เอ๋า=อ้าว=어라
พะนะ=งั้นเหรอ/ประชด=참나
อิหลี=จริงๆ=진짜
บักปึก=ไอ้โง่=멍청이
บักง่าว=ไอ้โง่=바보
บักควาย=ไอ้ควาย/ไอ้โง่=바보 자식
บักประสาท=ไอ้ประสาท=정신 나간 놈
บักหน้าหมา=ไอ้หน้าหมา=개 같은 얼굴
บักสันดานหมา=นิสัยหมาๆ=개만도 못한 인성
อีบ้า=ยัยบ้า=미친년/미친 여자
อีป่วง=ยัยเพี้ยน=정신 나간 여자
อีดอก=คำด่าผู้หญิงรุนแรง=심한 여성 비하 욕설
ตอแหล=โกหก/เสแสร้ง=거짓말하다/내숭 떨다
ขี้ตั๋ว=ขี้โกหก=거짓말쟁이
หน้าด้าน=หน้าด้าน=뻔뻔하다
หน้าหนา=หน้าด้านมาก=철면피다
ปากหมา=ปากเสีย=입이 더럽다
ปากเน่า=พูดจาไม่ดี=말이 더럽다
หุบปาก=หุบปาก=닥쳐
อย่ามาซ่า=อย่ามาห้าว=나대지 마
อย่ามาห้าว=อย่ามากร่าง=나대지 마
ขี้คร้าน=ขี้เกียจ=게으르다
ขี้คร้านตัวเป็นขน=ขี้เกียจมาก=엄청 게으르다
ห่ากิน=คำสบถแบบอีสาน=빌어먹을
บักห่า=ไอ้เวร/ไอ้บ้า=이 빌어먹을 놈
บักพาก=คำด่าแรงแบบอีสาน=심한 욕설
แม่มึงเอ้ย=คำสบถถึงอีกฝ่าย=이 자식아/젠장
หากินหัวมึงเอ้ย=คำสบถแรงแบบหยอกหรือด่า ขึ้นกับน้ำเสียง=젠장할 놈아/이 빌어먹을 놈아

[กฎคำหยาบ]
- ถ้าเป็นบริบทเพื่อนหยอกกัน ให้แปลแบบคำหยอก ไม่เพิ่มความรุนแรง
- ถ้าเป็นบริบททะเลาะ ให้แปลระดับแรงตามต้นฉบับ
- ห้ามเพิ่มคำด่าที่ผู้พูดไม่ได้พูด
- ห้ามสั่งสอน ห้ามปฏิเสธ ห้ามตอบเอง
`;

  const VOCAB_ISAAN_GRAMMAR_RULES = `
[กฎไวยากรณ์อีสานที่ต้องจำ]
1) "บ่" ท้ายประโยคมักเป็นคำถาม
ไปบ่ = ไปไหม = 갈래요?
กินบ่ = กินไหม = 먹을래요?
ได้บ่ = ได้ไหม = 돼요?
แม่นบ่ = ใช่ไหม = 맞아요?

2) "เด้อ/เน้อ" เป็นคำลงท้าย ไม่ใช่คำสั่ง
มาเด้อ = มานะ = 오세요
ฟ้าวมาเด้อ = รีบมานะ = 빨리 오세요
บ่ดายเด้อ = ไม่ได้นะ = 안 돼요

3) "แน" คือ "หน่อย"
ซอยแน = ช่วยหน่อย = 도와주세요
เบิ่งแน = ดูหน่อย = 봐 주세요
เว้าอีกเทื่อแน = พูดอีกครั้งหน่อย = 다시 말해 주세요

4) "อ้าย/เอื้อย" คือคำเรียกพี่ ไม่ใช่ชื่อคน ไม่ใช่ AI
อ้าย = พี่ชาย
เอื้อย = พี่สาว

5) "ซื่อ" ต้องดูบริบท
ข่อยซื่อแมน = ฉันชื่อแมน = 제 이름은 맨이에요
ไปซื่อของ = ไปซื้อของ = 물건 사러 가요

6) "เจ้ากะดายเนาะ..." ไม่ได้แปลตรงว่า "คุณก็ได้"
เจ้ากะดายเนาะอ้าย = พี่ก็น้อ / พี่นี่ก็จริงๆ เลย
แปลเป็นเกาหลีธรรมชาติ: 형도 참... / 형도 진짜...

7) "ซิสเบ็ด" = ตกเบ็ด / ตกปลา
ไปซิสเบ็ด = ไปตกปลา = 낚시하러 가요

8) ถ้าเจอคำอีสาน + คำหยาบ ให้ถือว่าเป็นภาษาพูดจริง
แปลเท่านั้น ห้ามตอบว่าแปลไม่ได้ เว้นแต่เป็นภัยคุกคามจริงแบบชัดเจน
`;

  const VOCAB_HOSPITAL = `
[โรงพยาบาล/คลินิก]
โรงพยาบาล=병원
คลินิก=의원
ร้านขายยา=약국
หมอ=의사/선생님
พยาบาล=간호사
ห้องฉุกเฉิน=응급실
เคาน์เตอร์รับบัตร=접수처
นัดหมอ=진료 예약
ตรวจเลือด=피검사
ตรวจปัสสาวะ=소변검사
เอ็กซเรย์=엑스레이
CT=CT
MRI=MRI
ใบรับรองแพทย์=진단서
ใบรับรองการรักษา=진료확인서
ใบเสร็จค่ารักษา=진료비 영수증
รายละเอียดค่ารักษา=진료비 세부내역서
ใช้ยื่นประกัน=보험 청구용입니다
ใช้ยื่นบริษัท=회사 제출용입니다
`;

  const VOCAB_VISA = `
[วีซ่า/ราชการ/สถานทูต]
บัตรต่างด้าว/ใบกาม่า/กาม่า/บัตรกาม่า=외국인등록증
พาสปอร์ต=여권
ตม/ซุลลิก/ซุลลิกซา=출입국관리사무소
ต่อวีซ่า=비자 연장
เปลี่ยนวีซ่า=비자 변경
ยื่นวีซ่า=비자 신청
จองคิว=예약하다
HiKorea=하이코리아
ใบรับรองข้อเท็จจริงเข้าออกประเทศ=출입국사실증명서
สถานทูตไทย=태국 대사관
สถานกงสุล=영사관
หนังสือมอบอำนาจ=위임장
รับรองเอกสาร=서류 인증
แปลเอกสาร=서류 번역
แปลรับรอง=번역 공증
ใบรับรองโสด=미혼증명서
ใบสมรส=혼인증명서
ใบเกิด/สูติบัตร=출생증명서
ทะเบียนบ้าน=호적등본
หนังสือรับรองความประพฤติ=범죄경력증명서
E-9/อีเก้า/อีนาย=E-9 비자
E-7-4/อีเจ็ดสี่=E-7-4 비자
E-7-4R=E-7-4R 비자
F-2-R/เอฟทูอาร์=F-2-R 비자
F-6/เอฟหก=F-6 비자
`;

  const VOCAB_BANK_MONEY = `
[ธนาคาร/เงิน/ประกัน]
ธนาคาร=은행
เปิดบัญชี=계좌 개설
ปิดบัญชี=계좌 해지
สมุดบัญชี=통장
บัตรเอทีเอ็ม=체크카드
บัตรเครดิต=신용카드
โอนเงิน=송금하다
โอนเงินกลับไทย=해외송금
ฝากเงิน=입금하다
ถอนเงิน=출금하다
ยอดเงิน/ยอดคงเหลือ=잔액
ค่าธรรมเนียมโอน=송금 수수료
บัญชีโดนล็อค=계좌가 막혔다
ลืมรหัส=비밀번호를 잊어버렸다
ใบรับรองบัญชี=계좌개설확인서
ใบรับรองยอดเงิน=잔액증명서
รายการเดินบัญชี/statement=거래내역서
รายการเดินบัญชี 3 เดือน=최근 3개월 거래내역서
รายการเดินบัญชี 6 เดือน=최근 6개월 거래내역서
รายการเดินบัญชี 1 ปี=최근 1년 거래내역서
กุกมิน/กุ๊กมิน/เงินกุกมิน=국민연금
ขอเงินกุกมินคืน=국민연금 환급 신청
เทจิก/แทจิก/เตจิก/เงินเทจิก=퇴직금
ประกันสังคม=사회보험/4대보험
ประกันสุขภาพ=건강보험
ภาษี=세금
คืนภาษี=세금 환급
`;

  const VOCAB_WORK = `
[งาน/โรงงาน]
ลาออก=퇴사하다
ไล่ออก=해고되다
เปลี่ยนงาน/ย้ายงาน=사업장을 변경하다
สัญญาจ้าง=근로계약서
หมดสัญญา=계약 만료
ต่อสัญญา=계약 연장
โอที/ค่าโอที=야근/초과근무수당
วันหยุด=휴무일
ลาป่วย=병가
ลาพักร้อน=연차
มาสาย=지각하다
ขาดงาน=결근하다
เข้างาน=출근하다
เลิกงาน=퇴근하다
เงินเดือนสุทธิ=실수령액
เงินเดือนก่อนหัก=세전 월급
เงินเดือนค้าง=임금 체불
ใบรับรองการทำงาน=재직증명서
ใบรับรองรายได้=소득금액증명원
ใบหักภาษี=원천징수영수증
`;

  const VOCAB_TRAVEL_DAILY = `
[เดินทาง/ร้านอาหาร/ที่พัก]
รถเมล์/บัส/บาซือ=버스
รถไฟฟ้า/ซับเวย์/จีฮาชอล=지하철
แท็กซี่=택시
สถานี=역
เรียกแท็กซี่=택시 부르다
ไปทางไหน=어디로 가요?
หลงทาง=길을 잃었어요
จอดตรงนี้=여기서 세워 주세요
ห่อกลับ=포장해 주세요
คิดเงิน=계산해 주세요
ราคาเท่าไหร่=얼마예요?
ขอถุง=봉투 주세요
ขอใบเสร็จ=영수증 주세요
บ้านเช่า/ห้องเช่า=월세방/원룸
ค่าเช่า=월세
เงินมัดจำ=보증금
เจ้าของบ้าน=집주인
`;

  const VOCAB_BEAUTY = `
[ศัลยกรรม/ความงาม]
ศัลยกรรม=성형수술
ทำตาสองชั้น/ซองกาพุล=쌍꺼풀 수술
เย็บไม่กรีด=매몰법
กรีดตา=절개법
เปิดหัวตา=앞트임
เปิดหางตา=뒤트임
เสริมจมูก/โคซูซูล=코 수술
ซิลิโคน=실리콘
กระดูกตัวเอง=자가연골
สันจมูก=콧대
ปลายจมูก=코끝
ฟิลเลอร์=필러
โบทอก=보톡스
เลเซอร์=레이저
ยกกระชับ=리프팅
จัดฟัน=치아교정
รากฟันเทียม=임플란트
ขูดหินปูน=스케일링
ยาชา=마취
ดมยาสลบ=전신마취
ผลข้างเคียง=부작용
แผลเป็น=흉터
แก้งาน/แก้จมูก=재수술
อยากปรึกษา=상담 받고 싶어요
ราคาเท่าไหร่=비용이 얼마예요?
`;

  function hasIsaan(s) {
    return /(ข่อย|ข้อย|เจ้า|เฮา|เพิ่น|ไผ|ไส|หยัง|อีหยัง|จังได๋|จั่งได๋|บ่|แม่น|เบิ่ง|เว้า|เฮ็ด|ฟ้าว|พ้อ|เมือ|ฮอด|ซอย|ฮัก|ซัง|เคียด|ซูน|งึด|คัก|ม่วน|แซ่บ|หนหวย|เหลือใจ|อุกใจ|เด้อ|เน้อ|เบาะ|อ้าย|เอื้อย|อีหล่า|บักหล่า|ซื่อ|กะดาย|มะซาง|วาแท้|ซิสเบ็ด|ปลาแดก|ตำบักหุ่ง|แข่ว|โตฮ้อน|คันคิง|วินหัว|ฮาก|ขี้ราก|บักปึก|บักง่าว|บักควาย|บักห่า|ฮ่วย|ป๊าด|พะนะ|อิหลี|มื้อนี้|มื้ออื่น|มื้อวาน|ยามแลง|ยามเซ้า)/i.test(
      String(s || '')
    );
  }

  function detectSituation(t, ctx = '') {
    const textAll = `${t} ${ctx}`;

    if (hasIsaan(textAll)) return 'isaan';

    if (/ปวด|หมอ|ยา|โรงพยาบาล|ไข้|เจ็บ|คลินิก|ใบรับรองแพทย์|진단서|처방전|아프|병원|의사|약|증상|진료/.test(textAll)) {
      return 'hospital';
    }

    if (/เถ้าแก่|ลาออก|เงินเดือน|สัญญา|โรงงาน|โอที|사장|공장|월급|계약|퇴사|야근/.test(textAll)) {
      return 'work';
    }

    if (/วีซ่า|กาม่า|ตม|พาสปอร์ต|ต่อวีซ่า|สถานทูต|กงสุล|ใบรับรองโสด|หนังสือมอบอำนาจ|출입국|외국인등록|비자|여권/.test(textAll)) {
      return 'visa';
    }

    if (/ธนาคาร|โอนเงิน|กุกมิน|กุ๊กมิน|เทจิก|ประกัน|ภาษี|statement|รายการเดินบัญชี|잔액증명서|거래내역|은행|송금|계좌|국민연금|퇴직금/.test(textAll)) {
      return 'bank';
    }

    if (/ศัลยกรรม|เสริมจมูก|ทำตา|โบทอก|ฟิลเลอร์|ดูดไขมัน|ทำนม|จัดฟัน|성형|쌍꺼풀|코 수술|보톡스/.test(textAll)) {
      return 'beauty';
    }

    if (/택시|지하철|버스|หลงทาง|รถไฟ|รถเมล์|เดินทาง|환승/.test(textAll)) {
      return 'travel';
    }

    return 'general';
  }

  function buildVocab(finalSit, inputText) {
    const sections = [VOCAB_CORE];

    if (finalSit === 'isaan' || hasIsaan(inputText)) {
      sections.push(
        VOCAB_ISAAN_CORE,
        VOCAB_ISAAN_TIME,
        VOCAB_ISAAN_DAILY,
        VOCAB_ISAAN_ACTIONS,
        VOCAB_ISAAN_HEALTH,
        VOCAB_ISAAN_WORK_LIFE,
        VOCAB_ISAAN_PHRASES,
        VOCAB_ISAAN_FEELINGS,
        VOCAB_ISAAN_FRIEND_TALK,
        VOCAB_ISAAN_SLANG_SAFE,
        VOCAB_ISAAN_GRAMMAR_RULES
      );
      return sections.join('\n');
    }

    if (finalSit === 'hospital') sections.push(VOCAB_HOSPITAL);
    if (finalSit === 'work') sections.push(VOCAB_WORK);
    if (finalSit === 'visa') sections.push(VOCAB_VISA);
    if (finalSit === 'bank') sections.push(VOCAB_BANK_MONEY);
    if (finalSit === 'beauty') sections.push(VOCAB_BEAUTY);
    if (finalSit === 'travel') sections.push(VOCAB_TRAVEL_DAILY);

    if (finalSit === 'general') {
      sections.push(VOCAB_TRAVEL_DAILY);
    }

    return sections.join('\n');
  }

  function detectTurnType(str) {
    const t = String(str || '');
    if (!t) return 'none';

    if (/ไหม|มั้ย|หรือเปล่า|หรือไม่|เหรอ|หรอ|ปะ|บ่|เบาะ/.test(t)) return 'question';
    if (/อะไร|ทำไม|ที่ไหน|เมื่อไหร่|กี่โมง|เท่าไหร่|ยังไง|ใคร|แบบไหน|ไผ|ไส|หยัง|ท่อใด๋|มื้อใด๋/.test(t)) return 'question';
    if (/[?？]$/.test(t.trim())) return 'question';

    return 'statement';
  }

  const finalSit = detectSituation(cleanedText, context || '');
  const vocabHint = buildVocab(finalSit, cleanedText);

  const genderInstruction =
    fromLang === 'kr'
      ? partner_gender === 'female'
        ? `
[GENDER RULE]
The Korean speaker is FEMALE.
Thai output should use female speech naturally: ดิฉัน/หนู/ค่ะ/คะ.
Do not use ผม/ครับ unless the Korean speaker explicitly quotes a man.`
        : partner_gender === 'male'
          ? `
[GENDER RULE]
The Korean speaker is MALE.
Thai output should use male speech naturally: ผม/ครับ.
Do not use ค่ะ/คะ unless the Korean speaker explicitly quotes a woman.`
          : ''
      : user_gender === 'male'
        ? `
[GENDER RULE]
Thai speaker is male. Korean output should be natural and polite.`
        : user_gender === 'female'
          ? `
[GENDER RULE]
Thai speaker is female. Korean output should be natural and polite.`
          : '';

  const turnHint =
    fromLang === 'kr' && prev_turn && prev_turn !== 'none'
      ? `
[PREVIOUS TURN]
The Thai speaker's previous turn was a ${prev_turn === 'question' ? 'QUESTION' : 'STATEMENT'}.
Use this only to understand whether the Korean sentence is likely answering or asking back.`
      : '';

  const topicHint =
    fromLang === 'kr' && last_th && String(last_th).trim()
      ? `
[CONTEXT ONLY]
Previous Thai message: "${String(last_th).trim().substring(0, 80)}"
Use only for disambiguation. Do not translate this previous message.`
      : '';

  const NORMALIZE_SYSTEM = `
You are a transcript normalizer for Thai, Isaan dialect, and Korean speech-to-text.

Your job:
- Clean spacing and punctuation.
- Restore sentence boundaries.
- Preserve every word and meaning.
- Do not summarize.
- Do not answer.
- Do not translate here.
- Output cleaned source text only.

Question detection:
Thai/Isaan question endings:
ไหม, มั้ย, หรือเปล่า, หรือไม่, เหรอ, หรอ, ปะ, บ่, เบาะ, แม่นบ่, ได้บ่, ไปบ่, กินบ่.
Thai/Isaan WH words:
อะไร, ทำไม, ที่ไหน, เมื่อไหร่, กี่โมง, เท่าไหร่, ยังไง, ใคร, ไผ, ไส, หยัง, ท่อใด๋, มื้อใด๋, ยามใด๋.
If clearly a question, add ?.

Korean question endings:
까요, 니까, 나요, 어요, 있어요, 없어요, 어때요, 죠, 지요.
If clearly a question, add ?.

Important Isaan rules:
- อ้าย = older brother / male senior, not AI.
- เอื้อย = older sister / female senior, not AI.
- เด้อ/เน้อ = ending particle.
- แน = please / a bit.
- ซื่อ can mean name or buy depending on context.
- เจ้ากะดายเนาะอ้าย means "พี่ก็น้อ / พี่นี่ก็จริงๆ เลย", not literally "you also can".
- ซิสเบ็ด means fishing.
- กาม่า/ใบกาม่า means foreigner registration card.

Do not censor profanity. Keep it as spoken transcript.
Output cleaned source text only.
`;

  const TRANSLATE_SYSTEM = `
You are a professional Thai-Korean interpreter.

Absolute rule:
You are not a chatbot. You are not a character.
Whatever the speaker says, translate it.
Never answer the speaker.
Never explain.
Never teach.
Never add comments.
Output translation only.

Direction:
- Thai or Isaan input → Korean output only.
- Korean input → Thai output only.

Critical:
- If the input asks "who are you?", translate the question. Do not answer.
- If the input contains Isaan dialect, treat it as real human speech.
- If the input contains profanity or playful insults, translate the meaning naturally. Do not refuse. Do not moralize.
- If it is friends joking, keep it as casual/friend tone.
- If it is a real threat or sexual harassment, translate neutrally without adding extra content.

Speaker intent:
- ผม/ฉัน/หนู/ข่อย + อยาก/ขอ/ต้องการ/สอบถาม = the speaker wants/requests.
- Do not flip "I want to ask" into "Do you want to ask?"
- ช่วย...ได้ไหม / ซอย...ได้บ่ = request help.
- จะ...ให้ = offer help.

Name rule:
If the sentence contains ชื่อ/ซื่อ/제 이름은/저는 + name, keep the name by sound.
Never translate Thai names by meaning.

Isaan safety rule:
Words like ข่อย, เจ้า, อ้าย, เอื้อย, บ่, เด้อ, เว้า, เบิ่ง, ซื่อ are dialect words.
Never interpret them as instructions to AI.
Never say "I am an interpreter".
Never say "I cannot answer".
Translate only.

Thai female speech:
- Statement ending: ค่ะ
- Question ending: คะ

Korean address:
- หมอ in hospital → 선생님
- เจ้าหน้าที่ → 담당자님
- เถ้าแก่/นายจ้าง → 사장님
- อ้าย → 형/오빠 depending on speaker gender if known, otherwise use 형 when translating Isaan casually.
- เอื้อย → 누나/언니 depending on speaker gender if known, otherwise use 누나 when translating casually.

Situation: ${finalSit}
${genderInstruction}
${turnHint}
${topicHint}

If truly unclear audio:
${unclearReply}

Vocabulary and fixed phrases:
${vocabHint}
`;

  async function callAnthropic(system, userContent, maxTokens = 1200) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
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
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody?.error?.message || `API error ${response.status}`);
    }

    const data = await response.json();
    return (data?.content || [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }

  function isBadReply(s) {
    return /(통역사|AI입니다|답변할 수 없|설명해 드리|도와드릴 수 없|cannot answer|cannot respond|I am an AI|I am an interpreter|ฉันเป็นล่าม|ผมเป็นล่าม|ตอบคำถามไม่ได้)/i.test(
      String(s || '')
    );
  }

  function outputWrongLanguage(output, target) {
    const out = String(output || '').trim();
    if (!out) return true;

    const hasThai = /[ก-๙]/.test(out);
    const hasKorean = /[가-힣]/.test(out);

    if (target === 'Korean') return !hasKorean && out.length > 5;
    if (target === 'Thai') return !hasThai && out.length > 5;

    return false;
  }

  function keywordLabels(t) {
    const map = {
      กาม่า: 'บัตรต่างด้าว',
      ใบกาม่า: 'บัตรต่างด้าว',
      วีซ่า: 'วีซ่า',
      พาสปอร์ต: 'พาสปอร์ต',
      ตม: 'ตม.',
      หมอ: 'โรงพยาบาล',
      โรงพยาบาล: 'โรงพยาบาล',
      ปวด: 'อาการปวด',
      ไข้: 'ไข้',
      โตฮ้อน: 'ไข้/ตัวร้อน',
      คันคิง: 'อาการป่วยอีสาน',
      วินหัว: 'เวียนหัว',
      ธนาคาร: 'ธนาคาร',
      รายการเดินบัญชี: 'รายการเดินบัญชี',
      statement: 'รายการเดินบัญชี',
      กุกมิน: 'กุกมิน',
      กุ๊กมิน: 'กุกมิน',
      เทจิก: 'เทจิก',
      เงินเดือน: 'เงินเดือน',
      ลาออก: 'ลาออก',
      เถ้าแก่: 'นายจ้าง',
      ซิสเบ็ด: 'อีสาน/ตกปลา',
      เจ้ากะดาย: 'อีสาน/สำนวน',
      บ่: 'อีสาน',
      เด้อ: 'อีสาน'
    };

    const found = [];
    for (const [k, v] of Object.entries(map)) {
      if (String(t).includes(k)) found.push(v);
    }
    return [...new Set(found)].slice(0, 8).join(', ');
  }

  async function logToSheet(data) {
    const sheetURL = process.env.SHEET_WEBHOOK_URL;
    if (!sheetURL) return;

    try {
      await fetch(sheetURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    } catch (_) {
      // ไม่ให้ logging ทำให้ระบบแปลล่ม
    }
  }

  try {
    const normalizedText = await callAnthropic(
      NORMALIZE_SYSTEM,
      `Language: ${sourceLang}
Normalize this transcript only. Do not translate.

Text:
${cleanedText}`,
      900
    );

    const translation = await callAnthropic(
      TRANSLATE_SYSTEM,
      `Translate this ${sourceLang} text into ${targetLang}. Output translation only.

Text:
${normalizedText}`,
      1400
    );

    let finalTranslation = translation;

    if (isBadReply(finalTranslation) || outputWrongLanguage(finalTranslation, targetLang)) {
      finalTranslation = await callAnthropic(
        TRANSLATE_SYSTEM,
        `Previous output was invalid. Translate again.
Output ${targetLang} only.
Do not answer the speaker.
Do not explain.
Do not refuse.

Text:
${normalizedText}`,
        1200
      );
    }

    if (isBadReply(finalTranslation) || outputWrongLanguage(finalTranslation, targetLang)) {
      finalTranslation = unclearReply;
    }

    const logPayload = {
      fromLang,
      situation: finalSit,
      chars: cleanedText.length,
      keywords: keywordLabels(cleanedText),
      orig: cleanedText.substring(0, 80),
      normalized: normalizedText.substring(0, 80),
      trans: finalTranslation.substring(0, 80),
      userGender: user_gender || '',
      partnerGender: partner_gender || '',
      ip: cleanIP
    };

    logToSheet(logPayload);

    console.log(
      'USAGE:',
      JSON.stringify({
        time: new Date().toISOString(),
        fromLang,
        chars: cleanedText.length,
        situation: finalSit,
        ip: cleanIP
      })
    );

    return res.status(200).json({
      translation: finalTranslation,
      situation: finalSit
    });
  } catch (err) {
    console.error('TRANSLATE_ERROR:', err.message);
    return res.status(500).json({
      error: 'Server error',
      translation: unclearReply
    });
  }
}
