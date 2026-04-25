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

  const VOCAB_CORE = `
[คำพื้นฐานไทย-เกาหลี]
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

[คำเรียกคน]
พี่ชาย=형/오빠 ตามเพศผู้พูด
พี่สาว=누나/언니 ตามเพศผู้พูด
น้องชาย=남동생
น้องสาว=여동생
เพื่อน=친구
คนไทย=태국 사람
คนเกาหลี=한국 사람
เจ้าหน้าที่=담당자님/직원분
หมอ=선생님/의사
พยาบาล=간호사

[คำถามทั่วไป]
อะไร=뭐
ทำไม=왜
ที่ไหน=어디
เมื่อไหร่=언제
ใคร=누구
เท่าไหร่=얼마
ยังไง=어떻게
ใช่ไหม=맞아요?
โอเคไหม=괜찮아요?
เข้าใจไหม=이해했어요?
มีไหม=있어요?
ไม่มี=없어요
ได้ไหม=돼요?
ช่วยได้ไหม=도와줄 수 있어요?

[ชื่อและตัวตน]
ผมชื่อ=제 이름은
ฉันชื่อ=제 이름은
หนูชื่อ=제 이름은
ข่อยซื่อ=제 이름은
ชื่ออะไร=이름이 뭐예요?
คุณชื่ออะไร=이름이 뭐예요?

[กฎชื่อคน]
หลังคำว่า ชื่อ/ซื่อ/제 이름은/이름이 คือชื่อคน ห้ามแปลความหมาย ให้ทับเสียงเท่านั้น
เช่น ผมชื่อต้น = 제 이름은 톤이에요
ข่อยซื่อแมนเด้อ = 제 이름은 맨이에요
`;

  const VOCAB_WORK = `
[งาน/โรงงาน]
ลาออก=퇴사하다
ไล่ออก=해고되다
เปลี่ยนงาน/ย้ายงาน=사업장을 변경하다
สัญญาจ้าง=근로계약서
หมดสัญญา=계약 만료
ต่อสัญญา=계약 연장
โอที/ค่าโอที=야근/야근수당
วันหยุด=휴무일
ลาป่วย=병가
ลาพักร้อน=연차
มาสาย=지각하다
ขาดงาน=결근하다
เข้างาน=출근하다
เลิกงาน=퇴근하다
เงินเดือนสุทธิ=실수령액
เงินเดือนก่อนหัก=세전 월급
หักเงิน=공제
โดนหักเงิน=돈이 공제됐다
เงินเดือนค้าง=임금 체불
นายจ้างไม่จ่ายเงิน=사장님이 월급을 안 줍니다
โดนโกงเงิน=돈을 사기당했습니다
โดนเอาเปรียบ=부당한 대우를 받았습니다
ใบรับรองการทำงาน=재직증명서
ขอใบรับรองการทำงาน=재직증명서를 발급받고 싶습니다
ใบรับรองรายได้=소득금액증명원
ใบหักภาษี=원천징수영수증
ใช้ยื่นวีซ่า=비자 신청용입니다
ใช้ยื่นธนาคาร=은행 제출용입니다

[งานเกษตร/สวน/ไร่]
ดำนา/ปลูกข้าว=모내기
เกี่ยวข้าว=벼베기
เกี่ยวหญ้า=풀베기
พ่นยา/ฉีดยา=약 치다/살충제 뿌리다
ใส่ปุ๋ย=비료 주다
เก็บผัก=채소 수확
ปลูกผัก=채소 심기
รดน้ำผัก=물 주기
สวนแอปเปิ้ล=사과 과수원
สวนส้ม=귤 농장
สวนแตงโม=수박 밭
สวนพริก=고추 밭
โรงเรือน=비닐하우스
ขุดดิน=땅 파기
พรวนดิน=흙 뒤집기

[งานก่อสร้าง]
แบกปูน=시멘트 나르기
เทปูน=콘크리트 타설
ผูกเหล็ก=철근 결속
นั่งร้าน=비계
ทาสี=페인트칠
ปูกระเบื้อง=타일 깔기
รื้อถอน=철거
งานไม้=목공
รถแม็คโคร=포클레인
รถดั้ม=덤프트럭
รถแทรกเตอร์=트랙터
`;

  const VOCAB_HOSPITAL = `
[โรงพยาบาล/คลินิก]
โรงพยาบาล=병원
คลินิก=의원
ร้านขายยา=약국
หมอ=의사/선생님
พยาบาล=간호사
ห้องฉุกเฉิน=응급실
ห้องผ่าตัด=수술실
ห้องพักฟื้น=회복실
เคาน์เตอร์รับบัตร=접수처
นัดหมอ=진료 예약
จองคิว=예약하다
มาหาหมอ=진료를 받으러 왔습니다
มาตรวจร่างกาย=건강검진을 받으러 왔습니다

[อาการ]
ปวดหัว=머리가 아프다
ปวดท้อง=배가 아프다
ปวดหลัง=허리가 아프다
ปวดไหล่=어깨가 아프다
ปวดขา=다리가 아프다
ปวดแขน=팔이 아프다
ปวดฟัน=이가 아프다
ปวดหู=귀가 아프다
ปวดตา=눈이 아프다
ปวดอก=가슴이 아프다
เวียนหัว=어지럽다
มีไข้=열이 나다
ตัวร้อน=몸에 열이 나다
ไอ=기침하다
น้ำมูก=콧물이 나다
คัดจมูก=코가 막히다
เจ็บคอ=목이 아프다
คลื่นไส้=메스꺼움
อาเจียน=구토하다
ท้องเสีย=설사하다
ท้องผูก=변비
บวม=붓다
ช้ำ=멍들다
แผล=상처
เลือดออก=피가 나다
หายใจไม่ออก=숨이 차다
ใจสั่น=심장이 두근거리다
ชา=저리다
อ่อนแรง=힘이 없다
เป็นลม=기절하다
หมดสติ=의식이 없다

[โรคทั่วไป]
หวัด=감기
ไข้หวัดใหญ่=독감
โควิด=코로나
กระเพาะอักเสบ=위염
กรดไหลย้อน=역류성 식도염
ลำไส้อักเสบ=장염
อาหารเป็นพิษ=식중독
ภูมิแพ้=알레르기
หอบหืด=천식
หลอดลมอักเสบ=기관지염
ปอดอักเสบ=폐렴
ไมเกรน=편두통
ความดันสูง=고혈압
เบาหวาน=당뇨병
ไขมันในเลือดสูง=고지혈증
โรคหัวใจ=심장병
ติดเชื้อ=감염
อักเสบ=염증

[ยา/การรักษา]
ยาแก้ปวด=진통제
ยาแก้อักเสบ=소염제
ยาฆ่าเชื้อ=항생제
ยาลดไข้=해열제
ยาแก้แพ้=항히스타민제
ใบสั่งยา=처방전
กินยา=약을 먹다
ฉีดยา=주사를 맞다
วันละ 3 ครั้ง=하루 세 번
หลังอาหาร=식후
ก่อนอาหาร=식전
ก่อนนอน=자기 전

[ตรวจ/เอกสาร]
ตรวจเลือด=피검사
ตรวจปัสสาวะ=소변검사
เอ็กซเรย์=엑스레이
ซีทีสแกน=CT
เอ็มอาร์ไอ=MRI
อัลตราซาวด์=초음파
ผลตรวจ=검사 결과
ใบรับรองแพทย์=진단서
ขอใบรับรองแพทย์=진단서를 발급받고 싶습니다
ใบรับรองการรักษา=진료확인서
ใบเสร็จค่ารักษา=진료비 영수증
รายละเอียดค่ารักษา=진료비 세부내역서
ใช้ยื่นประกัน=보험 청구용입니다
ใช้ยื่นบริษัท=회사 제출용입니다
`;

  const VOCAB_VISA = `
[วีซ่า/ราชการ/ตม.]
บัตรต่างด้าว=외국인등록증
ใบกาม่า=외국인등록증
กาม่า=외국인등록증
บัตรกาม่า=외국인등록증
กาม่าหาย=외국인등록증을 분실했습니다
ใบกาม่าหาย=외국인등록증을 분실했습니다
ทำบัตรต่างด้าวใหม่=외국인등록증 재발급
พาสปอร์ต=여권
พาสปอร์ตหาย=여권을 분실했습니다
ตม=출입국관리사무소
ซุลลิก/ซุลลิกซา=출입국관리사무소
ต่อวีซ่า=비자 연장
เปลี่ยนวีซ่า=비자 변경
ยื่นวีซ่า=비자 신청
เอกสาร=서류
ยื่นเอกสาร=서류 제출
นัด/จองคิว=예약하다
หมดวีซ่า=비자 만료
เกินวีซ่า=체류기간 초과
แรงงานผิดกฎหมาย=불법체류자
ผีน้อย=불법체류자
E-9/อีเก้า/อีนาย=E-9 비자
E-7-4/อีเจ็ดสี่=E-7-4 비자
E-7-4R=E-7-4R 비자
F-2-R/เอฟทูอาร์=F-2-R 비자
F-6/เอฟหก=F-6 비자
TOPIK=TOPIK
KIIP=KIIP
เปลี่ยนที่อยู่=주소 변경 신고
แจ้งย้ายที่อยู่=전입신고
HiKorea=하이코리아
จองคิวออนไลน์=온라인 예약
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
สำเนาทะเบียนบ้าน=호적등본/주민등록등본에 해당하는 태국 서류
ทะเบียนบ้าน=호적등본에 해당하는 태국 서류
หนังสือรับรองความประพฤติ=범죄경력증명서
ใช้ยื่นสถานทูต=대사관 제출용입니다
`;

  const VOCAB_BANK_MONEY = `
[เงิน/ประกัน/ภาษี/ธนาคาร]
ธนาคาร=은행
เปิดบัญชี=계좌 개설
ปิดบัญชี=계좌 해지
สมุดบัญชี=통장
บัตรเอทีเอ็ม=체크카드/ATM 카드
บัตรเครดิต=신용카드
โอนเงิน=송금하다
โอนเงินกลับไทย=태국으로 해외송금하다
ฝากเงิน=입금하다
ถอนเงิน=출금하다
ยอดเงิน/ยอดคงเหลือ=잔액
ค่าธรรมเนียมโอน=송금 수수료
บัญชีโดนล็อค=계좌가 막혔습니다
ลืมรหัส=비밀번호를 잊어버렸습니다
ขอเอกสารธนาคาร=은행 서류를 발급받고 싶습니다
ใบรับรองบัญชี=계좌개설확인서
ใบรับรองยอดเงิน=잔액증명서
รายการเดินบัญชี=거래내역서
statement=거래내역서
รายการเดินบัญชี 3 เดือน=최근 3개월 거래내역서
รายการเดินบัญชี 6 เดือน=최근 6개월 거래내역서
รายการเดินบัญชี 1 ปี=최근 1년 거래내역서
ใช้ยื่นวีซ่า=비자 신청용입니다
ใช้ยื่น ตม.=출입국 제출용입니다
ใช้ยื่นสถานทูต=대사관 제출용입니다

[ประกัน/เงินสะสม]
กุ๊กมิน/กุกมิน/กูมิน/เงินกุกมิน=국민연금
เงินกุกมินสะสม=국민연금 적립금
ขอเงินกุกมินคืน=국민연금 반환일시금 신청
เทจิก/แทจิก/เตจิก/เงินเทจิก=퇴직금
ประกันสังคม=사회보험/4대보험
ประกันสุขภาพ=건강보험
ประกันอุบัติเหตุ=산재보험
ประกันการจ้างงาน=고용보험
เงินประกันเดินทาง=출국만기보험금
เงินประกันกลับประเทศ=귀국비용보험금
ภาษี=세금
ภาษีเงินได้=소득세
คืนภาษี=세금 환급
ยื่นภาษีประจำปี=연말정산
`;

  const VOCAB_DAILY = `
[ร้านอาหาร/ซื้อของ/เดินทาง/ที่พัก]
ร้านอาหาร=식당
เมนู=메뉴
สั่งอาหาร=주문하다
เอาอันนี้=이걸로 주세요
ห่อกลับ=포장해 주세요
ขอน้ำ=물 주세요
ไม่เผ็ด=안 맵게 해 주세요
เผ็ดน้อย=덜 맵게 해 주세요
คิดเงิน=계산해 주세요
ราคาเท่าไหร่=얼마예요?
ลดหน่อย=좀 깎아 주세요
ขอถุง=봉투 주세요
ขอใบเสร็จ=영수증 주세요
รถเมล์=버스
รถไฟฟ้า=지하철
แท็กซี่=택시
สถานี=역
ไปทางไหน=어디로 가요?
หลงทาง=길을 잃었어요
จอดตรงนี้=여기서 세워 주세요
ซ้าย=왼쪽
ขวา=오른쪽
ตรงไป=직진
เลี้ยวซ้าย=좌회전
เลี้ยวขวา=우회전
บ้านเช่า/ห้องเช่า=월세방/원룸
ค่าเช่า=월세
เงินมัดจำ=보증금
เจ้าของบ้าน=집주인
ย้ายบ้าน=이사하다
น้ำไม่ไหล=물이 안 나와요
ไฟดับ=전기가 나갔어요
ฮีตเตอร์เสีย=난방 고장
`;

  const VOCAB_BEAUTY = `
[ศัลยกรรม/ความงาม]
ศัลยกรรม=성형수술
ทำตาสองชั้น/ซองกาพุล=쌍꺼풀 수술
เย็บไม่กรีด=매몰법
กรีดตา=절개법
เปิดหัวตา=앞트임
เปิดหางตา=뒤트임
เสริมจมูก=코 수술
โคซูซูล=코 수술
ซิลิโคน=실리콘
กระดูกตัวเอง=자가연골
สันจมูก=콧대
ปลายจมูก=코끝
ฟิลเลอร์ปาก=입술 필러
ยกมุมปาก=입꼬리 수술
ศัลยกรรมโครงหน้า=윤곽수술
ลดโหนกแก้ม=광대 축소
กรามเหลี่ยม=사각턱
หน้าเรียว=V라인
ศัลยกรรมคาง=턱 수술
เสริมหน้าอก/ทำนม=가슴 수술
ดูดไขมัน=지방흡입
โบทอก/Botox=보톡스
ฟิลเลอร์/Filler=필러
เลเซอร์=레이저
ยกกระชับ=리프팅
ผิวขาว=미백
ลดริ้วรอย=주름 개선
จัดฟัน=치아교정
รากฟันเทียม=임플란트
ฟอกสีฟัน=치아미백
ขูดหินปูน=스케일링
ยาชา=마취
ดมยาสลบ=전신마취
ผลข้างเคียง=부작용
แผลเป็น=흉터
แก้จมูก/แก้งาน=재수술
อยากปรึกษา=상담 받고 싶어요
ราคาเท่าไหร่=비용이 얼마예요?
ใช้เวลาฟื้นตัวกี่วัน=회복 기간은 얼마나 걸려요?
`;

  const VOCAB_ISAAN_CORE = `
[อีสานพื้นฐาน]
ข่อย=ฉัน/ผม
เจ้า=คุณ
เฮา=เรา
เพิ่น=เขา/เธอ/คนนั้น
อ้าย=พี่ชาย
เอื้อย=พี่สาว
บัก=ไอ้/นาย/ผู้ชายคนนั้น
อี=ยัย/นาง/ผู้หญิงคนนั้น
บ่=ไม่
แม่น=ใช่/ถูก
หยัง/อีหยัง=อะไร
ไผ=ใคร
ไส=ที่ไหน
จั่งได๋=ยังไง
มื้อใด๋=เมื่อไหร่
มื้อนี้=วันนี้
มื้ออื่น=พรุ่งนี้
มื้อวาน=เมื่อวาน
โดนบ่=นานไหม
เว้า=พูด
เบิ่ง=ดู
เฮ็ด=ทำ
ฟ้าว=รีบ
ย่าง=เดิน
แล่น=วิ่ง
พ้อ=เจอ
เมือ=กลับ
ฮอด=ถึง
ซอย=ช่วย
สิ=จะ
สิมา=จะมา
สิไป=จะไป
สิกิน=จะกิน
สิกลับ=จะกลับ
ค่อย=เดี๋ยว/ค่อยๆ ตามบริบท
แซ่บ=อร่อย
ม่วน=สนุก
คัก=มาก/จริงๆ
หลาย=มาก/เยอะ
น้อย=นิดเดียว
ฮ้อน=ร้อน
หนาว=หนาว
เมื่อย=เหนื่อย
คึดฮอด=คิดถึง
ฮัก=รัก
ซัง=เกลียด
เคียด=โกรธ
ย่าน=กลัว
งึด=ทึ่ง/งง/เหลือเชื่อ/อึ้ง
หนหวย=รำคาญ/หงุดหงิด
เหลือใจ=เจ็บใจ/เหนื่อยใจ/เหลือเกิน
เป็นตาหน่าย=น่าเบื่อ/น่ารำคาญ
เป็นตาฮัก=น่ารัก
เป็นตาซัง=น่าหมั่นไส้/น่ารำคาญ
จั๊ก=ไม่รู้
จั๊กแล้ว=ไม่รู้สิ
อิหลี=จริงๆ
แมนบ่=ใช่ไหม
วาแท้บ่=จริงเหรอ
เด้อ/เน้อ=นะ/เนอะ/คำลงท้าย
แน=หน่อย
เบาะ=เหรอ
ดอก=หรอก
ซั่น=งั้น/อย่างนั้น
จั่งซี่=แบบนี้
จั่งซั่น=แบบนั้น
พุ้นนะ=นั่นไง/ดูนั่นสิ
พะนะ=น่ะเหรอ/ประชด
ป๊าด=โอ้โห
ฮ่วย=เอ้า/โธ่/อุทานหงุดหงิด
เอ๋า=อ้าว
บ๊ะ=เฮ้ย/โห

[คำอีสานที่มักแปลผิด]
ซื่อ=ชื่อ ถ้ามี ข่อย/ผม/ฉัน นำหน้า
ซื่อ=ซื้อ ถ้ามี ไป/อยาก/สิ นำหน้า
ตั๋ว=โกหก ถ้าอยู่ในบริบทขี้ตั๋ว/ตั๋วคน
ตั๋ว=ตั๋วเดินทาง ถ้าอยู่กับรถ/เครื่องบิน/ซื้อ
ค่อย=เดี๋ยว ถ้ามีกริยาตามหลัง เช่น ค่อยไป
ค่อยๆ= 천천히
กะดาย=ก็ได้/ก็ยังได้/ก็เหลือเกิน ตามบริบท
เจ้ากะดายเนาะ=คุณนี่ก็เหลือเกิน/คุณก็ทำไปได้/คุณก็ช่างน้อ
มะซางวาแท้=ทำไมเป็นแบบนั้นจริงๆ/ทำไปได้
กลับมะซางวาแท้=รีบกลับมาสักทีนะจริงๆ
ซิสเบ็ด=ตกเบ็ด/낚시하다

[อีสานอาการป่วย]
โตฮ้อน=ตัวร้อน/มีไข้
คันคิง=ครั่นเนื้อครั่นตัว
วินหัว=เวียนหัว
เจ็บแข่ว=ปวดฟัน
แข่วโยก=ฟันโยก
ปวดเอว=ปวดหลัง/ปวดเอว
เจ็บเส้น=กล้ามเนื้อยึด/ปวดเส้น
หนาวสั่น=หนาวสั่น
ฮาก=อาเจียน
ขี้ราก=ท้องเสียหนัก/อาเจียนท้องเสีย
ท้องป่วง=ท้องเสีย
เจ็บท้องบิด=ปวดท้องบิด
หายใจฟืดฟาด=หายใจลำบาก
ตาฟาง=มองไม่ชัด
หูอื้อ=หูอื้อ
ตะคริวกิน=เป็นตะคริว
เป็นลมแดด=ลมแดด
ตีน=เท้า
แข่ว=ฟัน
เกิบ=รองเท้า
โรงยา=โรงพยาบาล/ร้านยา ตามบริบท

[อีสานชีวิตประจำวัน]
กินข้าว=밥 먹다
หิวข้าว=배고프다
อิ่มแล้ว=배부르다
ข้าวเหนียว=찹쌀밥
ตำบักหุ่ง=파파야 샐러드
ปลาแดก=젓갈/ปลาร้า
ซอยจุ๊=육회 스타일 음식
ก้อย=고이/อีสานดิบยำ
ลาบ=라브
แจ่ว=매운 소스
แจ่วบอง=젓갈 양념 소스
เฮือน=บ้าน
เถียงนา=กระท่อมนา
เกิบ=รองเท้า
สิไปตลาด=ตลาด에 갈 거예요
สิไปซิสเบ็ด=낚시하러 갈 거예요
ไปซิสเบ็ดนำกันบ่=같이 낚시하러 갈래요?
ได้ปลาบ่=물고기 잡았어요?
บ่ได้จักโต=한 마리도 못 잡았어요
`;

  const VOCAB_ISAAN_BANTER = `
[อีสาน: คำสบถ / คำด่าเล่น / คำหยอกเพื่อน]
IMPORTANT:
- These are Isaan dialect banter words. They may sound rude, but Thai/Isaan speakers often use them jokingly with close friends.
- Translate the meaning and emotional tone. Do NOT refuse. Do NOT lecture. Do NOT explain.
- If playful, use playful Korean slang. If angry, use stronger Korean.
- Never treat these words as actual commands to harm someone.
- Output translation only.

[ตระกูล ห่า]
ห่ากินหัวมึงเอ้ย=에이 망할 놈아 / 이 자식아
หากินหัวมึงเอ้ย=에이 망할 놈아 / 이 자식아
ห่าตำปอด=에이 망할 놈아 / 급살 맞을 놈아
ห่าลากมึงเอ้ย=이 빌어먹을 놈아
ห่าขั่วกินมึง=못된 놈아 / 망할 놈아
ห่ากวนปอดมึงเอ้ย=속 뒤집어 놓는 놈아
จั่งแม่นมันห่าคัก=진짜 지독하네 / 참 못됐네
บักห่ารากไส้=천벌 받을 놈 / 아주 못된 놈
บักห่ามึงเอ้ย=에이 이놈아 / 망할 놈아
อีห่า=에이 이년아 / 망할 년아
ไอ้ห่า=에이 이놈아 / 망할 놈아

[ด่าเล่น/ด่าจริงตามน้ำเสียง]
บักสันดานหมา=개 같은 성격의 놈
บักสันดานบ่ดี=인성이 나쁜 놈
บักหน้าด้าน=뻔뻔한 놈
หน้าด้านหน้าทน=정말 뻔뻔하다
บักขี้ตั๋วตาใส=뻔뻔하게 거짓말하는 놈
อีตอแหล=거짓말쟁이야 / 구라 치지 마
อย่ามาตอแหล=거짓말하지 마
บักขี้สบู่=허풍쟁이
บักขี้โม้=허풍쟁이
บักขี้คร้านมึน=정말 게으른 놈
บักกินแรง=남한테 일 떠넘기는 놈
บักเอาเปรียบ=남을 이용해 먹는 놈
บักจัญไร=재수 없는 놈
บักเปรตขอส่วนบุญ=거지 같은 놈
อีผีบ้า=미친년아
บักประสาทแดก=정신 나간 놈
บักปากหมา=입이 더러운 놈
ปากหมา=말을 더럽게 하다
ปากอมขี้มาพูด=입이 더럽다
หุบปากเน่าๆ=그 더러운 입 닥쳐
บักปึก=멍청이
บักปึกกะหลึน=돌대가리 / 진짜 멍청이
บักปึกกะด้อ=진짜 멍청한 놈
บักปัญญาอ่อน=모자란 놈
ควาย=바보 / 멍청이
บักควาย=이 바보 같은 놈
ควายเรียกพี่=바보 중의 상바보
ซื่อบื้อ=멍청하다 / 눈치 없다
มึนตึบ=멍하다
อย่ามาเฮ็ดหน้ามึนตึบ=시치미 떼지 마

[แซะ/ประชด/หยอก]
เจ้ากะดายเนาะ=너도 참 대단하다 / 너도 참 어이가 없다
เจ้ากะดายเนาะอ้าย=형도 참 어이가 없네요
เจ้ากะดายเนาะเอื้อย=누나도 참 어이가 없네요
พี่ก็น้อ=형도 참 / 누나도 참
อ้ายกะดายเนาะ=형도 참 어이가 없네요
เอื้อยกะดายเนาะ=누나도 참 어이가 없네요
มะซางวาแท้=참 대단하네 / 정말 왜 그러는 거야
พุ้นนะ=저것 봐라 / 봐라 또 저러네
จั่งซั่นแหละ=그러니까 말이야
จั่งซี่กะได้เบาะ=이래도 돼요?
แม่นอีหลี=진짜 그래요
แม่นความเพิ่น=그 사람 말이 맞아요
จักแล้ว=글쎄요 / 나도 몰라요
ป๊าด=우와 / 대박
ป๊าดติโธ่=세상에 / 대박이다
ป๊าดโธ่=아이고 / 대박이네
ฮ่วย=아 진짜 / 아이고 참
เอ๋า=어라?
บ๊ะ=헐
พะนะ=참나 / 뭐래
กะด้อ=참나 / 너무하네
โพดโพ=너무하네 / 심하네
คักแท้=진짜 심하네

[ตัวอย่างบังคับ]
เจ้ากะดายเนาะอ้าย=형도 참 어이가 없네요
เจ้ากะดายเนาะเอื้อย=누나도 참 어이가 없네요
พี่ก็น้อ=형도 참 대단하네요 / 누나도 참 대단하네요
มะซางวาแท้=참 대단하네 / 정말 왜 그러는 거야
ห่ากินหัวมึงเอ้ย=에이 망할 놈아
ห่าลากมึงเอ้ย=이 빌어먹을 놈아
บักปึกกะหลึน=이 멍청한 놈아
บักขี้ตั๋วตาใส=뻔뻔하게 거짓말하네
อีตอแหล=거짓말하지 마
อย่ามาเฮ็ดหน้ามึนตึบ=시치미 떼지 마
บักขี้คร้านมึน=정말 게으른 놈이네
สิไปซิสเบ็ดบ่=낚시하러 갈래요?
ไปซิสเบ็ดนำกันบ่=같이 낚시하러 갈래요?
`;

  const SITUATION_CONTEXT = {
    general: '',
    hospital:
      'Situation: hospital/clinic. The Thai user is normally the patient. The Korean speaker is normally doctor/nurse/staff. Never translate Thai speaker as a doctor unless clearly stated.',
    work:
      'Situation: workplace/factory. Focus on labor, contract, salary, boss, factory, safety, and workplace vocabulary.',
    visa:
      'Situation: immigration/visa/government office/embassy. Focus on documents, foreigner registration card, visa, passport, embassy, and official certificate vocabulary.',
    money:
      'Situation: money/tax/insurance/bank. Focus on 국민연금, 퇴직금, tax, insurance, bank statement, account certificate.',
    bank:
      'Situation: bank. Focus on banking, statements, balance certificate, account, transfer.',
    food:
      'Situation: restaurant/food ordering.',
    shop:
      'Situation: shopping/retail.',
    travel:
      'Situation: travel/directions/transportation.',
    housing:
      'Situation: housing/rental/room/landlord.',
    emergency:
      'Situation: emergency. Prioritize urgent help vocabulary.',
    beauty:
      'Situation: beauty clinic/plastic surgery/dental/cosmetic procedure.',
    isaan:
      'Situation: Isaan dialect. Convert Isaan meaning into standard Thai internally, then translate. Do not answer as AI. Translate only.'
  };

  const VOCAB_BY_SITUATION = {
    general: VOCAB_DAILY,
    work: VOCAB_WORK,
    hospital: VOCAB_HOSPITAL,
    visa: VOCAB_VISA,
    money: VOCAB_BANK_MONEY,
    bank: VOCAB_BANK_MONEY,
    food: VOCAB_DAILY,
    shop: VOCAB_DAILY,
    travel: VOCAB_DAILY,
    housing: VOCAB_DAILY,
    emergency: VOCAB_HOSPITAL,
    beauty: VOCAB_BEAUTY,
    isaan: `${VOCAB_ISAAN_CORE}\n${VOCAB_ISAAN_BANTER}`
  };

  function getContextSit(ctx = '') {
    if (ctx.includes('โรงพยาบาล')) return 'hospital';
    if (ctx.includes('ทำงาน')) return 'work';
    if (ctx.includes('ราชการ') || ctx.includes('วีซ่า')) return 'visa';
    if (ctx.includes('เงิน') || ctx.includes('ประกัน')) return 'money';
    if (ctx.includes('ธนาคาร')) return 'bank';
    if (ctx.includes('ร้านอาหาร')) return 'food';
    if (ctx.includes('ช้อปปิ้ง')) return 'shop';
    if (ctx.includes('เดินทาง')) return 'travel';
    if (ctx.includes('ที่พัก')) return 'housing';
    if (ctx.includes('ฉุกเฉิน')) return 'emergency';
    if (ctx.includes('ศัลยกรรม') || ctx.includes('ความงาม')) return 'beauty';
    if (ctx.includes('อีสาน')) return 'isaan';
    return 'general';
  }

  function autoDetectSit(t) {
    const ctxSit = getContextSit(context || '');
    const s = String(t || '');

    if (/ข่อย|เจ้า|เฮา|เพิ่น|อ้าย|เอื้อย|เบิ่ง|เว้า|เฮ็ด|ฟ้าว|พ้อ|เมือ|แม่น|บ่ใช่|บ่ได้|บ่มี|ฮัก|ซัง|เคียด|ม่วน|แซ่บ|คัก|คักแน่|เด้อ|เน้อ|งึด|กะดาย|มะซาง|ซิสเบ็ด|ห่ากิน|ห่าลาก|บักปึก|บักพาก|บักห่า|ขี้ตั๋ว|ตอแหล|หนหวย|เหลือใจ|เป็นตาหน่าย|โตฮ้อน|คันคิง|วินหัว|แข่ว/.test(s)) {
      return 'isaan';
    }

    if (/ปวด|หมอ|ยา|โรงพยาบาล|ไข้|เจ็บ|คลินิก|ใบรับรองแพทย์|진단서|처방전|아프|병원|의사|약|증상|진료/.test(s)) {
      return 'hospital';
    }

    if (/เถ้าแก่|ลาออก|เงินเดือน|สัญญา|โรงงาน|โอที|사장|공장|월급|계약|퇴사|야근/.test(s)) {
      return 'work';
    }

    if (/วีซ่า|กาม่า|บัตรต่างด้าว|ตม|พาสปอร์ต|ต่อวีซ่า|สถานทูต|กงสุล|ใบรับรองโสด|หนังสือมอบอำนาจ|แปลรับรอง|비자|여권|외국인등록|출입국/.test(s)) {
      return 'visa';
    }

    if (/ธนาคาร|โอนเงิน|กุกมิน|กุ๊กมิน|เทจิก|แทจิก|ประกัน|ภาษี|statement|รายการเดินบัญชี|ใบรับรองยอดเงิน|은행|송금|계좌|국민연금|퇴직금|잔액증명서|거래내역/.test(s)) {
      return 'bank';
    }

    if (/ศัลยกรรม|เสริมจมูก|ทำตา|โบทอก|ฟิลเลอร์|ดูดไขมัน|ทำนม|จัดฟัน|성형|쌍꺼풀|코 수술|보톡스|필러/.test(s)) {
      return 'beauty';
    }

    if (/택시|지하철|버스|หลงทาง|รถไฟ|แท็กซี่|ทางไหน|환승/.test(s)) {
      return 'travel';
    }

    return ctxSit;
  }

  const finalSit = autoDetectSit(cleanedText);
  const situationCtx = SITUATION_CONTEXT[finalSit] || '';

  function buildVocabHint() {
    const sections = [VOCAB_CORE];

    if (VOCAB_BY_SITUATION[finalSit]) {
      sections.push(VOCAB_BY_SITUATION[finalSit]);
    }

    const hasIsaanTone = /ข่อย|เจ้า|เฮา|เพิ่น|อ้าย|เอื้อย|บ่|แม่น|หยัง|ไผ|ไส|เว้า|เบิ่ง|เฮ็ด|ฟ้าว|พ้อ|เมือ|เด้อ|เน้อ|คัก|ม่วน|แซ่บ|งึด|ห่า|บัก|อีตอแหล|ขี้ตั๋ว|กะดาย|มะซาง|ซิสเบ็ด|โตฮ้อน|คันคิง|แข่ว/.test(cleanedText);

    if (finalSit !== 'isaan' && hasIsaanTone) {
      sections.push(VOCAB_ISAAN_CORE);
      sections.push(VOCAB_ISAAN_BANTER);
    }

    if (finalSit === 'general') {
      sections.push(VOCAB_DAILY);
    }

    return sections.filter(Boolean).join('\n');
  }

  const vocabHint = buildVocabHint();

  function detectTurnType(t) {
    const s = String(t || '');
    if (/ไหม|มั้ย|หรือเปล่า|หรือไม่|เหรอ|หรอ|ปะ$/.test(s)) return 'question';
    if (/เท่าไหร่|เท่าไร|ที่ไหน|ยังไง|อย่างไร|ทำไม|เมื่อไหร่|ใคร|อะไร|กี่/.test(s)) return 'question';
    if (/[?？]$/.test(s)) return 'question';
    return 'statement';
  }

  let genderInstruction = '';

  if (fromLang === 'kr') {
    if (partner_gender === 'female') {
      genderInstruction = `
[GENDER RULE - MANDATORY]
The Korean speaker is FEMALE.
Thai output must use female speech: ดิฉัน/หนู/ค่ะ/คะ/นะคะ.
Forbidden: ผม, ครับ, นะครับ.`;
    } else if (partner_gender === 'male') {
      genderInstruction = `
[GENDER RULE - MANDATORY]
The Korean speaker is MALE.
Thai output must use male speech: ผม/ครับ/นะครับ.
Forbidden: ดิฉัน, ค่ะ, คะ, นะคะ.`;
    }
  } else {
    if (user_gender === 'male') {
      genderInstruction = `
[GENDER RULE - MANDATORY]
The Thai speaker is MALE. Korean output should be natural polite Korean.`;
    } else if (user_gender === 'female') {
      genderInstruction = `
[GENDER RULE - MANDATORY]
The Thai speaker is FEMALE. Korean output should be natural polite Korean.`;
    }
  }

  const turnHint =
    fromLang === 'kr' && prev_turn && prev_turn !== 'none'
      ? `
Previous Thai turn type: ${prev_turn}.
Use it only to resolve whether Korean response is answering, asking, or acknowledging.`
      : '';

  const topicHint =
    fromLang === 'kr' && last_th && String(last_th).trim()
      ? `
[CONTEXT ONLY]
Previous Thai message: "${String(last_th).trim().substring(0, 80)}"
Use only to resolve ambiguity. Do not translate or include this text.`
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
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }

  const NORMALIZE_SYSTEM = `
You are a transcript normalizer for Thai, Isaan dialect, and Korean speech-to-text.

Your job:
- Clean punctuation and spacing.
- Preserve every word and meaning.
- Do not summarize.
- Do not answer.
- Do not explain.
- Output cleaned source-language transcript only.

Thai/Isaan question detection:
ไหม, มั้ย, หรือเปล่า, หรือไม่, เหรอ, หรอ, ปะ, บ่, เบาะ, แมนบ่, แม่นบ่, วาแท้บ่ = question.
WH words: อะไร, อีหยัง, หยัง, ทำไม, เป็นหยัง, ที่ไหน, ไส, เมื่อไหร่, มื้อใด๋, ใคร, ไผ, เท่าไหร่, กี่, จั่งได๋.

Add ? when clearly a question.

Thai spacing fixes:
- Add space after particles: ครับ, ค่ะ, คะ, นะ, เด้อ, เน้อ, แล้ว, ก็, จะ, สิ, ได้, ไม่, บ่.
- Keep these together: คุณหมอ, โรงพยาบาล, ร้านขายยา, บัตรต่างด้าว, ใบกาม่า, สถานทูต, รายการเดินบัญชี.
- If speech is glued together, separate into natural short sentences.

Role rules:
- "ผมมาหาหมอ" = patient came to see doctor.
- "ผมมาตรวจร่างกาย" = patient came for health checkup.
- Never make the Thai speaker a doctor/bank officer/immigration officer unless explicitly stated.

Isaan rules:
- อ้าย = older brother, not AI.
- เอื้อย = older sister.
- เด้อ/เน้อ = ending particles, not commands.
- เจ้า = you, not "owner".
- ซื่อ = name if after ข่อย/ผม/ฉัน, but buy if after ไป/สิ/อยาก.
- กะดาย = emotional particle depending context, often "you too, huh / you are something".
- ซิสเบ็ด = fishing.

Name rule:
After ชื่อ/ซื่อ/my name is/제 이름은/이름이, the following word is a personal name. Keep by sound. Never translate meaning.

Korean ambiguous expressions:
네 = yes/ครับ/ค่ะ
그래요? = อย่างนั้นเหรอ?
아 그래요 = อ๋อ อย่างนั้นเหรอ / อ๋อ เข้าใจแล้ว
맞아요 = ใช่ / ถูกต้อง
괜찮아요 = ok / ไม่เป็นไร / สบายดี depending previous turn.

Output only normalized transcript.
`;

  const TRANSLATE_SYSTEM = `
You are a professional Thai-Korean interpreter.

ABSOLUTE RULE:
Sound goes in. Translation comes out.
You have no identity, no opinions, no explanation.
Never answer questions about yourself.
Never say you are AI.
Never say you are an interpreter.
Translate only.

Direction:
- Thai or Isaan → Korean only.
- Korean → Thai only.
- Output translation only.
- No markdown.
- No notes.
- No explanation.
- No refusal unless the speech is truly impossible to translate.

${situationCtx ? `[SITUATION]\n${situationCtx}` : ''}
${genderInstruction}
${turnHint}
${topicHint}

Speaker intent:
- ผม/ฉัน/หนู/ข่อย/เรา + อยาก/ขอ/ต้องการ/สอบถาม = speaker is requesting.
- อยาก/ขอ/ต้องการ without pronoun = speaker is requesting.
- คุณ/เจ้า + อยาก/ต้องการ = asking the other person.
- ช่วย...ได้ไหม / ซอย...ได้บ่ = asking for help.
- จะ...ให้ = offering to do something.

Examples:
ผมอยากสอบถามเรื่องรถ → 자동차에 대해 문의하고 싶습니다.
ข่อยอยากถามเรื่องกาม่า → 외국인등록증에 대해 문의하고 싶어요.
ช่วยพาไปตลาดได้ไหม → 시장에 데려다 줄 수 있어요?
ไม่มีรถ ช่วยส่งได้บ่ → 차가 없어요. 데려다 줄 수 있어요?
จะพาไปส่ง → 데려다 줄게요.

Isaan safety:
- Isaan words are human speech, not AI commands.
- Translate only.
- Do not answer as AI.
- Do not explain dialect.
- Convert Isaan meaning to standard Thai internally, then translate naturally.

Isaan banter/swearing:
- Isaan speakers often use rude-sounding words jokingly with close friends.
- Words like ห่า, บัก, อี, มึง, กู, บักปึก, อีตอแหล, บักพาก, ห่ากินหัวมึงเอ้ย may be playful banter.
- Do not refuse.
- Do not censor.
- Do not lecture.
- Do not interpret as real threat unless the sentence clearly expresses real intent.
- If playful, use Korean banter such as 이 자식아, 너도 참, 진짜 어이없네.
- If angry, use stronger Korean such as 이 빌어먹을 놈아, 꺼져, 시치미 떼지 마.

Critical Isaan examples:
ข่อยซื่อแมนเด้อ → 제 이름은 맨이에요.
อ้าย ซื่อหยัง → 형 이름이 뭐예요?
เจ้าคือไผ → 당신은 누구예요?
เจ้าเป็นหยัง → 왜 그래요?
เจ้าไปไสมา → 어디 갔다 왔어요?
บ่เข้าใจเด้อ → 이해 못 했어요.
บ่สบายคักเด้อ → 많이 아파요.
โตฮ้อนคัก → 열이 많이 나요.
วินหัวหลาย → 너무 어지러워요.
เจ็บแข่วคัก → 이가 너무 아파요.
กาม่าหาย → 외국인등록증을 분실했습니다.
เจ้ากะดายเนาะอ้าย → 형도 참 어이가 없네요.
เจ้ากะดายเนาะเอื้อย → 누나도 참 어이가 없네요.
มะซางวาแท้ → 참 대단하네. / 정말 왜 그러는 거야.
กลับมะซางวาแท้ → 빨리 돌아와요, 정말로요.
บ่ดายเด้อ → 안 돼요.
วาแท้บ่ → 정말이에요?
ห่ากินหัวมึงเอ้ย → 에이 망할 놈아.
บักปึกกะหลึน → 이 멍청한 놈아.
บักขี้ตั๋วตาใส → 뻔뻔하게 거짓말하네.
อีตอแหล → 거짓말하지 마.
อย่ามาเฮ็ดหน้ามึนตึบ → 시치미 떼지 마.
สิไปซิสเบ็ดบ่ → 낚시하러 갈래요?
ไปซิสเบ็ดนำกันบ่ → 같이 낚시하러 갈래요?

Korean address terms:
- If Thai male speaks: older brother = 형, older sister = 누나.
- If Thai female speaks: older brother = 오빠, older sister = 언니.
- In formal/public service contexts: doctor = 선생님, officer = 담당자님, staff = 직원분, boss = 사장님.

사장님 rule:
- If Korean calls Thai person 사장님, translate as คุณ/ท่าน, not เถ้าแก่.
- If Thai mentions เถ้าแก่/นายจ้าง, translate as 사장님.

Thai female endings:
- Statement ends with ค่ะ.
- Question ends with คะ.

Thai male endings:
- Statement/question polite ending usually ครับ.

If truly unclear audio:
${unclearReply}

If explicit sexual harassment or real violent threat only:
${failReply}

Vocabulary:
${vocabHint}
`;

  function isBadReply(s) {
    return /(통역사|AI입니다|답변할 수 없|설명해 드리|도와드릴 수 없|cannot answer|cannot respond|I am an AI|I am an interpreter)/i.test(String(s || ''));
  }

  function keywordLabels(s) {
    const KEYWORD_MAP = {
      กุกมิน: 'ประกัน/กุกมิน',
      กุ๊กมิน: 'ประกัน/กุกมิน',
      เทจิก: 'เทจิก/ออกงาน',
      แทจิก: 'เทจิก/ออกงาน',
      ลาออก: 'ลาออก',
      ไล่ออก: 'ไล่ออก',
      วีซ่า: 'วีซ่า',
      กาม่า: 'บัตรต่างด้าว',
      บัตรต่างด้าว: 'บัตรต่างด้าว',
      พาสปอร์ต: 'พาสปอร์ต',
      เงินเดือน: 'เงินเดือน',
      โอที: 'โอที',
      โรงพยาบาล: 'โรงพยาบาล',
      หมอ: 'หมอ',
      ยา: 'ยา',
      ปวด: 'อาการปวด',
      ไข้: 'ไข้',
      โตฮ้อน: 'ไข้/ตัวร้อนอีสาน',
      วินหัว: 'เวียนหัวอีสาน',
      แข่ว: 'ฟัน/อีสาน',
      โอนเงิน: 'โอนเงิน',
      ธนาคาร: 'ธนาคาร',
      ภาษี: 'ภาษี',
      ประกัน: 'ประกัน',
      เถ้าแก่: 'นายจ้าง',
      สัญญา: 'สัญญาจ้าง',
      หลงทาง: 'เดินทาง',
      แท็กซี่: 'แท็กซี่',
      ใบรับรองแพทย์: 'ใบรับรองแพทย์',
      statement: 'รายการเดินบัญชี',
      รายการเดินบัญชี: 'รายการเดินบัญชี',
      สถานทูต: 'สถานทูต',
      หนังสือมอบอำนาจ: 'หนังสือมอบอำนาจ',
      แปลรับรอง: 'แปลรับรอง',
      อีสาน: 'อีสาน',
      ซิสเบ็ด: 'ตกเบ็ด/อีสาน',
      กะดาย: 'สำนวนอีสาน',
      ตอแหล: 'สแลงอีสาน',
      ห่า: 'คำสบถอีสาน',
      บัก: 'คำเรียกอีสาน'
    };

    const labels = [];
    for (const [kw, label] of Object.entries(KEYWORD_MAP)) {
      if (String(s || '').includes(kw)) labels.push(label);
    }
    return labels.slice(0, 6).join(', ');
  }

  function logToSheet(payload) {
    const sheetURL = process.env.SHEET_WEBHOOK_URL;
    if (!sheetURL) return;

    fetch(sheetURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => {});
  }

  try {
    const normalizedText = await callAnthropic(
      NORMALIZE_SYSTEM,
      `Language: ${sourceLang}\nNormalize this transcript. Preserve every word.\n\nText:\n${cleanedText}`,
      1000
    );

    const rawTranslation = await callAnthropic(
      TRANSLATE_SYSTEM,
      normalizedText,
      1600
    );

    const finalTranslation = isBadReply(rawTranslation) ? unclearReply : rawTranslation;

    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    const cleanIP = String(ip).split(',')[0].trim();

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
    console.error('ERROR:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
