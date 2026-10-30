/* Shared UI language. Values in forms, business records and API payloads are never changed. */
(function(){
 'use strict';
 const key='controlLanguage',listeners=new Set(),sources=new WeakMap(),attributes=new WeakMap(),optionLabels=new WeakMap();
 let language='th';try{if(localStorage.getItem(key)==='en')language='en';}catch{}
 try{if(window.parent!==window&&window.parent.ControlLanguage)language=window.parent.ControlLanguage.get();}catch{}
 const dictionary=Object.fromEntries(`
Actual Arrival จาก ETS|Actual arrival from ETS
สถานะการตรวจ ETS|ETS lookup status
เลข BL/AWB|B/L-AWB number
เรือ/เที่ยว|Vessel / Voyage
รับเกิน|Over-receipt
สร้างรายการใหม่|Create new record
พยายามลบแต่รหัสผ่านผิด|Deletion attempt with incorrect password
แทนที่ข้อมูลทั้งชุด|Replace all records
แก้ไข (ไม่มีฟิลด์สำคัญเปลี่ยน)|Edit (no key fields changed)
และอีก|and another
ช่อง|fields
ไม่พบรายการนี้แล้ว (อาจถูกลบหรือรวมไปแล้ว)|This record was not found (it may have been deleted or merged)
ซิงค์ไม่สำเร็จ — แสดงข้อมูลชุดล่าสุดที่มีอยู่|Sync failed · Showing the last available data
ดึงข้อมูลล่าสุดไม่สำเร็จ — ยังแสดงข้อมูลชุดที่มีอยู่ กรุณาตรวจสถานะการเชื่อมต่อ Odoo|Unable to fetch current data · Showing saved data. Check the Odoo connection
ดึง Odoo ล่าสุดแล้ว แต่มี PO ที่ต้องตรวจข้อมูลซ้ำ:|Fetched current Odoo data, but these POs have duplicate identities:
ซิงค์ข้อมูลล่าสุดจาก Odoo แล้ว — นำเข้า|Synced current Odoo data · Import
รายการ · ส่งออก|items · Export
ต่างประเทศ|Overseas
(รายการใหม่)|(New record)
กรอกชื่อเรือ Voyage และรหัสท่าปลายทาง 4 หลักก่อนตรวจ ATA|Enter vessel, voyage and 4-digit destination port code before checking ATA
ตรวจ ETS ไม่สำเร็จ|ETS lookup failed
พบ ATA แล้ว — กดบันทึกเพื่อเก็บวันที่เรือถึงจริง|ATA found · Save to keep the actual arrival date
ยังไม่พบวันที่เรือถึงจริงของเที่ยวนี้ · ETA คงเดิม|No actual arrival found for this voyage · ETA retained
ETS ไม่ตอบภายในเวลาที่กำหนด กรุณาลองใหม่|ETS timed out. Please retry
ยังย้ายย้อนหลังไม่ได้ — มีหลักฐานรับ/ส่งของจาก Odoo แล้ว|Cannot move to an earlier stage · Odoo already records receipt / delivery
ย้าย|Move
เลข PO ซ้ำข้ามบริษัท/บอร์ด — รอตรวจขอบเขตก่อนบันทึก|Duplicate PO across companies / boards · Resolve its identity before saving
ข้อมูลเปลี่ยนแล้ว — ยังไม่ได้บันทึก กรุณาตรวจร่างกับข้อมูลล่าสุด|Data changed · Not saved. Compare your draft with the current record
ยังไม่ได้บันทึก — server ไม่ยืนยันผล|Not saved · Server did not confirm success
· โหลดข้อมูลล่าสุดแล้ว โปรดตรวจร่างก่อนแก้ไขอีกครั้ง|· Current data loaded. Review the draft before editing again
แยกจาก PO|Split from PO
— ชุดที่|— Lot
· จากเอกสารในโฟลเดอร์ "|· From documents in folder "
สร้าง shipment ย่อย|Create split shipment
แล้ว — กรอกมูลค่า/ค่าใช้จ่ายของล็อตนี้เอง|created · Enter the value / costs for this lot
ยังไม่ได้สร้าง shipment:|Shipment not created:
ข้อมูลเปลี่ยนแล้ว — ตรวจรายการล่าสุด แล้วปิดและเปิดคำขอลบใหม่|Data changed · Review the current record, then reopen the deletion request
ไม่ตอบใน 60 วินาที|No response within 60 seconds
ขาอากาศ|Air
ขาเรือ|Sea
กำลังโหลดต้นทุนจริงจากบิล…|Loading actual bill costs…
ยังไม่มีข้อมูลต้นทุนจริง — ต่อ Landed Cost (port 3100) ไม่ได้:|Actual costs unavailable · Cannot connect to Landed Cost (port 3100):
ไม่ทราบสาเหตุ|Unknown reason
ไม่พบบิลของ PO นี้ใน Landed Cost — กรอกเองได้ตามปกติ|No bills found for this PO in Landed Cost · Manual entry is available
⚠️ PO นี้แบ่งเป็น|⚠️ This PO is split into
ชิปเม้นในระบบต้นทุน แต่การ์ดใบนี้ยังไม่มีเลข B/L-AWB ที่ตรงกับโฟลเดอร์ไหน จึงยังแยกต้นทุนรายใบให้ไม่ได้ (ใส่เลข B/L ให้ตรงกับเอกสารแล้วจะจับคู่ได้เอง)|shipments in the cost system, but this card has no matching B/L-AWB. Enter the document B/L to match costs to this shipment
ผูกจากเลข PO|Matched by PO number
ผูกจากเลข B/L-AWB|Matched by B/L-AWB
ผูกจากชื่อเรือ|Matched by vessel name
ต้นทุนจริงจากบิล|Actual bill costs
ใบ · รวม ฿|bills · Total ฿
→ โฟลเดอร์ "|→ Folder "
ไม่ตอบใน 30 วินาที|No response within 30 seconds
เชื่อมต่อ Odoo ไม่ทันเวลา — ลองใหม่อีกครั้ง|Odoo connection timed out · Please retry
โหลดรายการบิลไม่สำเร็จ|Unable to load bills
ขาดอัตราแลกเปลี่ยน — ยังเลือกบิลนี้ไม่ได้|Exchange rate missing · This bill cannot be selected yet
ยังยืนยันบิลเดิมไม่ได้ — ต้องตรงกับบิลต้นทาง ชนิด และบริษัทของ shipment กรุณาตรวจหรือยกเลิกเลือกรายการที่ยืนยันไม่ได้|Existing bills are unverified · Source, type and shipment company must match. Review or deselect unverified bills
บริษัทของบิลไม่ตรงกับ shipment — กรุณาเลือกใหม่|Bill company does not match the shipment · Select again
ขาดอัตราแลกเปลี่ยน — ยังนำยอดมาใช้ไม่ได้|Exchange rate missing · Amount cannot be applied yet
: จับคู่|: Matched
บิลจาก Odoo|Bills from Odoo
ไม่ได้เลือกบิล|No bills selected
รอผลตรวจ ATA ก่อนบันทึก|Wait for the ATA lookup before saving
ยังไม่ได้บันทึก — สถานะต่ำกว่าหลักฐานรับ/ส่งของจาก Odoo กรุณาตรวจสถานะในร่าง|Not saved · Stage is earlier than Odoo receipt / delivery evidence. Review the draft stage
ตรวจการจัดสรรมูลค่า / FX:|Check value allocation / FX:
ขาด FX|Missing FX
ยอด PO ต้นฉบับ|Original PO value
ETA (ประมาณ)|ETA (Estimated)
วันที่รับจริง/ถึงจริง|Actual receipt / arrival date
Transit จริง (วัน)|Actual transit (days)
ผลเทียบ KPI|KPI comparison
ตรง/เร็วกว่า|On time / Earlier
ไม่พบไลบรารี Excel (vendor/xlsx.full.min.js)|Excel library not found (vendor/xlsx.full.min.js)
ไม่มีรายการให้ export|No records to export
ดาวน์โหลด Excel แล้ว (|Excel downloaded (
Import เฉลี่ยต่อออเดอร์ (฿)|Import average per order (฿)
Export เฉลี่ยต่อออเดอร์ (฿)|Export average per order (฿)
มูลค่ายังไม่ครบ / ตรวจ FX และยอดจัดสรร|Incomplete value / Check FX and allocation
สรุปรายไตรมาส|Summary by reporting period
Import รายละเอียด|Import details
Export รายละเอียด|Export details
ดาวน์โหลดรายงานสรุปแล้ว (|Summary report downloaded (
ข้อมูล ณ|Data as of
ลากไปวางคอลัมน์อื่นเพื่อปรับสถานะจริง|Drag to another column to update the stage
PO นี้แบ่งส่งเป็น|This PO has separate deliveries:
(พ.ศ.|(B.E.
รายการ — ขาด FX หรือยอดจัดสรรเกิน PO ต้นฉบับ ตรวจรายการก่อนใช้ยอดสรุปและรายงานบัญชี|items · Missing FX or allocation exceeds the original PO. Review before using totals or accounting reports
ดาวน์โหลด Excel: Import+Export ทุกรายการ + สรุปรายไตรมาส สำหรับกระทบยอดกับบัญชี|Download Excel: all imports / exports and period summaries for accounting reconciliation
น. · เช็ค|· Checks
ไม่พบความผิดปกติ — ข้อมูลสกุลเงินสอดคล้องกันทุกรายการ|No issues found · Currency data is consistent across all records
ซ่อมค่าอัตราแลกเปลี่ยนอัตโนมัติ|Automatically repaired exchange rates
รายการ — แอปแสดงถูกแล้ว แต่ควรตามไปแก้ที่ Odoo|items · Display corrected in this app; update Odoo as well
ยอดต้นฉบับตามสกุลเงินจริง ยังไม่แปลงเป็นบาท — ไว้ดูความเสี่ยงอัตราแลกเปลี่ยน (FX exposure)|Original amounts in their currencies before THB conversion, for reviewing FX exposure
เรียงตามมูลค่ารวมแปลงเป็นบาท (฿) สูงสุด 10 อันดับ|Top 10 by total value converted to THB (฿)
เทียบ scheduled_date กับวันที่ส่งจริงจาก Odoo · เฉพาะผู้ขายที่มีข้อมูลอย่างน้อย 2 ครั้ง|Compare scheduled_date with actual Odoo delivery dates · Vendors with at least 2 records
วันที่สั่งซื้อ → วันกำหนดถึงท่าล่าสุดจาก Odoo (ครอบคลุม|Order date → Latest scheduled port arrival in Odoo (covers
% ของ import PO) — ตัวเลขนี้รวมเวลา ผลิต+จองเรือ+ขนส่งทั้งหมดไว้ด้วยกัน ไม่ใช่ช่วงขนส่งอย่างเดียว (ระบบไม่มีข้อมูล ETD จริงให้แยกได้)|% of import POs). Includes production, booking and transport; actual ETD is unavailable to isolate transit time
ยังไม่มีข้อมูลเพียงพอ (ต้องมีอย่างน้อย 2 PO ต่อผู้ขาย)|Not enough data (at least 2 POs per vendor required)
เทียบมูลค่า PO ที่ Odoo ระบุว่า "invoiced" แล้ว กับยอดใบวางบิลจริงที่ผูกไว้ (สกุลเงินเดียวกันเท่านั้น) · ต่างกันเกิน 15%|Compare invoiced PO values with linked bills in the same currency · Differences above 15%
ไม่พบ PO ที่ยอดต่างจากบิลจริงเกินเกณฑ์|No POs with bill differences above the threshold
PO — Odoo ระบุว่า invoiced แล้ว แต่ใบวางบิลที่ผูกอยู่มียอด ฿0 (|POs marked invoiced in Odoo with linked bill amounts of ฿0 (
พบรูปแบบนี้ซ้ำเยอะ น่าจะเป็นเรื่องระบบ|This recurring pattern may indicate a system issue
ควรถามทีมบัญชีว่าเกิดจากอะไร)|Check the cause with accounting)
PO — ยอดบิลจริงต่างจาก PO เกิน 15% (อาจเป็นการแบ่งจ่ายบางส่วนที่ยังไม่ครบ ควรตรวจสอบ)|POs with bill amounts differing by over 15% (may involve incomplete partial payments; review required)
→ บิล|→ Bill
PO/SO ที่ค้างนาน|Aging POs / SOs
นับจากวันที่สั่งซื้อ (orderDate) ถึงวันนี้ เฉพาะรายการที่ยังไม่จบสถานะ|Days from orderDate to today for open records
เทียบ ETD → วันที่รับเข้าคลังจริง กับมาตรฐานต่อท่า|Compare ETD → Actual warehouse receipt against port-specific benchmarks
วัดได้|Measured
รายการ (ต้องมี ETD + วันที่รับจริง + มีมาตรฐานท่านั้น) · ยังไม่มีข้อมูล|items (requires ETD, actual receipt and port benchmark) · No data for
ของรายการที่วัดได้ · เป้าหมาย 80%|of measured items · Target 80%
ตัวอย่างยังน้อยเกินไปที่จะสรุปเป็น % ได้ (วัดได้|Too few samples to report a meaningful percentage (measured
แสดง 7 จาก|Showing 7 of
รายการที่มีต้นทุน ·|items with costs ·
มูลค่าแปลงเป็นบาท (฿) · แยกตามปี ETD|Value converted to THB (฿) · By ETD year
ไม่มีข้อมูลวันที่ ETD ให้จัดกลุ่มตามปี|No ETD dates available for annual grouping
เป็นปีปัจจุบัน ข้อมูลยังไม่ครบทั้งปี — เทียบกับปีก่อนหน้าโดยตรงอาจไม่สมบูรณ์|is the current year with incomplete data; direct comparisons with previous years may be misleading
ไม่มีข้อมูลวันที่ ETD ให้จัดกลุ่มตามไตรมาส|No ETD dates available for period grouping
* ไตรมาสปัจจุบันยังไม่ครบช่วงเวลา (|* The current reporting period is incomplete (
) — เทียบกับไตรมาสอื่นโดยตรงอาจไม่สมบูรณ์|) · Direct comparisons with other periods may be misleading
ต้นทุนรวมแปลงเป็นบาท (฿) หารด้วยจำนวน shipment ต่อไตรมาส|Total costs converted to THB (฿) divided by shipment count per reporting period
โหลด /lib/worklist.js ไม่สำเร็จ — กด Refresh หน้าอีกครั้ง|Unable to load /lib/worklist.js · Refresh this page
รายการ (แสดง 25 แรก เรียงจากวันล่าสุด)|items (first 25, most recent first)
การ์ด · ณ|cards · As of
ค้างสะสม — ของเก่าที่ควรสะสาง แยกออกมาเพื่อไม่ให้กลบงานของวันนี้|Backlog · Older items to resolve alongside current follow-ups
shipment — ตรวจมูลค่า/ค่าใช้จ่ายแต่ละอันไม่ให้นับซ้ำกับต้นฉบับ|shipments · Review each allocation to avoid double-counting the original PO
(จาก PO ต้นฉบับ|(From original PO
เร็วกว่ามาตรฐาน|Faster than benchmark
ล่าช้ากว่ามาตรฐาน|Slower than benchmark
· ค่ากลางของ|· Median of
— ช้ากว่า 90% ของรายการกลุ่มนี้|— Slower than 90% of this group
เอกสารของ PO นี้พบ|Documents for this PO contain
ชิปเม้น (เลข B/L ต่างกัน = คนละเที่ยวเรือ) แต่ในระบบยังไม่มีการ์ดของ|shipments (different B/L numbers indicate separate sailings), but cards are missing for
สร้างการ์ดใหม่พร้อมกรอกข้อมูลจัดส่งจากเอกสารให้อัตโนมัติ — เหลือแค่กรอกค่าใช้จ่าย|Create a card with shipping details from the documents, then enter the costs
ใส่เฉพาะสัดส่วนของล็อตนี้ ไม่ใช่มูลค่าเต็มของ PO ต้นฉบับ — ไม่งั้นยอดรวมจะนับซ้ำ|Enter only this lot's allocated value to avoid counting the full original PO twice
เร็วกว่า|Earlier
เลือกบิลจาก Odoo มาใส่ช่องนี้ — ใช้ตอนที่ระบบต้นทุนยังผูกบิลให้ไม่ได้ (เช่นบิลกรมศุลกากร)|Select Odoo bills for this field when the cost system cannot link them automatically (e.g. customs bills)
PO นี้เปิดเพื่อรับของส่วนเกินจากซัพพลายเออร์ (Over-receipt)|This PO was opened to receive excess goods from the supplier (over-receipt)
✓ ปรับสถานะเป็น|✓ Stage set to
รับเข้าคลัง|Warehouse receipt
ให้อัตโนมัติ — ของถึงจริงแล้วจึงเปิด PO นี้|automatically · This PO was opened after the goods arrived
— ลบแล้วกู้คืนไม่ได้ ต้องใส่รหัสผ่านของผู้มีอำนาจลบ|— Deletion cannot be undone. Enter an authorized deletion password
บิลจริงจากโฟลเดอร์ “|Actual bills from folder “
ใส่ตัวเลขนี้ลงช่อง|Apply this amount to field
รายการ — ยังมีบิลเก่ากว่านี้ที่ยังไม่ได้โหลด|items · Older bills have not been loaded yet
แสดงครบทุกรายการ ·|Showing all items ·
บิล/PO ย้อนหลัง|bills / POs over the past
ใช้กับ|Already used by
ยังยืนยันบิลเดิมไม่ได้|Existing bills are unverified
รายการ — ไม่พบบิลต้นทางที่ตรงทั้งเลขอ้างอิง ชนิด และบริษัทในรายการที่โหลด ร่างเดิมยังอยู่|items · No source bill matches reference, type and company. Your draft is retained
จะลงช่อง “|Apply to field “
วันที่ถึงปลายทางจริง (ถ้ามี)|Actual destination arrival date (if known)
วันที่รับเข้าคลังจริง (ถ้ามี)|Actual warehouse receipt date (if known)
ข้อมูลไม่ครบ: เลข PO ซ้ำข้ามบริษัทหรือบอร์ด (|Incomplete data: duplicate PO across companies or boards (
) — ระงับการแก้ไข ลบ ย้ายสถานะ และแยก shipment ของเลขเหล่านี้จนกว่าจะระบุขอบเขตได้|) · Edit, delete, stage changes and shipment splits are blocked until identity is resolved
กำลังโหลดข้อมูลจริงจาก Odoo — ตัวเลขที่เห็นอยู่ตอนนี้เป็นข้อมูลตัวอย่าง ยังไม่ใช่ของจริง|Loading live Odoo data · Displayed figures are sample data
ข้อมูลตัวอย่างเท่านั้น — เชื่อมต่อ Odoo ไม่ได้และไม่มีข้อมูลสำรองในเครื่อง ตัวเลขทั้งหน้านี้ไม่ใช่ของจริง ห้ามนำไปใช้ตัดสินใจหรือทำรายงาน|Sample data only · Odoo is unavailable and no saved data exists. Do not use these figures for decisions or reports
ลองเชื่อมต่ออีกครั้ง|Retry connection
ค่านี้มีอยู่ในระบบก่อนที่จะเริ่มบันทึกที่มา จึงไม่ทราบว่ามาจากเอกสารใบไหนหรือใครกรอก|This value predates source tracking; its document or author is unknown
Courier Fee  (ส่งเอกสาร/ฟอร์ม)|Courier Fee (documents / forms)
ไม่พบอัตรา USD ที่ตรงกับบริษัทของใบนี้ — กรุณาตรวจบริษัทและกรอกอัตราแลกเปลี่ยนที่ถูกต้อง|No USD rate matches this comparison's company · Check the company and enter the correct rate
ปริมาณของชิปเม้นอยู่นอกช่วงที่เสนอราคาไว้ (|Shipment quantity is outside the quoted range (
รายการ — ตรวจอัตราแลกเปลี่ยนที่มากกว่า 0, ปริมาณ และราคาตามช่วง:|items · Check positive exchange rates, quantities and tier prices:
ลบคอลัมน์ "|Delete column "
(ยังไม่ตั้งชื่อ)|(Unnamed)
เปลี่ยนแม่แบบจะเริ่มใบใหม่ — รายการที่เพิ่มเอง ราคา และขั้นบันไดที่ตั้งไว้จะหาย (ใบที่ยังไม่บันทึกกู้คืนไม่ได้) ดำเนินการต่อ?|Changing the template starts a new comparison and discards unsaved custom items, prices and tiers. Continue?
โหลดรายการที่บันทึกไม่ได้:|Unable to load saved comparisons:
ก่อนบันทึก|before saving
ลบใบเปรียบเทียบ "|Delete comparison "
" ออกจาก server?|" from the server?
ลบแล้ว|Deleted
— เก็บการแก้ไขที่ยังไม่บันทึกไว้ในใบปัจจุบัน|— Unsaved changes retained in this comparison
— ไม่มีแถวที่ตรงในแม่แบบ|— No matching template row
ไม่ได้เติม|Not applied
ไม่ตรงกับแถว|does not match the row
; กรุณาตรวจและกรอกด้วยสกุลเงินของแถว|; check and enter an amount in the row's currency
(ขั้นบันได)|(Price tiers)
รายการลง "|items into "
· ข้าม|· Skipped
ช่องที่มีค่าอยู่แล้ว|fields with existing values
· ไม่เติม|· Not applied:
รายการเพราะสกุลเงินไม่ตรง — ดูคำเตือนใต้ตาราง|items due to currency mismatches · Review the warning below the table
— ตรวจก่อนใช้|— Review before use
ตู้|containers
จาก|from
ส่ง|Shipped
รับ|Received
ครบ|Complete
เกิน|Over
แล้ว|done
อีก|Another
เลย|Overdue
บิล|Bills
ใบ|bills
ใส่|Apply
กรอก|Enter
ขั้น|tiers
เติม|Apply
ปล่อยว่าง = ไม่จำกัด · ราคา 0 = ฟรี · ถ้าปริมาณของชิปเม้นอยู่นอกทุกช่วง ระบบจะไม่คิดราคาให้และขึ้นคำเตือน แทนที่จะใช้ขั้นสุดท้ายแทนเงียบ ๆ|Blank = no limit · Price 0 = free · Quantities outside all quoted ranges remain unpriced and show a warning
ขั้นบันไดใช้กับแถวค่าระวางหลักเท่านั้น (|Price tiers apply only to the main freight row (
) แถวอื่นกรอกราคาตรง ๆ|). Enter flat prices for other rows
ถึง|To
ถึงกำหนดติดตาม|Follow-up due
· ค้าง|· Pending
ออกเรือ|Departed
กรอกชื่อเรือก่อน แล้วค่อยค้น ETS|Enter the vessel name before searching ETS
ค้น ETS ไม่สำเร็จ|ETS lookup failed
ชื่อเรือ|Vessel name
ขาด|Missing
กรอกให้ครบ ระบบจะเลื่อนสถานะให้เอง|Complete these fields to let the system advance the stage
งานถึงกำหนดวันนี้และเกินกำหนด|Follow-ups due today or overdue
ตามผู้รับผิดชอบและกำหนดเสร็จที่แอดมินระบุ|Based on the owner and due date set by the admin
ถึงภายใน|Arriving within
วัน — เตรียมเอกสารล่วงหน้า|days · Prepare documents in advance
ถึงแล้วแต่ยังไม่ได้บันทึกรับเข้าคลัง|Arrived without warehouse receipt recorded
ต้องค้นวันเรือเข้าจาก ETS|Look up the vessel arrival date in ETS
ค้นวันเรือเข้าไม่สำเร็จ|Vessel arrival lookup failed
เคยลองแล้วล้ม — มักเป็นชื่อเรือหรือเลขเที่ยวไม่ตรง|Previous lookup failed · Check vessel name and voyage
ข้อมูลขาด ระบบเลื่อนสถานะให้ไม่ได้|Missing information prevents the stage from advancing
มีเลข B/L แล้วแต่ข้อมูลหลักไม่ครบ|B/L recorded but key details are incomplete
ของเก่าค้างสะสม — ตรวจว่ารับของไปแล้วหรือยัง|Older backlog · Check whether goods have been received
ออกเรือเกิน|Departed over
วัน ยังไม่มีวันถึง|days ago with no arrival date
น่าจะถึงไปนานแล้ว — ปิดงานหรือเติมวันถึงย้อนหลัง|Possibly arrived earlier · Confirm before closing or recording the arrival
ใบนี้มีราคา|This comparison has prices in
ช่องที่อยู่เกินจำนวนคอลัมน์ (ตอนนี้มี|fields beyond the current column count (
คอลัมน์) — ตัดออกแล้วเพราะไม่มีคอลัมน์รองรับ ถ้าต้องใช้ให้เพิ่มคอลัมน์แล้วกรอกใหม่|columns). Unsupported fields were removed. Add columns and re-enter them if required
เติมจากไฟล์|Filled from file
— ยังไม่ได้ตรวจ|— Not reviewed
ยอดต่ำสุดยังเทียบกันตรงๆ ไม่ได้ — "|The lowest total is not directly comparable · "
" กรอกราคาไว้|" has prices for
รายการ ขณะที่คอลัมน์ที่ครบที่สุดกรอก|items, while the most complete column has
รายการ ยอดจึงต่ำกว่าโดยอัตโนมัติเพราะรายการที่ยังไม่กรอกไม่ถูกนับ ไม่ใช่เพราะไม่มีค่าใช้จ่าย — ขอราคาให้ครบทุกช่องก่อนตัดสินใจ · ถ้าช่องที่ว่างคือรายการที่ไม่มีค่าใช้จ่ายจริงในตัวเลือกนี้ ข้ามคำเตือนนี้ได้|items. Missing prices are excluded from the total. Obtain complete prices before deciding; ignore this warning only for confirmed free / inapplicable charges
ยังไม่มีราคาสำหรับชิปเม้นนี้ — ขั้นบันไดค่าระวางที่เสนอมาครอบคลุม|No price for this shipment · The quoted freight tiers cover
แต่ชิปเม้นนี้อยู่ที่|but this shipment has
ซึ่งอยู่นอกช่วง ต้องขอราคาเพิ่มจากผู้ให้บริการ ไม่ใช่ใช้ขั้นสุดท้ายแทน|outside the range. Request a new rate from the provider
ตั้งขั้นบันไดไว้แล้ว แต่ยังไม่ได้กรอก|Price tiers are configured, but this value is missing:
จึงยังเลือกขั้นไม่ได้|so no tier can be selected yet
กรอกน้อยกว่าคอลัมน์ที่ครบที่สุด|Fewer priced items than the most complete column by
ข้อมูลในแถวนี้จะหายและกู้คืนไม่ได้|This row's data will be permanently lost
รายชื่อผู้ให้บริการจาก Odoo ถูกตัดที่|Odoo provider list limited to
รายการ PO ในช่องแนะนำแสดง|PO suggestions show
รายการ (พิมพ์เลขเต็มได้ตามปกติ)|items (you can still type the complete reference)
รายชื่อผู้ให้บริการในช่องแนะนำแสดง|Provider suggestions show
เอกสารคิดเป็น|Document unit:
แต่แถวนี้ตั้งไว้เป็น|but this row uses
— เป็นราคาของ|— Rate applies to
ไม่ใช่|instead of
— ซ้ำแถว "|— Duplicates row "
" ใช้ค่าที่ระบุชนิดตู้ตรงกว่าแทน|"; the more specific container rate takes precedence
ไม่เติมลงคอลัมน์|Not applied to column
ตั้งขั้นบันไดค่าระวาง|Set freight price tiers
ขั้นให้คอลัมน์นี้ (|tiers for this column (
ใส่ค่าระวางต่อตู้|Apply per-container freight rate
ลงแถวค่าระวางหลัก (ถ้ายังว่าง)|to the main freight row (if empty)
— คิดตามจริง ไม่มีตัวเลข|— At actual cost; no numeric rate
ไม่ได้เติมให้|Not applied:
รายการ — ต้องดูเอง|items · Manual review required
ระบบเติม|The system fills
และทำเครื่องหมายไว้ทุกช่อง —|and marks each field ·
ราย|providers
นี้|this
ออกจากระบบ|Log out
ผู้ดูแลระบบ|Administrator
ดูข้อมูลอย่างเดียว|Read only
กำลังตรวจข้อมูล Odoo|Checking Odoo data
ข้อมูล Odoo ล่าสุด|Odoo data is up to date
ข้อมูล Odoo ยังไม่อัปเดต · กำลังใช้ข้อมูลที่บันทึกไว้|Odoo data is not current · Showing saved data
ยังตรวจการเชื่อมต่อข้อมูลไม่ได้|Unable to check the data connection
เชื่อมต่อไม่ได้ · ลองออกอีกครั้ง|Connection failed · Retry logout
สิทธิ์เชื่อมต่อหมดอายุแล้ว|Connection credentials have expired
สิทธิ์เชื่อมต่อหมดอายุใน|Connection credentials expire in
งานค้าง|Follow-ups
ทุกบริษัท|All companies
ทุกประเภท|All categories
ถึงท่าเรือ|Arrived at port
กำลังเดินพิธีการ|Customs clearance
สินค้าถึงคลัง|Received at warehouse
SO ตั้งต้น|Sales order
ผลิต / แพ็ค|Production / Packing
จองเรือ|Booking
จัดส่งแล้ว|Shipped
ถึงปลายทาง|Arrived at destination
Sea Freight (ทางเรือ)|Sea Freight
Air Freight (ทางอากาศ)|Air Freight
Courier (เอกสาร/พัสดุด่วน)|Courier (documents / parcels)
ค่าขนส่ง (Freight)|Freight
ค่าเดินพิธีการ (Clearance)|Customs clearance
ค่าประกันภัย (Insurance)|Insurance
อากรขาเข้า (Import Duty)|Import duty
ภาษีมูลค่าเพิ่ม (VAT)|VAT
อื่นๆ — ค่าท่า / ฝากเก็บ / รถในประเทศ|Other — Port / Storage / Inland transport
ร่าง (draft)|Draft
ส่ง RFQ แล้ว|RFQ sent
รออนุมัติ|Pending approval
ยืนยันแล้ว (purchase)|Confirmed (purchase)
ล็อกแล้ว (done)|Locked (done)
ยังไม่รับของ|Not received
รับบางส่วน|Partially received
รับครบแล้ว|Fully received
RFQ ร่าง|Draft RFQ
ส่ง PO แล้ว|PO sent
PO ยืนยันแล้ว|PO confirmed
ปิด PO|PO closed
รับของบางส่วน|Partially received
รับของครบ|Fully received
รับของเกินสั่ง|Over-received
รับของเกิน|Over-receipt
กำลังโหลด…|Loading…
กำลังบันทึก…|Saving…
กำลังลบ…|Deleting…
กำลังตรวจ…|Checking…
กำลังอ่าน…|Reading…
โหลดไม่สำเร็จ|Loading failed
บันทึกไม่สำเร็จ|Save failed
ลบไม่สำเร็จ|Delete failed
ยังไม่ได้บันทึก|Not saved
บันทึกแล้ว|Saved
บันทึกล่าสุด|Last saved
แก้ไขล่าสุด|Last edited
เชื่อมต่อ Odoo ไม่สำเร็จ|Odoo connection failed
เชื่อมต่อ Odoo|Connected to Odoo
ใช้ข้อมูลที่บันทึกไว้|Showing saved data
ข้อมูลไม่ครบ — เก็บบอร์ดล่าสุดที่โหลดได้|Incomplete data — Retaining the last loaded board
โหมดตัวอย่าง|Demo mode
คลิกเพื่อลองเชื่อมต่อ Odoo อีกครั้ง|Click to retry the Odoo connection
คลิกลองใหม่|Click to retry
ซิงก์สำเร็จล่าสุด|Last successful sync
สลับเป็นโหมดสว่าง|Switch to light mode
สลับเป็นโหมดมืด|Switch to dark mode
รายการต้องติดตาม|Items to follow up
ค้นหา PO, ผู้ขาย, BL, ตู้, เรือ…|Search PO, vendor, B/L, container, vessel…
มุมมองบอร์ด|Board view
มุมมองตาราง|Table view
ดาวน์โหลด Excel|Download Excel
ไม่มีรายการ|No items
ไม่มีข้อมูล|No data
ผู้ขาย/ลูกค้า|Vendor / Customer
ผู้ขาย / ลูกค้า|Vendor / Customer
PO / ผู้ขาย|PO / Vendor
มูลค่ายังไม่ครบ / ตรวจ FX|Incomplete value / Check FX
Import ทั้งหมด|Total imports
Export ทั้งหมด|Total exports
มูลค่ารวม|Total value
กำลังขนส่ง|In transit
อยู่ระหว่างทาง|On the way
รอดำเนินการ|Pending
ศุลกากร / PO ใหม่|Customs / New PO
มูลค่ายังไม่ครบ|Incomplete value
ความผิดปกติสกุลเงิน|Currency inconsistencies
PO/SO ค้างนาน|Aging POs / SOs
รับของแล้วแต่ยังไม่บันทึกค่าใช้จ่าย|Received with no costs recorded
เกินงบที่คาดการณ์ไว้ >10%|Over estimated budget by >10%
สรุปข้อยกเว้นที่ควรตรวจสอบ|Exceptions to review
Export รายงานบัญชี|Export accounting report
ต้นทุนจริง|Actual cost
เทียบคาดการณ์|Against estimate
ผลตรวจสอบข้อมูลอัตโนมัติ|Automatic data checks
ตรวจล่าสุด|Last checked
ตรวจสอบตอนนี้|Check now
ยังไม่มีผลตรวจสอบ|No check results yet
ประวัติการแก้ไขล่าสุด|Recent changes
รีเฟรช|Refresh
ยังไม่มีประวัติ|No history yet
ยังไม่มีการแก้ไขใดๆ|No changes yet
KOB เทียบ BTV|KOB vs BTV
ตามจำนวนรายการ|By item count
ตามมูลค่า|By value
สัดส่วนสกุลเงิน (ก่อนแปลงเป็นบาท)|Currency breakdown (before THB conversion)
Top ผู้ขาย/ลูกค้าตามมูลค่า|Top vendors / customers by value
Import: ผู้ขายอันดับต้น|Import: Top vendors
Export: ลูกค้าอันดับต้น|Export: Top customers
Vendor Scorecard — อัตราส่งตรงเวลา|Vendor Scorecard — On-time delivery
ยังไม่มีข้อมูลเพียงพอ|Not enough data yet
ผู้ขาย|Vendor
จำนวนครั้ง|Orders
ตรงเวลา|On time
ล่าช้าเฉลี่ย|Average delay
รอบเวลาสั่งซื้อจนคาดว่าจะถึง (PO → กำหนดถึงท่า)|Order-to-arrival lead time (PO → Estimated port arrival)
จำนวน PO|PO count
กระทบยอดกับ Odoo (GL Reconciliation)|Odoo GL reconciliation
PO ค้างเกิน 45 วัน|POs open for over 45 days
SO ค้างเกิน 30 วัน|SOs open for over 30 days
ไม่มีรายการค้างนาน|No aging items
Transit Time KPI (นำเข้า · Sea Freight)|Transit Time KPI (Import · Sea Freight)
ตรงเวลา / เร็วกว่า KPI|On time / Faster than KPI
เกินระยะเวลา KPI|Exceeds KPI transit time
ยังไม่มีข้อมูลวัด|No measurements yet
เป้าหมาย ตรงเวลา 80%|Target: 80% on time
สรุปต้นทุนนำเข้าตาม PO|Import costs by PO
มูลค่าแปลงเป็นบาท (฿)|Value converted to THB (฿)
ขนส่ง+พิธีการ+ประกัน|Freight + Clearance + Insurance
ภาษี+อากร|Tax + Duty
รวมทั้งหมด|Grand total
สัดส่วนต้นทุนตามปี — Import เทียบ Export|Annual costs — Import vs Export
เทียบต้นทุนตามไตรมาส — Import เทียบ Export|Costs by reporting period — Import vs Export
สัดส่วน Import : Export|Import : Export share
มูลค่าเฉลี่ยต่อออเดอร์ตามไตรมาส — Import เทียบ Export|Average order value by period — Import vs Export
จำนวน Shipment ตามไตรมาส — Import เทียบ Export|Shipment count by period — Import vs Export
บาท/ออเดอร์|THB / order
เปิดการ์ดนี้|Open this shipment
ผู้รับผิดชอบ:|Owner:
กำหนด:|Due:
ยังไม่กำหนด|Not set
เรื่องที่ต้องตามตอนนี้|Current follow-ups
ค้างสะสม|Backlog
ยังไม่ปิดงาน|Still open
ไม่มีเรื่องต้องตามตอนนี้|No current follow-ups
Commercial Invoice|Commercial Invoice
ใบขนขาเข้า|Import declaration
TISI (ยืนยันโดยผู้ดูแล)|TISI (confirmed by admin)
แจ้งคลังสินค้า|Notify warehouse
แจ้งชำระภาษี|Notify tax payment
จะกำหนดเมื่อบันทึก|Assigned when saved
กำหนดติดตาม|Follow-up due date
รอติดตาม|Pending follow-up
เสร็จแล้ว|Done
ยืนยันว่าไม่ต้องใช้|Confirmed not required
รายการสินค้า|Products
กำลังโหลดรายการสินค้า…|Loading products…
โหลดรายการสินค้าไม่สำเร็จ|Unable to load products
ไม่มีข้อมูลรายการสินค้า|No product data
ต้นทุนลงจอด|Landed cost
/หน่วย|/ unit
ข้อมูลขนส่ง|Shipping details
เรือ / เที่ยว|Vessel / Voyage
ETD (ออกเดินทาง)|ETD (Departure)
ATA (เรือถึงจริงจาก ETS)|ATA (Actual arrival from ETS)
วันที่ถึงปลายทางจริง|Actual destination arrival
ถึงปลายทางจริง|Arrived at destination
รับเข้าคลังจริง|Actual warehouse receipt
ไม่มีมาตรฐานอ้างอิงสำหรับท่านี้|No benchmark for this port
มาตรฐาน KPI มีเฉพาะ Sea Freight ขาเข้า|KPI benchmarks apply to sea imports only
วันรับเข้าคลังจากใบรับของใน Odoo|Warehouse receipt date from Odoo
วันที่กรอกไว้เอง|Manually entered date
ต้นทุน (บาท)|Costs (THB)
เทียบต้นทุนที่คาดการณ์ไว้|Against estimated cost
สถานะดิบจาก Odoo:|Raw Odoo status:
การรับของ:|Receipt:
ชิปเม้นที่ยังไม่มีการ์ด|Shipments without cards
สร้างการ์ดจากชิปเม้นนี้|Create card for this shipment
ไทม์ไลน์|Timeline
ท่าเรือ ต้นทาง / ปลายทาง|Ports of origin / destination
— เลือกท่าต้นทาง —|— Select origin port —
— เลือกท่าปลายทาง —|— Select destination port —
— เลือกประเภทตู้ —|— Select container type —
— เลือก Courier —|— Select courier —
จำนวนตู้คอนเทนเนอร์|Container count
บริษัทขนส่งพัสดุ (Courier)|Courier company
Ship Mode (รูปแบบขนส่ง)|Ship mode
มูลค่าสินค้า (shipment ที่แยกเอง)|Goods value (split shipment)
มูลค่าสินค้าของล็อตนี้|Goods value for this lot
ETD — วันออกเดินทาง|ETD — Departure date
ETA — Estimated Time of Arrival (วันที่คาดว่าจะถึง)|ETA — Estimated Time of Arrival
แอดมินแก้ไขตามข้อมูล Forwarder · แยกจากวันที่เรือถึงจริง|Admin may update the forwarder estimate · Separate from actual arrival
ATA — Actual Time of Arrival (วันที่เรือถึงจริงจาก ETS)|ATA — Actual Time of Arrival (from ETS)
ข้อมูลวันถึงจริง|Actual arrival details
ยังไม่พบวันที่เรือถึงจริง · ระบบไม่ใช้ Schedule แทน ATA|Actual arrival not found · Schedule is not used as ATA
ยังไม่มีผลตรวจ ATA จาก ETS|No ATA lookup result from ETS yet
รหัสท่าปลายทางสำหรับ ETS (ตรวจให้ตรงกับ B/L)|ETS destination port code (must match B/L)
รหัสท่า 4 หลัก|4-digit port code
กำลังตรวจ ATA…|Checking ATA…
ตรวจ ATA จาก ETS|Look up ATA in ETS
ค้นตามชื่อเรือ + Voyage + ท่าปลายทาง · เมื่อพบแล้วกดบันทึก|Search by vessel + voyage + destination port · Save after finding a result
วันที่ได้รับเอกสาร|Documents received date
วันที่รับเข้าคลังจริง|Actual warehouse receipt date
พิมพ์เพื่อค้นหา vendor…|Type to search vendors…
ดูบิลจริงที่ประกอบเป็นตัวเลขนี้|View the bills included in this amount
บิลจริงรวม|Total actual bills
บิลจริง|Actual bills
ใช้ตัวเลขนี้|Use this amount
ต้นทุนที่คาดการณ์ไว้ (บาท) — กรอกไว้เทียบกับต้นทุนจริงภายหลัง (ไม่บังคับ)|Estimated costs (THB) — Optional, for later comparison with actual costs
ปรับสถานะ|Change status
ธงพิเศษ / หมายเหตุ|Flags / Notes
แยกเป็น shipment ย่อยใหม่ (PO เดียวกัน ส่งคนละรอบ)|Split into a new shipment (same PO, separate delivery)
ลบ shipment ย่อยนี้ (ต้องมีรหัสผ่านผู้มีอำนาจ)|Delete this split shipment (authorized password required)
ลบ shipment ย่อย|Delete split shipment
รหัสผ่านผู้มีอำนาจลบ|Authorized deletion password
ยืนยันลบ|Confirm deletion
กำลังโหลดบิล…|Loading bills…
ไม่มีบิลในหมวดนี้|No bills in this category
เลือกบิลใส่ช่อง|Select bills for field
จาก Odoo · เลือกได้หลายใบ — ยอดรวมของบิลที่เลือกจะลงช่องนี้ช่องเดียว|From Odoo · Select multiple bills to total into this field
ค้นหา ผู้ขาย / เลขบิล / วันที่…|Search vendor / Bill number / Date…
กำลังโหลดบิลจาก Odoo… (ไม่เกิน 15 วินาที)|Loading Odoo bills… (up to 15 seconds)
ลองอีกครั้ง|Try again
ไม่พบบิล|No bills found
ที่ตรงกับคำค้น|matching the search
PO รอบิล|PO awaiting bill
จ่ายจริง|Actual payment
ขาดอัตราแลกเปลี่ยน|Missing exchange rate
รออัตราแลกเปลี่ยน|Awaiting exchange rate
ยกเลิกเลือกบิลที่ยืนยันไม่ได้|Deselect unverified bills
ใช้รายการที่เลือก|Apply selected items
ต้องติดตาม|Follow up
ETA เลยกำหนด หรือถึงภายใน 3 วัน (ยังไม่ปิดงาน)|ETA overdue or within 3 days (open shipments)
ไม่มีรายการค้างติดตาม 🎉|No pending follow-ups 🎉
ถึงวันนี้|Arriving today
ถึงปลายทางแล้ว|Arrived at destination
รับเข้าคลังแล้ว|Received at warehouse
แก้ ETA / สถานะ|Edit ETA / Status
เพิ่มรายการส่งออก|Add export shipment
เพิ่มรายการนำเข้า|Add import shipment
ประเภทรายการ|Shipment type
Import (นำเข้า)|Import
Export (ส่งออก)|Export
เลขที่ PO / SO|PO / SO number
ประเภทสินค้า|Goods category
ชื่อบริษัทคู่ค้า|Partner company name
ตัวแทนขนส่ง (Forwarder)|Freight forwarder
ท่าต้นทาง (Port of Origin)|Port of origin
ท่าปลายทาง (Port of Destination)|Port of destination
ชื่อเรือ (Vessel)|Vessel name
เที่ยว (Voyage)|Voyage
ETA (ถึงปลายทาง ประมาณ)|ETA (Estimated destination arrival)
จากเอกสาร|From document
กรอกเอง|Manual entry
จากการสแกน|From scan
ที่มา:|Source:
ไม่ทราบที่มา|Unknown source
หมายเหตุเพิ่มเติม เช่น อ้างอิง PO ต้นทาง, เหตุผลที่ของเกิน…|Additional notes, e.g. original PO reference or reason for excess receipt…
เปรียบเทียบค่าระวางและค่าใช้จ่ายนำเข้า-ส่งออกจากผู้ให้บริการหลายราย — บันทึกใบเปรียบเทียบไว้บน server|Compare import/export freight and charges from multiple providers · Save comparisons on the server
ติดตาม Import PO / Export SO จาก Odoo พร้อมบันทึก forwarder / BL-AWB / container และต้นทุนเอง|Track import POs / export SOs from Odoo with forwarder, B/L-AWB, container and costs
คำนวณการจัดเรียงสินค้าลงตู้คอนเทนเนอร์|Calculate cargo loading into containers
เรื่องที่ต้องตามวันนี้ แยกจากของค้างสะสม — คิดจากข้อมูลจริงในระบบ ไม่ได้เดา|Today's follow-ups and backlog, based on recorded shipment data
แม่แบบ|Template
Import · ทางเรือ|Import · Sea
Import · ทางอากาศ|Import · Air
Export · ทางเรือ|Export · Sea
— ใบเปรียบเทียบที่บันทึกไว้ —|— Saved comparisons —
ใบเปรียบเทียบที่บันทึกไว้|Saved comparisons
+ ใบใหม่|+ New comparison
ทำสำเนา|Duplicate
ส่งออก Excel|Export Excel
พิมพ์ / PDF|Print / PDF
อ่านจาก PDF|Read from PDF
+ เพิ่มคอลัมน์ตัวเลือก|+ Add option column
วางไฟล์ PDF ใบเสนอราคาที่นี่|Drop a PDF quotation here
— ช่องพื้นเหลือง = กรอกราคาต่อหน่วย · ว่าง = ไม่มีค่าใช้จ่ายรายการนั้น|— Yellow cells: unit prices · Blank: no charge for this item
วันที่จัดทำ|Prepared date
รหัสใบเปรียบเทียบ|Comparison reference
อัตรา USD|USD exchange rate
ชื่อผู้ขาย / ผู้รับ|Vendor / Consignee name
จำนวนหน่วยสินค้า|Product units
ชื่อ Freight Forwarder|Freight forwarder name
ดึงอัตราล่าสุดจาก Odoo|Fetch latest Odoo rate
ลบคอลัมน์นี้|Delete this column
เพิ่มรายการในหมวดนี้|Add item to this section
ลบรายการที่เพิ่มเอง|Delete custom item
น้ำหนักคิดเงิน (ว่าง = max(GW,VW))|Chargeable weight (blank = max(GW,VW))
ถูกที่สุด|Lowest cost
ต่ำสุด · ยังกรอกไม่ครบ|Lowest · Incomplete prices
นอกช่วง|Out of range
รอปริมาณ|Awaiting quantity
ราคาตามขั้นบันไดที่ตรงกับปริมาณ|Tier price for this quantity
ขั้น · แก้ไข|tiers · Edit
+ ขั้นบันได|+ Price tiers
ตัวเลือก|Option
ยังคำนวณไม่ได้|Cannot calculate yet
ยังแนะนำผู้ให้บริการที่ถูกที่สุดไม่ได้|Cannot recommend the lowest-cost provider yet
ยังไม่กรอกราคา|No prices entered
ประหยัดกว่าถัดไป|Savings vs next option
● ยังไม่บันทึก|● Unsaved
ใบใหม่ (ยังไม่บันทึก)|New comparison (unsaved)
(ไม่มีเลขอ้างอิง)|(No reference)
สิทธิ์ดูข้อมูล — คำนวณและส่งออกได้|Read-only access · Calculate and export available
เติมข้อมูลจาก PO|Fill from PO
คำเตือน — อ่านก่อนใช้ตัวเลขนี้ตัดสินใจ|Warning — Review before using these figures
ไม่จำกัด|No limit
0 = ฟรี|0 = free
ลบขั้นนี้|Delete this tier
ตั้งแต่|From
ราคาต่อหน่วย|Unit price
ขั้นบันไดค่าระวาง|Freight price tiers
ตั้งขั้นบันได|Set price tiers
ไม่มีขั้นบันได — กลับไปกรอกราคาตรง ๆ|No tiers · Enter a flat price instead
+ เพิ่มขั้น|+ Add tier
ลบขั้นบันไดทั้งหมด|Delete all tiers
ใช้ค่านี้|Apply
รองรับเฉพาะไฟล์ PDF|Only PDF files are supported
ไฟล์ใหญ่เกิน 6MB|File exceeds 6MB
อ่านไฟล์นี้ไม่ออก (น่าจะเป็นไฟล์สแกน) — ต้องกรอกเอง|Unable to read this file (possibly scanned) · Enter manually
อ่านไฟล์ไม่สำเร็จ|Unable to read file
ผู้ให้บริการ|Provider
ใช้ได้ถึง|Valid until
เทอม|Terms
หน่วยไม่ตรง|Unit mismatch
ปานกลาง|Medium
ต่ำ|Low
มั่นใจ|Confidence
ตรวจผลอ่านไฟล์|Review extracted data
ไม่พบข้อมูลหัวเอกสาร|No document header data found
ไม่มีตัวเลข|No numeric value
เติมลงคอลัมน์|Fill into column
รายการในเอกสาร|Document item
จะลงแถว|Target row
ไม่มีรายการที่แมปเข้าแม่แบบได้เลย|No items match this template
เงื่อนไขในเอกสาร (ไม่ได้รวมในราคา)|Document terms (not included in prices)
เฉพาะช่องที่ยังว่าง|Only empty fields
ค่าระวางหลักเป็นส่วนที่อ่านพลาดบ่อยที่สุด|Main freight rates are particularly prone to extraction errors
ให้ตรวจกับเอกสารก่อนใช้ตัดสินใจเสมอ|Always check against the document before making a decision
เติมลงตาราง|Apply to table
รายการที่จะเติม|items to apply
ใบปัจจุบันยังไม่บันทึก เริ่มใบใหม่?|This comparison has unsaved changes. Start a new one?
ใบปัจจุบันยังไม่บันทึก เปิดใบอื่นแทน?|This comparison has unsaved changes. Open another one?
ทำสำเนาแล้ว — แก้เลขอ้างอิงแล้วบันทึก|Duplicated · Change the reference and save
สูงสุด 6 คอลัมน์|Maximum 6 columns
กรุณารอการบันทึกหรือลบใบนี้ให้เสร็จก่อนเปิดอีกครั้ง|Wait for this comparison to finish saving or deleting before reopening
เปรียบเทียบค่าระวางและค่าใช้จ่ายนำเข้า-ส่งออกจากผู้ให้บริการหลายราย — สูตรเดียวกับไฟล์ Import / Export Charges Comparison.xlsx|Compare import/export freight and charges from multiple providers · Based on Import / Export Charges Comparison.xlsx
กำหนดถึง|Estimated arrival
เรือถึงจริงเมื่อ|Vessel actually arrived on
เรือถึงในอีก|Vessel arriving in
บันทึกรับเข้าคลัง หรือปรับสถานะให้ตรง|Record warehouse receipt or update the status
เตรียมเอกสารเดินพิธีการ|Prepare customs clearance documents
ค้นวันเรือเข้าจาก ETS|Look up vessel arrival in ETS
ตรวจชื่อเรือ/เที่ยว แล้วค้นใหม่|Check vessel / voyage and search again
ตรวจเอกสารและประสานงานตาม checklist ของ Shipment|Review documents and follow the shipment checklist
วันก่อน|days ago
ยังไม่รู้วันถึง|Arrival date unknown
เรือใกล้ถึง|Vessel arriving soon
เรือถึงแล้ว ยังไม่ปิดงาน|Vessel arrived, shipment still open
ออกเรือแล้ว ยังไม่รู้วันถึง|Departed, arrival date unknown
กำหนดติดตามเอกสาร|Document follow-up due
ยังไม่ครบ / ตรวจ FX|Incomplete / Check FX
ม.ค.|Jan
ก.พ.|Feb
มี.ค.|Mar
เม.ย.|Apr
พ.ค.|May
มิ.ย.|Jun
ก.ค.|Jul
ส.ค.|Aug
ก.ย.|Sep
ต.ค.|Oct
พ.ย.|Nov
ธ.ค.|Dec
สกุลเงิน|Currency
อัตราแลกเปลี่ยน|Exchange rate
มูลค่าสินค้า|Goods value
ค่าขนส่ง|Freight
ค่าเดินพิธีการ|Clearance charges
ค่าพิธีการ|Clearance charges
พิธีการ|Clearance
ค่าประกันภัย|Insurance
ประกันภัย|Insurance
อากรขาเข้า|Import duty
ภาษีมูลค่าเพิ่ม|VAT
อากร|Duty
ต้นทุนรวม|Total cost
ค่าใช้จ่ายอื่นๆ|Other charges
ค่าใช้จ่าย|Charges
ต้นทุนที่คาดการณ์ไว้|Estimated cost
ท่าเรือต้นทาง|Port of origin
ท่าเรือปลายทาง|Port of destination
ท่าต้นทาง|Origin port
ท่าปลายทาง|Destination port
ปลายทาง|Destination
ต้นทาง|Origin
เลขเที่ยวเรือ|Voyage number
ตู้คอนเทนเนอร์|Container
ตัวแทนขนส่ง|Forwarder
บริษัทขนส่ง|Carrier
คู่ค้า|Partner
หมายเหตุ|Notes
อื่นๆ|Other
จำนวนตู้|Container count
จำนวนครั้ง|Count
จำนวน|Quantity
มูลค่า|Value
สถานะ|Status
ประเภท|Category
บริษัท|Company
ชิปเม้น|Shipments
ไตรมาส|Reporting period
รายการ|items
บรรทัด|lines
ทั้งหมด|All
เลือก|Select
ยกเลิก|Cancel
บันทึก|Save
แก้ไข|Edit
เพิ่มรายการ|Add item
ลบ|Delete
ปิด|Close
เสร็จสิ้น|Complete
ไม่ระบุ|Not specified
ไม่พบ|Not found
สำเร็จ|Successful
ครบแล้ว|Complete
บางส่วน|Partial
ล่าช้า|Delayed
มาตรฐาน|Benchmark
เฉลี่ย|Average
น้ำหนัก|Weight
หน่วย|Unit
ราคา|Price
วันที่|Date
วัน|days
เดือน|months
ปี|Year
บาท|THB
กก.|kg
ลบ.ม.|m³
เรือ|Vessel
รวม|Total
แสดง|Showing
เช่น|e.g.
จากทั้งหมด|of
น.| 
`.trim().split('\n').map(line=>{const at=line.indexOf('|');return[line.slice(0,at).replace(/\s+/g,' ').trim(),line.slice(at+1)];}));
 let pattern;
 function buildPattern(){const keys=Object.keys(dictionary).filter(k=>k&&k!==dictionary[k]).sort((a,b)=>b.length-a.length);pattern=new RegExp(keys.map(k=>k.split(' ').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s+')).join('|'),'g');}
 buildPattern();
 function text(value){return language==='en'?String(value).replace(pattern,match=>dictionary[match.replace(/\s+/g,' ')]):String(value);}
 function excluded(el){return !el||!!el.closest('script,style,[contenteditable="true"],[translate="no"],[data-control-language]');}
 function translateOption(option){
  const current=option.getAttribute('label'),old=optionLabels.get(option),owned=old&&current===old.output;
  const implicit=owned?old.implicit:current===null;
  const source=implicit?option.textContent:(owned?old.source:current);
  const output=language==='th'&&implicit?null:text(source);
  optionLabels.set(option,{implicit,source,output});
  // The label is presentation only; textContent/value continue to belong to the app.
  if(output===null){if(current!==null)option.removeAttribute('label');}
  else if(current!==output)option.setAttribute('label',output);
 }
 function translateNode(node){
  if(node.nodeType===3){if(excluded(node.parentElement)||node.parentElement.closest('input,textarea'))return;if(node.parentElement.tagName==='OPTION'){translateOption(node.parentElement);return;}const current=node.nodeValue,old=sources.get(node),source=old&&current===old.output?old.source:current,output=text(source);sources.set(node,{source,output});if(current!==output)node.nodeValue=output;return;}
  if(node.nodeType!==1||excluded(node))return;
  if(node.tagName==='OPTION'){translateOption(node);return;}
  for(const name of ['placeholder','title','aria-label','label'])if(node.hasAttribute(name)){
   let saved=attributes.get(node);if(!saved){saved={};attributes.set(node,saved);}
   const current=node.getAttribute(name),old=saved[name],source=old&&current===old.output?old.source:current,output=text(source);saved[name]={source,output};if(current!==output)node.setAttribute(name,output);
  }
  if(node.tagName!=='INPUT'&&node.tagName!=='TEXTAREA')for(const child of node.childNodes)translateNode(child);
 }
 function apply(){document.documentElement.lang=language;if(document.body)translateNode(document.body);}
 function set(value,persist=true){
  if(value!=='th'&&value!=='en')return;
  const changed=language!==value;language=value;
  if(persist)try{localStorage.setItem(key,value);}catch{}
  if(changed){listeners.forEach(fn=>fn(value));apply();window.dispatchEvent(new CustomEvent('control-language-change',{detail:value}));}
  try{if(window.parent!==window&&window.parent.ControlLanguage&&window.parent.ControlLanguage.get()!==value)window.parent.ControlLanguage.set(value,persist);}catch{}
  document.querySelectorAll('iframe').forEach(frame=>{try{const api=frame.contentWindow.ControlLanguage;if(api&&api.get()!==value)api.set(value,false);}catch{}});
 }
 window.ControlLanguage={get:()=>language,set,text,refresh:apply,addDictionary(th,en){for(const name of Object.keys(th))if(typeof th[name]==='string'&&typeof en[name]==='string')dictionary[th[name].replace(/\s+/g,' ').trim()]=en[name];buildPattern();},register(fn){listeners.add(fn);fn(language);return()=>listeners.delete(fn);}};
 window.addEventListener('storage',event=>{if(event.key===key)set(event.newValue==='en'?'en':'th',false);});
 function start(){apply();new MutationObserver(records=>{for(const record of records){if(record.type==='childList')record.addedNodes.forEach(translateNode);else translateNode(record.target);}}).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['placeholder','title','aria-label','label']});}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
 // Native dialogs use the same language as visible controls, without changing their return values.
 for(const name of ['alert','confirm','prompt']){const native=window[name];if(typeof native==='function')window[name]=function(message,...args){return native.call(window,text(message),...args);};}
})();
