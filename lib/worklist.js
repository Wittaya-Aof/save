/* ─── งานค้าง: แปลง tracking_data เป็น "วันนี้ต้องทำอะไร" ────────────────────────────
 * ใช้ร่วมกันสองที่: หน้าเว็บโหลดเป็น <script src>, เทสใน node เรียกผ่าน require()
 * จึงต้องเป็น **ฟังก์ชันบริสุทธิ์** ไม่แตะ DOM ไม่แตะ network ไม่อ่านนาฬิกาเอง (รับ today เข้ามา)
 *
 * ⚠ เกณฑ์ทุกตัวมาจากการวัดข้อมูลจริง 1,080 record (2026-09-22) ไม่ได้ตั้งลอยๆ:
 *   · การ์ดที่ยังไม่มีเลข B/L มี 829 ใบ แต่ **มี ETD แค่ 2 ใบ** → ส่วนใหญ่คือ PO ที่ยังไม่ได้ส่งของ
 *     ไม่ใช่งานค้าง จึง**ไม่เอาเข้าถังงาน**เลย (ถ้าเอาเข้า มันจะกลบงานจริงทั้งหมด)
 *   · "เรือถึงแล้วยังไม่บันทึกรับเข้าคลัง" มี 156 ใบ แต่ 138 ใบถึงมาเกิน 60 วันแล้ว
 *     → แยกเป็น "งานตอนนี้" กับ "ค้างสะสม" คนละถัง ไม่งั้นงานของวันนี้จมหาย
 *
 * ปรัชญา: ถ้าไม่มีปัญหา ไม่ต้องรบกวน · ถ้ามีปัญหา ต้องบอกด้วยว่าทำอะไรต่อ
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Worklist = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // เกณฑ์แบ่ง "งานตอนนี้" กับ "ค้างสะสม" — ปรับได้ที่เดียว
  var DAYS = {
    arrivingSoon: 3,     // เรือถึงภายในกี่วันถือว่าใกล้ถึง
    arrivedFresh: 60,    // ถึงแล้วไม่เกินกี่วันยังถือว่าเป็นงานที่ตามได้
    etdFresh: 90,        // ออกเรือมาไม่เกินกี่วันยังถือว่าตามเรือทัน
  };

  function ymd(v) { return String(v == null ? '' : v).slice(0, 10); }
  function isDate(v) {
    var s = ymd(v);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  // จำนวนวันจากวันนี้ (ลบ = ผ่านมาแล้ว) · คืน null เมื่อวันที่ใช้ไม่ได้ — ไม่เดา
  function dayDiff(v, today) {
    if (!isDate(v) || !isDate(today)) return null;
    return Math.round((new Date(ymd(v) + 'T00:00:00Z') - new Date(ymd(today) + 'T00:00:00Z')) / 86400000);
  }
  function has(v) { return v !== undefined && v !== null && String(v).trim() !== ''; }

  function blOf(r) { return r.bl_awb || r.bl || ''; }
  // วันเรือถึง: ของจริงจาก ETS ชนะกำหนดการเสมอ — และต้องรู้ว่าใช้ตัวไหนอยู่
  function arrivalOf(r) {
    if (has(r.etsActualArrivalDate)) return { date: r.etsActualArrivalDate, actual: true };
    if (has(r.eta)) return { date: r.eta, actual: false };
    return null;
  }
  function isOpen(r) { return (r._board || 'import') !== 'export' && r.stage !== 'received'; }

  function item(r, why, next, when) {
    return {
      po: r.po_so || r.id || '?',
      party: r.party && r.party !== '—' ? r.party : '',
      vessel: r.vessel || '', forwarder: r.forwarder || '',
      bl: blOf(r), stage: r.stage || '',
      why: why, next: next, when: when,
    };
  }

  /* records = tracking_data.json ทั้งก้อน · today = 'YYYY-MM-DD'
     คืน { now:[ถัง...], backlog:[ถัง...], counts:{}, asOf }
     ทุกถัง = {key,title,hint,items[]} เรียงจากงานที่ต้องทำก่อน */
  function buildWorklist(records, today) {
    var rows = Array.isArray(records) ? records : [];
    var open = rows.filter(isOpen);

    var arrivedNow = [], arrivedOld = [], soon = [], noEta = [], noEtaOld = [], etsBad = [], incomplete = [];

    open.forEach(function (r) {
      var a = arrivalOf(r);
      if (a) {
        var dd = dayDiff(a.date, today);
        if (dd != null && dd <= 0) {
          var age = -dd;
          var why = (a.actual ? 'เรือถึงจริงเมื่อ ' : 'กำหนดถึง ') + ymd(a.date) + ' (' + age + ' วันก่อน)';
          var it = item(r, why, 'บันทึกรับเข้าคลัง หรือปรับสถานะให้ตรง', a.date);
          if (age <= DAYS.arrivedFresh) arrivedNow.push(it); else arrivedOld.push(it);
          return;
        }
        if (dd != null && dd > 0 && dd <= DAYS.arrivingSoon) {
          soon.push(item(r, 'เรือถึงในอีก ' + dd + ' วัน (' + ymd(a.date) + ')', 'เตรียมเอกสารเดินพิธีการ', a.date));
          return;
        }
        return;   // มีวันถึงในอนาคตไกล = ยังไม่ต้องทำอะไร
      }
      // ไม่มีวันถึงเลย แต่ออกเรือไปแล้ว = ต้องตามว่าเรือถึงเมื่อไหร่
      var de = dayDiff(r.etd, today);
      if (de != null && de < 0) {
        var it2 = item(r, 'ออกเรือ ' + ymd(r.etd) + ' (' + (-de) + ' วันก่อน) แต่ยังไม่รู้วันถึง',
                       has(r.vessel) ? 'ค้นวันเรือเข้าจาก ETS' : 'กรอกชื่อเรือก่อน แล้วค่อยค้น ETS', r.etd);
        if (-de <= DAYS.etdFresh) noEta.push(it2); else noEtaOld.push(it2);
      }
    });

    // ค้น ETS แล้วไม่สำเร็จ — ต่างจาก "ยังไม่เคยค้น" ตรงที่เคยลองแล้วและล้ม
    rows.filter(function (r) { return (r._board || 'import') !== 'export'; }).forEach(function (r) {
      if (r.etsStatus === 'error' || r.etsStatus === 'not_found') {
        etsBad.push(item(r, 'ค้น ETS ไม่สำเร็จ' + (has(r.etsReason) ? ' — ' + r.etsReason : ''),
                         'ตรวจชื่อเรือ/เที่ยว แล้วค้นใหม่', r.etsCheckedAt || ''));
      }
    });

    // มีเลข B/L แล้ว = ของออกเดินทางแน่นอน แต่ข้อมูลหลักยังขาด ระบบจึงเลื่อนสถานะให้ไม่ได้
    open.forEach(function (r) {
      if (!has(blOf(r))) return;
      var miss = [];
      if (!has(r.vessel)) miss.push('ชื่อเรือ');
      if (!has(r.etd)) miss.push('ETD');
      if (!has(r.origin)) miss.push('ท่าต้นทาง');
      if (!has(r.dest)) miss.push('ท่าปลายทาง');
      if (miss.length) incomplete.push(item(r, 'ขาด ' + miss.join(' · '), 'กรอกให้ครบ ระบบจะเลื่อนสถานะให้เอง', r.etd || ''));
    });

    var byWhen = function (a, b) { return String(b.when || '').localeCompare(String(a.when || '')); };
    [arrivedNow, arrivedOld, soon, noEta, noEtaOld, etsBad, incomplete].forEach(function (l) { l.sort(byWhen); });

    var bucket = function (key, title, hint, items) { return { key: key, title: title, hint: hint, items: items }; };
    var now = [
      bucket('soon', 'เรือใกล้ถึง', 'ถึงภายใน ' + DAYS.arrivingSoon + ' วัน — เตรียมเอกสารล่วงหน้า', soon),
      bucket('arrived', 'เรือถึงแล้ว ยังไม่ปิดงาน', 'ถึงแล้วแต่ยังไม่ได้บันทึกรับเข้าคลัง', arrivedNow),
      bucket('noeta', 'ออกเรือแล้ว ยังไม่รู้วันถึง', 'ต้องค้นวันเรือเข้าจาก ETS', noEta),
      bucket('etsbad', 'ค้นวันเรือเข้าไม่สำเร็จ', 'เคยลองแล้วล้ม — มักเป็นชื่อเรือหรือเลขเที่ยวไม่ตรง', etsBad),
      bucket('incomplete', 'ข้อมูลขาด ระบบเลื่อนสถานะให้ไม่ได้', 'มีเลข B/L แล้วแต่ข้อมูลหลักไม่ครบ', incomplete),
    ].filter(function (b) { return b.items.length; });

    var backlog = [
      bucket('arrived_old', 'ถึงเกิน ' + DAYS.arrivedFresh + ' วัน ยังไม่ปิดงาน', 'ของเก่าค้างสะสม — ตรวจว่ารับของไปแล้วหรือยัง', arrivedOld),
      bucket('noeta_old', 'ออกเรือเกิน ' + DAYS.etdFresh + ' วัน ยังไม่มีวันถึง', 'น่าจะถึงไปนานแล้ว — ปิดงานหรือเติมวันถึงย้อนหลัง', noEtaOld),
    ].filter(function (b) { return b.items.length; });

    var n = function (l) { return l.reduce(function (s, b) { return s + b.items.length; }, 0); };
    return {
      asOf: ymd(today), now: now, backlog: backlog,
      counts: { now: n(now), backlog: n(backlog), open: open.length, total: rows.length },
    };
  }

  return { buildWorklist: buildWorklist, DAYS: DAYS, _dayDiff: dayDiff, _arrivalOf: arrivalOf };
});
