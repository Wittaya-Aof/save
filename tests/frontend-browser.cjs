// Isolated fixture server only. Never connects to an existing application port.
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');let role='viewer',failWrite=false,ambiguous=false,posts=[],gets=[];
const record={po_so:'FIXTURE-PO',_board:'import',_ts:100,_shipmentId:'SHIP-FIXTURE',owner:'Fixture Owner',dueDate:new Date(Date.now()-86400000).toISOString().slice(0,10),poRefs:[{poNumber:'FIXTURE-PO',companyId:2,odooOrderId:123}],documentChecklist:{tisi_permit:'pending'}};
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://fixture');
  if(u.pathname.startsWith('/api/')){
    if(req.method==='GET')gets.push(u);
    res.setHeader('Content-Type','application/json');let j={ok:true,rows:[]};
    if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;posts.push({url:u.pathname,body:JSON.parse(body||'{}')});j=failWrite?{ok:false,error:'Fixture disk failure'}:{ok:true,rows:[{...record,_ts:101}],row:{updatedAt:'2026-10-16T00:00:01.000Z'}};}
    else if(u.pathname==='/api/me')j={ok:true,role,canWrite:role==='admin',user:'fixture'};
    else if(u.pathname==='/api/tracking')j={ok:true,rows:ambiguous?[{...record,company:'BTV'},{...record,company:'KOB',_shipmentId:'OTHER-SHIP',_ts:200}]:[record]};
    else if(u.pathname==='/api/import-pos')j={ok:true,rows:[{id:123,company_id:2,company_code:'BTV',po_number:'FIXTURE-PO',supplier:'Fixture Supplier',currency:'THB',currency_rate:1,odoo_state:'purchase',amount_total:1000}]};
    else if(u.pathname==='/api/landed-cost')j={unavailable:true,reason:'Fixture'};
    else if(u.pathname==='/api/shipment-runs')j={ok:true,runs:[]};
    else if(u.pathname==='/api/logistics-bills')j={ok:true,bills:[{id:7,bill:'BILL-KNOWN',partner:'Known supplier',amount:55,category:'freight'},{id:8,bill:'REFUND',partner:'Refund supplier',amount:-20,category:'freight'},{id:9,bill:'BILL-MISSING-FX',partner:'Foreign supplier',amount:null,origAmount:12,currency:'USD',fxRate:null,fxStatus:'missing'}]};
    res.end(JSON.stringify(j));return;
  }
  const p=path.resolve(root,'.'+decodeURIComponent(u.pathname));if(!p.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{res.setHeader('Content-Type',p.endsWith('.html')?'text/html; charset=utf-8':p.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(p));}catch(e){res.writeHead(404);res.end();}
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;const browser=await chromium.launch();const errors=[];
try{
  for(const currentRole of ['viewer','admin']){
    role=currentRole;const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.route('https://**/*',r=>r.abort());
    await page.goto(base+'/import-export-os.html');await page.getByText('FIXTURE-PO',{exact:true}).first().waitFor();await page.getByText('FIXTURE-PO',{exact:true}).first().click();await page.getByText('Shipment ID: SHIP-FIXTURE',{exact:false}).waitFor();
    assert.equal(await page.getByRole('button',{name:'แก้ไข',exact:true}).count(),currentRole==='admin'?1:0);
    assert.equal(await page.locator('[draggable="true"]').count()>0,currentRole==='admin');
    if(currentRole==='viewer'){
      await page.getByRole('button',{name:'ปิด',exact:true}).first().click();await page.getByRole('button',{name:'งานค้าง',exact:true}).click();
      await page.getByText('ผู้รับผิดชอบ: Fixture Owner · กำหนด: '+record.dueDate,{exact:true}).first().waitFor();
    }
    if(currentRole==='admin'){
      await page.getByRole('button',{name:'แก้ไข',exact:true}).click();await page.getByLabel('ผู้รับผิดชอบ').fill('Edited Owner');failWrite=true;
      await page.locator('button[title^="เลือกบิลจาก Odoo"]').first().click();await page.getByText('ขาดอัตราแลกเปลี่ยน',{exact:true}).waitFor();await page.getByText('BILL-MISSING-FX',{exact:true}).click();await page.getByText('ขาดอัตราแลกเปลี่ยน — ยังเลือกบิลนี้ไม่ได้',{exact:true}).waitFor();
      await page.getByText('BILL-KNOWN',{exact:true}).click();await page.getByText('REFUND',{exact:true}).click();await page.getByRole('button',{name:'ใช้รายการที่เลือก (฿35)',exact:true}).click();
      await page.getByRole('button',{name:'บันทึก',exact:true}).click();await page.getByText('ยังไม่ได้บันทึก: Fixture disk failure',{exact:false}).waitFor();assert.equal(await page.getByLabel('ผู้รับผิดชอบ').inputValue(),'Edited Owner');assert.equal(posts.at(-1).body._baseTs,100);failWrite=false;
      assert.equal(posts.at(-1).body.freight,35);assert.equal(posts.at(-1).body.bills.length,2);assert.equal(posts.at(-1).body.bills[0].category,'freight');
    }
    await page.goto(base+'/freight-comparison.html');await page.locator('#tbl tbody tr').first().waitFor();assert.equal(await page.locator('#btnSave').isVisible(),currentRole==='admin');assert.equal(await page.locator('#btnReadPdf').isVisible(),currentRole==='admin');assert.equal(await page.locator('#btnXlsx').isVisible(),true);
    await page.close();
  }
  role='admin';ambiguous=true;const collisionPage=await browser.newPage();collisionPage.on('pageerror',e=>errors.push(e.message));await collisionPage.route('https://**/*',r=>r.abort());await collisionPage.goto(base+'/import-export-os.html');await collisionPage.getByRole('alert').filter({hasText:'เลข PO ซ้ำข้ามบริษัทหรือบอร์ด'}).waitFor();assert.equal(await collisionPage.locator('[draggable="true"]').count(),0);await collisionPage.getByText('FIXTURE-PO',{exact:true}).first().click();assert.equal(await collisionPage.getByRole('button',{name:'แก้ไข',exact:true}).count(),0);assert.equal(await collisionPage.locator('button[title^="แยกเป็น shipment"]').count(),0);await collisionPage.close();
  assert.ok(gets.some(u=>u.pathname==='/api/po-lines'&&u.searchParams.get('company_id')==='2'&&u.searchParams.get('order_id')==='123'));
  assert.deepEqual(errors,[]);console.log('PASS isolated admin/viewer main + freight journeys, failed save retained draft, original revision, scoped PO requests, missing FX blocked, signed bill/category persistence, no browser errors');
}finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
