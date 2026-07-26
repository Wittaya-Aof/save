// ─── Worker แยก process สำหรับดึงข้อความจาก PDF ────────────────────────────────────────
// รันแยก process ต่อไฟล์โดยตั้งใจ — pdf-parse (pdfjs-dist) มี resource leak สะสมข้ามการเรียก
// ที่ .destroy() เคลียร์ไม่หมด (ยืนยันแล้ว 2026-07-22: สแกนไฟล์สะสมไปเรื่อยๆ ในกระบวนการเดียวกัน
// จะค้างสนิทหลังจากไฟล์ที่ราวๆ 50-100+ แม้แต่ละไฟล์แยกทดสอบเดี่ยวๆ ไม่เคยค้างเลย) แยก process
// ต่อไฟล์ทำให้ parent (scan-shipment-docs.mjs) ยิง SIGKILL ทิ้งได้ถ้าค้างเกิน timeout โดยไม่กระทบ
// ไฟล์อื่นๆ ที่เหลือเลย — เขียนผลเป็น JSON บรรทัดเดียวออก stdout
'use strict';
const fs = require('fs');

// เขียน stdout แล้วรอให้ flush จริงก่อน exit — process.exit() ทันทีอาจตัด stdout ที่ pipe ยังไม่ flush
// (ข้อความยาวถึง 50MB) ทำให้ parent ได้ JSON ไม่ครบ → JSON.parse ล้ม → ไฟล์ถูกตีเป็น error เป็นครั้งคราว
function writeAndExit(obj) {
  process.exitCode = 0;
  process.stdout.write(JSON.stringify(obj), () => { /* flush เสร็จแล้ว ปล่อย event loop จบเอง */ });
}

(async () => {
  const filePath = process.argv[2];
  try {
    const { PDFParse } = require('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buffer });
    try {
      const parsed = await parser.getText();
      writeAndExit({ ok: true, text: parsed.text || '' });
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch (e) {
    writeAndExit({ ok: false, error: e.message });
  }
})();
