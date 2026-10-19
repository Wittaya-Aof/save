'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright'),W=require('../lib/logistics-workspace.js');
const root=path.resolve(__dirname,'..'),today=W.today(),tomorrow=W.addDays(today,1),later=W.addDays(today,2);let role='viewer',mutations=0;
const orders=[{id:1,company_id:1,company_code:'KOB',po_number:'PO-A',supplier:'Supplier A',currency:'USD',currency_rate:null,amount_total:100,date_planned:tomorrow,odoo_state:'purchase'},
 {id:2,company_id:2,company_code:'BTV',po_number:'PO-B',supplier:'Supplier B',currency:'THB',currency_rate:1,amount_total:200,date_planned:later,odoo_state:'purchase'},
 {id:3,company_id:1,company_code:'KOB',po_number:'PO-C',supplier:'Supplier C',currency:'THB',currency_rate:1,amount_total:300,date_planned:today,odoo_state:'purchase',receipt_status:'full'}];
for(let i=4;i<=124;i++)orders.push({id:i,company_id:1,company_code:'KOB',po_number:'PO-'+i,supplier:'Supplier '+i,currency:'THB',currency_rate:1,amount_total:10,date_planned:W.addDays(today,10),odoo_state:'purchase'});
const tracking=[{po_so:'PO-A',company:'KOB',companyId:1,_board:'import',_shipmentId:'SHIP-A',_ts:10,owner:'Owner A',dueDate:W.addDays(today,-1),documentChecklist:{form_e:'pending',tax_payment_notice:'done'},poRefs:[{poNumber:'PO-A',companyId:1,odooOrderId:1}],bl:'BL-A'},
 {po_so:'PO-C',company:'KOB',companyId:1,_board:'import',_shipmentId:'SHIP-C',_ts:11,owner:'Owner C',dueDate:W.addDays(today,-1),documentChecklist:{form_e:'pending'},actualDate:today}];
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://fixture');
 if(u.pathname.startsWith('/api/')){
  res.setHeader('Content-Type','application/json');if(req.method!=='GET'){mutations++;res.writeHead(403);res.end('{"ok":false}');return;}
  let j={ok:true,rows:[],via:'api',stale:false};
  if(u.pathname==='/api/me')j={ok:true,user:'fixture',role,canWrite:role==='admin'};
  else if(u.pathname==='/api/tracking')j={ok:true,rows:tracking};
  else if(u.pathname==='/api/import-pos')j={ok:true,rows:orders,via:'api',stale:false};
  else if(u.pathname==='/api/export-sos')j={ok:true,rows:[{id:500,company_id:1,company_code:'KOB',so_number:'SO-A',customer:'Customer A',currency:'THB',currency_rate:1,amount_total:200,odoo_state:'sale'}],via:'api',stale:false};
  else if(u.pathname==='/api/landed-cost')j={unavailable:true,reason:'fixture'};
  else if(u.pathname==='/api/shipment-runs')j={ok:true,runs:[]};
  res.end(JSON.stringify(j));return;
 }
 const target=u.pathname==='/'?'import-export-os.html':'.'+decodeURIComponent(u.pathname),file=path.resolve(root,target);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 try{res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port,browser=await chromium.launch();const errors=[];
 try{
  for(const activeRole of ['viewer','admin']){
   role=activeRole;const ctx=await browser.newContext({viewport:{width:1500,height:950}}),page=await ctx.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error('Fixture page error:',e.message);});await page.route('https://**/*',r=>r.abort());
   await page.goto(base+'/?layout=operations&keep=yes');await page.getByRole('heading',{name:'Shipment Workspace',exact:true}).waitFor();
   const table=page.getByRole('table',{name:'ตารางติดตาม Shipment'});await table.getByText('SHIP-A',{exact:true}).waitFor();assert.match(await page.getByTestId('workspace-count').innerText(),/124/);
   assert.equal(await table.locator('tbody tr').count(),50);await page.getByRole('button',{name:'หน้าถัดไป',exact:true}).click();assert.equal(await table.locator('tbody tr').count(),50);
   await page.getByRole('button',{name:/^ต้นทุนไม่ครบ/}).click();assert.equal(await table.locator('tbody tr').count(),1);assert.match(await table.innerText(),/ข้อมูลไม่ครบ/);
   await page.getByRole('button',{name:/^ทั้งหมด/}).click();await page.getByRole('button',{name:'งานวันนี้',exact:true}).click();await page.getByTestId('workspace-today').getByText('SHIP-C',{exact:true}).waitFor();assert.match(await page.getByTestId('workspace-today').innerText(),/Form E/);
   await page.evaluate(()=>{window.XLSX={utils:{json_to_sheet:rows=>(window.workspaceExcelRows=rows,{}),book_new:()=>({}),book_append_sheet(){}},writeFile(){}};});await page.getByRole('button',{name:'Excel',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.workspaceExcelRows.map(r=>r['PO/SO']).sort()),['PO-A','PO-B','PO-C']);
   await page.getByRole('button',{name:'กำหนดการ',exact:true}).click();await page.getByLabel('ตั้งแต่วันที่').fill(tomorrow);await page.getByLabel('ถึงวันที่').fill(later);await page.getByTestId('workspace-schedule').getByText('SHIP-A',{exact:true}).waitFor();assert.match(await page.getByTestId('workspace-schedule').innerText(),/คาดการณ์/);
   await page.getByRole('button',{name:'Excel',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.workspaceExcelRows.map(r=>r['PO/SO']).sort()),['PO-A','PO-B']);
   await page.getByRole('button',{name:'ตาราง Shipment',exact:true}).click();await table.getByText('SHIP-A',{exact:true}).click();await page.getByText('Shipment ID: SHIP-A',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'แก้ไข',exact:true}).count(),role==='admin'?1:0);await page.getByRole('button',{name:'ปิด',exact:true}).first().click();
   await page.getByRole('button',{name:'Kanban',exact:true}).click();assert.equal(await page.locator('[draggable="true"]').count()>0,role==='admin');
   await page.getByRole('button',{name:'ใช้หน้าตาเดิม',exact:true}).click();assert.equal(await page.getByRole('heading',{name:'Shipment Workspace',exact:true}).count(),0);assert.equal(new URL(page.url()).searchParams.get('layout'),'classic');assert.equal(new URL(page.url()).searchParams.get('keep'),'yes');await page.reload();await page.getByRole('button',{name:'ลองหน้าตาใหม่',exact:true}).waitFor();
   await page.getByRole('button',{name:'ลองหน้าตาใหม่',exact:true}).click();await page.getByRole('heading',{name:'Shipment Workspace',exact:true}).waitFor();await page.getByRole('button',{name:/Export/}).first().click();await page.getByRole('table',{name:'ตารางติดตาม Shipment'}).getByRole('button',{name:'SO-A',exact:true}).waitFor();
   if(role==='viewer'){await page.getByRole('button',{name:/Import/}).first().click();await page.screenshot({path:'.superpowers/sdd/tracking-workspace-preview/workspace-preview.png'});}
   await ctx.close();
  }
  role='viewer';const ctx=await browser.newContext({viewport:{width:390,height:844}});await ctx.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('blocked','SecurityError');}}));const page=await ctx.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error('Fixture page error:',e.message);});await page.route('https://**/*',r=>r.abort());await page.goto(base+'/?layout=operations');await page.getByRole('heading',{name:'Shipment Workspace',exact:true}).waitFor();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.getByRole('button',{name:'ใช้หน้าตาเดิม',exact:true}).click();await page.reload();await page.getByRole('button',{name:'ลองหน้าตาใหม่',exact:true}).waitFor();await ctx.close();
  assert.equal(mutations,0);assert.deepEqual(errors,[]);console.log('workspace-browser: passed (opt-in, table/filter/paging, daily/schedule, scopes/roles, classic rollback+reload, blocked storage/mobile, no business writes/errors)');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
