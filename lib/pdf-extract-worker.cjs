// ─── Worker แยก process สำหรับดึงข้อความจาก PDF ────────────────────────────────────────
// รันแยก process ต่อไฟล์โดยตั้งใจ — pdf-parse (pdfjs-dist) มี resource leak สะสมข้ามการเรียก
// ที่ .destroy() เคลียร์ไม่หมด (ยืนยันแล้ว 2026-07-22: สแกนไฟล์สะสมไปเรื่อยๆ ในกระบวนการเดียวกัน
// จะค้างสนิทหลังจากไฟล์ที่ราวๆ 50-100+ แม้แต่ละไฟล์แยกทดสอบเดี่ยวๆ ไม่เคยค้างเลย) แยก process
// ต่อไฟล์ทำให้ parent (scan-shipment-docs.mjs) ยิง SIGKILL ทิ้งได้ถ้าค้างเกิน timeout โดยไม่กระทบ
// ไฟล์อื่นๆ ที่เหลือเลย — เขียนผลเป็น JSON บรรทัดเดียวออก stdout
'use strict';
const fs = require('fs');

(async () => {
  const filePath = process.argv[2];
  try {
    const { PDFParse } = require('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buffer });
    try {
      const parsed = await parser.getText();
      process.stdout.write(JSON.stringify({ ok: true, text: parsed.text || '' }));
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }));
  }
  process.exit(0);
})();
