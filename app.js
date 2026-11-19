/* Kho PU - phiên bản GitHub Pages + Supabase. Không có mật khẩu hay khóa bí mật trong mã nguồn. */
"use strict";

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
})[c]);
const money = value => Number(value || 0).toLocaleString("vi-VN", {
  minimumFractionDigits: 0, maximumFractionDigits: 2
});
const time = value => value ? new Date(value).toLocaleString("vi-VN") : "—";
const field = (data, name) => String(data.get(name) ?? "").trim();
const qrLink = code => new URL("?roll=" + encodeURIComponent(code), location.href.split("?")[0]).href;
const status = r => Number(r.remaining_meters) <= 0 ? "empty" :
  Number(r.remaining_meters) < Number(r.initial_meters) ? "partial" : "ok";
const statusText = {ok:"Nguyên cây",partial:"Đã xuất một phần",empty:"Đã hết"};
const locText = r => r.locations ?
  [r.locations.area,r.locations.rack,r.locations.bin_name].join(" → ") : "Chưa xếp vị trí";
const colorLabel = r => '<span class="tag ' + status(r) + '">' + statusText[status(r)] + '</span>';

const state = {
  client:null,session:null,rolls:[],saps:[],locations:[],movements:[],
  active:"home",selected:null,lastCodes:[],qr:null,qrRunning:false,scanHandled:false,busy:false,
  find:"",filterArea:"",filterRack:"",filterBin:"",issueSearch:"",selectedIssue:null,
  issuePo:"",issueSap:""
};
let toastTimer;
function toast(message, error=false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error",error);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.textContent = ""; }, 6500);
}
function page(title,description="",actions="") {
  return '<div class="page-title"><div><h1>'+esc(title)+'</h1><p>'+esc(description)+'</p></div><div class="action-row">'+actions+'</div></div>';
}
function action(label, action, secondary=false, extra="") {
  return '<button class="btn '+(secondary?'subtle':'primary')+'" data-action="'+action+'" '+extra+'>'+label+'</button>';
}
function card(body,extra="") {return '<section class="card '+extra+'">'+body+'</section>';}
function empty(text) {return '<div class="empty-state">'+esc(text)+'</div>';}
function quoteClass(name) {return esc(name);}
function isBusy() {if (state.busy) { toast("Đang xử lý, vui lòng chờ..."); return true; } return false;}
async function doWork(fn) {
  if (isBusy()) return;
  state.busy=true;
  try { await fn(); }
  catch(err) { toast(err.message || String(err),true); }
  finally { state.busy=false; }
}

function validMeters(raw) {
  const text = String(raw).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || Number(text)<=0 || Number(text)>99999999)
    throw new Error("Số mét không hợp lệ. Ví dụ số lẻ: 12.5");
  return Number(text);
}
function splitMeters(raw) {
  const items = String(raw||"").split(/[,;\n\r]+/).map(x=>x.trim()).filter(Boolean);
  if (!items.length || items.length>500) throw new Error("Nhập từ 1 đến 500 đầu cây.");
  return items.map(validMeters);
}
function checkText(value, name, max=100) {
  const s=String(value||"").trim();
  if(!s || s.length>max) throw new Error(name+" phải có 1–"+max+" ký tự.");
  return s;
}
function validateLocation(row) {
  const vals=[row.area,row.rack,row.bin].map(v=>String(v||"").trim());
  if(vals.some(Boolean) && !vals.every(Boolean)) throw new Error("Vị trí phải điền đủ Khu vực, Kệ, Ô.");
  if(vals.some(v=>v.length>80)) throw new Error("Tên khu vực, kệ, ô không quá 80 ký tự.");
}
function useData(rows) {
  state.rolls=rows.rolls;
  state.saps=rows.saps;
  state.locations=rows.locations;
  state.movements=rows.movements;
}
async function listAll(table, columns, order="created_at") {
  const collected=[];
  for(let start=0;start<10000;start+=1000) {
    const {data,error}=await state.client.from(table).select(columns)
      .order(order,{ascending:false}).range(start,start+999);
    if(error) throw new Error(table+": "+error.message);
    collected.push(...data);
    if(data.length<1000) break;
  }
  return collected;
}
async function refresh(render=true) {
  const [rolls,saps,locations,movements]=await Promise.all([
    listAll("rolls","id,roll_code,po,initial_meters,remaining_meters,created_at,sap_items(sap_code,description),locations(area,rack,bin_name)"),
    listAll("sap_items","id,sap_code,description"),
    listAll("locations","id,area,rack,bin_name","area"),
    listAll("movements","id,roll_id,movement_type,meters,workshop,note,from_location,to_location,actor_email,created_at")
  ]);
  useData({rolls,saps,locations,movements});
  if(render) renderCurrent();
}
async function show(tab,options={}) {
  if(state.qrRunning) await stopScanner();
  state.active=tab;
  if(options.code) state.selected=options.code;
  if(tab==="issue" && options.code) {
    state.selectedIssue=options.code;
    const roll=state.rolls.find(r=>r.roll_code===options.code);
    if(roll){state.issuePo=roll.po;state.issueSap=roll.sap_items?.sap_code||"";}
  }
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));
  if(tab==="labels" || tab==="detail") document.querySelectorAll(".tab").forEach(b=>b.classList.remove("active"));
  renderCurrent();
  window.scrollTo({top:0,behavior:"smooth"});
}
function renderCurrent() {
  const views={
    home:renderHome,inbound:renderInbound,issue:renderIssue,rolls:renderRolls,scan:renderScanner,
    locations:renderLocations,history:renderHistory,reports:renderReports,
    detail:renderDetail,labels:renderLabels
  };
  $("#view").innerHTML=(views[state.active]||renderHome)();
  if(state.active==="labels") buildQRCodes();
  if(state.active==="detail") buildDetailQR();
  if(state.active==="inbound") updateMeterPreview();
}

function renderHome() {
  const available=state.rolls.filter(r=>Number(r.remaining_meters)>0);
  const partial=available.filter(r=>status(r)==="partial");
  const total=available.reduce((sum,r)=>sum+Number(r.remaining_meters),0);
  const low=available.filter(r=>Number(r.remaining_meters)<=10).sort((a,b)=>Number(a.remaining_meters)-Number(b.remaining_meters));
  const today=new Date().toLocaleDateString("en-CA");
  const todayOut=state.movements.filter(m=>m.movement_type==="OUT" &&
    new Date(m.created_at).toLocaleDateString("en-CA")===today)
    .reduce((s,m)=>s+Number(m.meters),0);
  const stats=[
    ["▥","Đầu cây còn hàng",available.length,"cây"],
    ["≈","Tổng mét còn tồn",money(total),"m"],
    ["◕","Cây xuất một phần",partial.length,"cây"],
    ["↗","Xuất hôm nay",money(todayOut),"m"]
  ];
  return page("Tổng quan kho PU","Quản lý chính xác từng đầu cây và số mét dư.",
    action("↻ Làm mới","refresh",true)) +
    '<div class="stat-grid">'+stats.map(s=>'<div class="stat"><div class="icon">'+s[0]+'</div><small>'+s[1]+'</small><strong>'+s[2]+' <em>'+s[3]+'</em></strong></div>').join("")+'</div>'+
    '<div class="quick-grid">'+[
      ["↧","Nhập kho","inbound"],["↗","Xuất kho","issue"],["▣","Quét mã QR","scan"],["▤","Báo cáo","reports"]
    ].map(s=>'<button class="quick" data-tab="'+s[2]+'"><i>'+s[0]+'</i>'+s[1]+'</button>').join("")+'</div>'+
    '<div class="cols" style="margin-top:20px">'+
    card('<h2>Hoạt động gần đây</h2>'+renderMovementsTable(state.movements.slice(0,12),false))+
    card('<h2>Cây còn ít mét (≤ 10 m)</h2>'+(low.length?low.slice(0,12).map(r=>
      '<div class="label-foot" style="padding:12px 0"><div><b>'+esc(r.sap_items?.sap_code)+'</b><small style="display:block">'+esc(r.roll_code)+'</small></div><b style="color:#b54f4f">'+money(r.remaining_meters)+' m</b></div>'
    ).join(""):empty("Không có cây sắp hết.")))+"</div>";
}

function renderInbound() {
  return page("Nhập cây PU","Mỗi số mét tương ứng một đầu cây riêng, tự sinh mã và QR.",
    action("↓ Tải Excel mẫu","template",true))+
    card('<h2>Nhập kho theo SAP và P/O</h2><form id="inbound-form" class="form-grid">'+
      '<label>Mã SAP<input name="sap" list="sap-suggestions" placeholder="PU00125" maxlength="80" required>'+
        '<datalist id="sap-suggestions">'+state.saps.map(s=>'<option value="'+esc(s.sap_code)+'">').join("")+'</datalist></label>'+
      '<label>P/O<input name="po" placeholder="PO2026-001" maxlength="100" required></label>'+
      '<label class="full">Tên vật tư / màu sắc<input name="description" placeholder="PU đen, quy cách..."></label>'+
      '<label class="full">Số mét của từng đầu cây<textarea name="lengths" id="inbound-lengths" placeholder="100&#10;120&#10;80" required></textarea><small class="hint">Mỗi dòng một cây hoặc ngăn bằng dấu phẩy. Số lẻ dùng dấu chấm, ví dụ 12.5.</small></label>'+
      '<label>Khu vực<input name="area" list="area-suggest" placeholder="A"><datalist id="area-suggest">'+
        [...new Set(state.locations.map(l=>l.area))].map(s=>'<option value="'+esc(s)+'">').join("")+'</datalist></label>'+
      '<label>Kệ<input name="rack" placeholder="K01"></label>'+
      '<label>Ô (tự đặt tên)<input name="bin" placeholder="Ô A-01"></label>'+
      '<div class="notice"><b id="inbound-preview">0 cây · 0 m</b><br>Nhập xong sẽ tự tạo mã cây và trang in QR.</div>'+
      '<div class="form-actions full"><button class="btn primary" type="submit">Lưu nhập kho và tạo QR →</button></div>'+
    '</form>')+
    card('<h2>Nhập hàng loạt bằng Excel</h2><p class="hint">File .xlsx với mỗi dòng một cây: Mã SAP, P/O, Số mét, Khu vực, Kệ, Ô, Mô tả.</p>'+
      '<label>Chọn tệp Excel<input type="file" id="import-file" accept=".xlsx"></label>'+
      '<div class="form-actions">'+action("Nhập Excel và tạo cây","import")+
      action("↓ Tải file Excel mẫu","template",true)+'</div>'+
      '<p class="hint">Tối đa 500 cây mỗi lần nhập. Nếu một dòng lỗi, toàn bộ lần nhập sẽ được hủy.</p>');
}
function updateMeterPreview() {
  const el=$("#inbound-lengths"), target=$("#inbound-preview");
  if(!el||!target)return;
  const update=()=>{
    const arr=el.value.split(/[,;\n\r]+/).map(v=>Number(v.trim())).filter(v=>v>0);
    target.textContent=arr.length+" cây · "+money(arr.reduce((s,n)=>s+n,0))+" m";
  };
  el.addEventListener("input",update);
  update();
}

function issuePoRolls() {
  const po=state.issuePo.trim().toLocaleLowerCase("vi-VN");
  if(!po)return [];
  return state.rolls.filter(r=>String(r.po).toLocaleLowerCase("vi-VN")===po);
}
function issueSapOptions() {
  return [...new Set(issuePoRolls().map(r=>r.sap_items?.sap_code).filter(Boolean))].sort();
}
function issueCandidates() {
  if(!state.issuePo.trim() || !state.issueSap)return [];
  const q=state.issueSearch.trim().toLocaleLowerCase("vi-VN");
  return issuePoRolls().filter(r=>r.sap_items?.sap_code===state.issueSap &&
    Number(r.remaining_meters)>0 && (!q ||
    [r.roll_code,r.sap_items?.description,locText(r)]
      .join(" ").toLocaleLowerCase("vi-VN").includes(q)));
}
function issueLedger() {
  const rollsById=new Map(state.rolls.map(r=>[r.id,r]));
  const balances=new Map(state.rolls.map(r=>[r.id,Number(r.remaining_meters)]));
  return state.movements.filter(m=>m.movement_type==="OUT")
    .sort((a,b)=>new Date(b.created_at)-new Date(a.created_at) || String(b.id).localeCompare(String(a.id)))
    .map(m=>{
      const roll=rollsById.get(m.roll_id);
      const remainingAfter=balances.get(m.roll_id);
      if(roll)balances.set(m.roll_id,remainingAfter+Number(m.meters));
      return {...m,roll,remainingAfter};
    })
    .filter(m=>m.roll && m.roll.po.toLocaleLowerCase("vi-VN")===state.issuePo.trim().toLocaleLowerCase("vi-VN") &&
      m.roll.sap_items?.sap_code===state.issueSap);
}
function renderIssue() {
  const options=issueSapOptions();
  const poRolls=issuePoRolls();
  const matches=issueCandidates();
  const picked=state.rolls.find(r=>r.roll_code===state.selectedIssue &&
    r.po.toLocaleLowerCase("vi-VN")===state.issuePo.trim().toLocaleLowerCase("vi-VN") &&
    r.sap_items?.sap_code===state.issueSap);
  const balance=picked?Number(picked.remaining_meters):0;
  const ledger=state.issuePo && state.issueSap?issueLedger():[];
  const totalIssued=ledger.reduce((sum,m)=>sum+Number(m.meters),0);
  const remainingForSap=poRolls.filter(r=>r.sap_items?.sap_code===state.issueSap)
    .reduce((sum,r)=>sum+Number(r.remaining_meters),0);
  const emptyMessage=!state.issuePo.trim()?"Hãy nhập P/O để bắt đầu xuất kho.":
    !poRolls.length?"Không tìm thấy P/O này trong kho.":
    !state.issueSap?"Hãy chọn mã SAP của P/O này.":
    "Không có đầu cây còn hàng phù hợp với P/O và SAP đã chọn.";
  const pickedDetails=picked?'<div class="chosen-roll"><div><small>Đầu cây đã chọn</small><h2>'+esc(picked.roll_code)+
    '</h2><p>SAP: <b>'+esc(picked.sap_items?.sap_code)+'</b> · P/O: '+esc(picked.po)+
    '</p><p>Ban đầu: '+money(picked.initial_meters)+' m · Vị trí: '+esc(locText(picked))+'</p></div><div class="chosen-balance"><small>Mét còn lại</small><strong>'+money(balance)+' m</strong></div></div>':
    '<div class="notice">Chọn một đầu cây trong danh sách bên dưới để xuất kho.</div>';
  return page("Xuất kho PU","Nhập P/O → chọn SAP → chọn đầu cây → nhập mét xuất.",
    action("▣ Quét QR","scan-tab",true))+
    card('<h2>1. Nhập P/O và chọn mã SAP</h2><div class="form-grid">'+
      '<label>P/O cần xuất<input id="issue-po" list="issue-po-list" placeholder="Nhập chính xác P/O, ví dụ PO2026-001" value="'+esc(state.issuePo)+'" autocomplete="off">'+
      '<datalist id="issue-po-list">'+[...new Set(state.rolls.map(r=>r.po))].sort().map(po=>'<option value="'+esc(po)+'">').join("")+'</datalist></label>'+
      '<label>Mã SAP thuộc P/O<select id="issue-sap" '+(!poRolls.length?'disabled':'')+'><option value="">-- Chọn mã SAP --</option>'+
      options.map(sap=>'<option value="'+esc(sap)+'" '+(sap===state.issueSap?'selected':'')+'>'+esc(sap)+'</option>').join("")+'</select></label></div>'+
      '<p class="hint">'+(poRolls.length?poRolls.length+' đầu cây thuộc P/O này.':'Nhập đúng P/O để hiển thị danh sách SAP trong đơn hàng.')+
      (state.issueSap?' Tổng số mét còn của SAP '+esc(state.issueSap)+': <b>'+money(remainingForSap)+' m</b>.':'')+'</p>')+
    card('<h2>2. Đầu cây cần xuất</h2>'+pickedDetails+
      (picked && balance>0?'<form id="quick-issue-form" class="issue-form">'+
        '<input type="hidden" name="code" value="'+esc(picked.roll_code)+'">'+
        '<label>Số mét muốn xuất<input type="number" name="meters" inputmode="decimal" min="0.01" step="0.01" max="'+balance+'" placeholder="Ví dụ: 12.5" required></label>'+
        '<label>Phân xưởng (không bắt buộc)<select name="workshop"><option value="">Chưa chọn</option>'+
        '<option value="may1">May 1</option><option value="may2">May 2</option><option value="may3">May 3</option></select></label>'+
        '<button class="btn subtle" type="button" data-issue-all="'+balance+'">Chọn xuất hết '+money(balance)+' m</button>'+
        '<button class="btn primary" type="submit">↗ Xác nhận xuất kho</button></form>':
        picked?'<div class="notice">Cây này đã xuất hết. Hãy chọn cây khác.</div>':'')+
      '<p class="hint">Phần mềm tự trừ số mét xuất và ghi lịch sử. Không thể xuất vượt số mét còn lại.</p>')+
    card('<h2>3. Chọn đầu cây thuộc P/O và SAP</h2><label>Tìm thêm theo mã đầu cây hoặc vị trí ô kho'+
      '<input id="issue-search" placeholder="Tìm mã cây / ô kho..." value="'+esc(state.issueSearch)+'"></label>'+
      '<p class="hint">'+matches.length+' đầu cây còn hàng, hiển thị tối đa 300 cây. Một ô có thể chứa nhiều cây.</p>'+
      '<div class="table-scroll"><table><thead><tr><th>Mã đầu cây / SAP</th><th>P/O</th><th>Mét ban đầu</th><th>Mét còn</th><th>Vị trí</th><th></th></tr></thead><tbody>'+
      matches.slice(0,300).map(r=>'<tr class="'+(r.roll_code===state.selectedIssue?'issue-selected':status(r))+'"><td><b>'+esc(r.roll_code)+'</b><small>'+esc(r.sap_items?.sap_code)+'</small></td>'+
        '<td>'+esc(r.po)+'</td><td>'+money(r.initial_meters)+' m</td><td><b>'+money(r.remaining_meters)+' m</b></td><td>'+esc(locText(r))+'</td>'+
        '<td><button class="btn '+(r.roll_code===state.selectedIssue?'primary':'subtle')+' small" data-issue-code="'+esc(r.roll_code)+'">'+
        (r.roll_code===state.selectedIssue?'✓ Đã chọn':'Chọn cây')+'</button></td></tr>').join("")+
      (matches.length?"":'<tr><td colspan="6">'+empty(emptyMessage)+'</td></tr>')+
      '</tbody></table></div>')+
    card('<h2>4. Bảng kê đã xuất của P/O và SAP</h2>'+
      '<p class="hint">'+ledger.length+' lượt xuất · Tổng đã xuất: <b>'+money(totalIssued)+' m</b>. Cột dư là mét còn ngay sau từng lần xuất.</p>'+
      (ledger.length?action("↓ Tải bảng kê Excel","export-issue-ledger",true):"")+
      '<div class="table-scroll"><table><thead><tr><th>Thời gian</th><th>P/O</th><th>SAP</th><th>Mã đầu cây</th><th>Mét đầu cây</th><th>Mét xuất</th><th>Dư sau xuất</th><th>Phân xưởng</th></tr></thead><tbody>'+
      ledger.slice(0,200).map(m=>'<tr><td>'+time(m.created_at)+'</td><td>'+esc(m.roll.po)+'</td><td>'+esc(m.roll.sap_items?.sap_code)+'</td>'+
        '<td><b>'+esc(m.roll.roll_code)+'</b></td><td>'+money(m.roll.initial_meters)+' m</td><td>'+money(m.meters)+' m</td><td><b>'+money(m.remainingAfter)+' m</b></td><td>'+esc(m.workshop||"—")+'</td></tr>').join("")+
      (ledger.length?"":'<tr><td colspan="8">'+empty("Chưa có lượt xuất nào cho P/O và SAP đã chọn.")+'</td></tr>')+
      '</tbody></table></div>');
}

function filterRolls() {
  const q=state.find.toLocaleLowerCase("vi-VN");
  return state.rolls.filter(r=>{
    if(state.filterArea && r.locations?.area!==state.filterArea) return false;
    if(state.filterRack && r.locations?.rack!==state.filterRack) return false;
    if(state.filterBin && r.locations?.bin_name!==state.filterBin) return false;
    if(!q)return true;
    const text=[r.roll_code,r.sap_items?.sap_code,r.po,
      r.locations?.area,r.locations?.rack,r.locations?.bin_name].join(" ").toLocaleLowerCase("vi-VN");
    return text.includes(q);
  });
}
function renderRolls() {
  const filtered=filterRolls();
  const options=(name,values,current)=>'<select data-filter="'+name+'"><option value="">'+
    (name==="area"?"Tất cả khu vực":name==="rack"?"Tất cả kệ":"Tất cả ô")+'</option>'+
    [...new Set(values.filter(Boolean))].sort().map(v=>
      '<option value="'+esc(v)+'" '+(v===current?"selected":"")+'>'+esc(v)+'</option>'
    ).join("")+'</select>';
  return page("Danh sách đầu cây PU","Tìm kiếm chung theo SAP, P/O, mã cây và vị trí.",
    action("↓ Xuất Excel tồn kho","export-stock",true)+action("▣ Quét QR","scan-tab"))+
    card('<div class="filters"><input id="search-rolls" placeholder="Tìm mã SAP / P/O / cây / ô..." value="'+esc(state.find)+'">'+
      options("area",state.locations.map(l=>l.area),state.filterArea)+
      options("rack",state.locations.map(l=>l.rack),state.filterRack)+
      options("bin",state.locations.map(l=>l.bin_name),state.filterBin)+'</div>'+
      '<p class="hint">'+filtered.length+' đầu cây · <span class="tag ok">Nguyên cây</span> '+
      '<span class="tag partial">Xuất một phần</span> <span class="tag empty">Đã hết</span></p>'+
      '<div class="table-scroll"><table><thead><tr><th>Mã cây / SAP</th><th>P/O</th><th>Nhập</th>'+
      '<th>Đã xuất</th><th>Mét dư</th><th>Vị trí</th><th>Trạng thái</th><th></th></tr></thead><tbody>'+
      filtered.map(r=>'<tr class="'+status(r)+'"><td><a href="#" data-open="'+esc(r.roll_code)+'"><b>'+esc(r.roll_code)+
        '</b></a><small>'+esc(r.sap_items?.sap_code)+'</small></td><td>'+esc(r.po)+'</td><td>'+money(r.initial_meters)+
        '</td><td>'+money(Number(r.initial_meters)-Number(r.remaining_meters))+'</td><td><b>'+money(r.remaining_meters)+' m</b></td>'+
        '<td>'+esc(locText(r))+'</td><td>'+colorLabel(r)+'</td><td><button class="btn small subtle" data-print="'+
        esc(r.roll_code)+'">▣ QR</button> '+(Number(r.remaining_meters)>0?
        '<button class="btn small primary" data-issue-code="'+esc(r.roll_code)+'">↗ Xuất</button>':'')+'</td></tr>').join("")+
      (filtered.length?"":'<tr><td colspan="8">'+empty("Không tìm thấy cây phù hợp.")+'</td></tr>')+
      '</tbody></table></div>');
}

function renderDetail() {
  const r=state.rolls.find(item=>item.roll_code===state.selected);
  if(!r)return page("Không tìm thấy đầu cây","Mã cây này không có trong dữ liệu kho.")+
    action("← Danh sách","rolls-tab",true);
  const balance=Number(r.remaining_meters);
  const outgoing=Number(r.initial_meters)-balance;
  const history=state.movements.filter(m=>m.roll_id===r.id);
  return page(r.roll_code,"SAP: "+(r.sap_items?.sap_code||"")+
    " · P/O: "+r.po,action("↻ Làm mới","refresh",true)+action("▣ In tem QR","print-one",true))+
    '<div class="cols">'+card(
      '<h2>Chi tiết vật tư '+colorLabel(r)+'</h2>'+
      '<p><b>Mã SAP:</b> '+esc(r.sap_items?.sap_code)+'<br><b>P/O:</b> '+esc(r.po)+
      '<br><b>Mô tả:</b> '+esc(r.sap_items?.description||"—")+
      '<br><b>Vị trí:</b> '+esc(locText(r))+'</p>'+
      '<div class="meter-cards"><div><small>Ban đầu</small><b>'+money(r.initial_meters)+'</b></div>'+
      '<div><small>Đã xuất</small><b>'+money(outgoing)+'</b></div>'+
      '<div class="green"><small>Mét dư</small><b>'+money(balance)+'</b></div></div>'+
      '<div class="progress"><span style="width:'+Math.max(0,Math.min(100,balance/Number(r.initial_meters)*100))+'%"></span></div>'+
      (balance>0?'<h2 style="margin-top:24px">Xuất mét từ cây này</h2>'+
        '<form id="issue-form" class="form-grid"><input type="hidden" name="code" value="'+esc(r.roll_code)+'">'+
        '<label>Số mét xuất<input type="number" name="meters" min="0.01" step="0.01" max="'+balance+'" required></label>'+
        '<label>Phân xưởng<select name="workshop"><option value="">Chưa chọn</option>'+
        '<option value="may1">May 1</option><option value="may2">May 2</option>'+
        '<option value="may3">May 3</option><option value="khac">Khác</option></select></label>'+
        '<label class="full">Chuyền / mã giày / ghi chú<input name="note" maxlength="300"></label>'+
        '<div class="full"><button class="btn primary" type="submit">Xuất kho & tự trừ tồn →</button></div></form>':'<div class="notice">Đầu cây đã xuất hết, không thể xuất thêm.</div>')
    )+
    card('<h2>Mã QR đầu cây</h2><div class="qr-preview" id="detail-qr"></div>'+
      '<p class="hint">Quét bằng camera trên điện thoại để mở chính cây PU này.</p>'+
      (balance>0?'<h2 style="margin-top:25px">Chuyển vị trí</h2>'+
        '<form id="move-form" class="stack"><input type="hidden" name="code" value="'+esc(r.roll_code)+'">'+
        '<label>Khu vực<input name="area" value="'+esc(r.locations?.area||"")+'" required></label>'+
        '<label>Kệ<input name="rack" value="'+esc(r.locations?.rack||"")+'" required></label>'+
        '<label>Ô (tự đặt tên)<input name="bin" value="'+esc(r.locations?.bin_name||"")+'" required></label>'+
        '<button class="btn subtle" type="submit">⇄ Lưu chuyển ô</button></form>':'')
    )+'</div>'+
    card('<h2>Lịch sử đầu cây</h2>'+renderMovementsTable(history,false));
}
function buildDetailQR() {
  const el=$("#detail-qr");
  if(el && state.selected && window.QRCode)
    new QRCode(el,{text:qrLink(state.selected),width:205,height:205,
      colorDark:"#0b2941",colorLight:"#ffffff",correctLevel:QRCode.CorrectLevel.M});
}
function renderLabels() {
  const rows=state.lastCodes.map(code=>state.rolls.find(r=>r.roll_code===code)).filter(Boolean);
  return '<div class="hidden-print">'+page("In tem QR cây PU",rows.length+" tem",
    action("⎙ In tem","print-labels")+action("← Danh sách","rolls-tab",true))+
    '<div class="notice">Tem QR chứa địa chỉ GitHub Pages. Quét bằng điện thoại ở bất cứ đâu có Internet, rồi đăng nhập.</div></div>'+
    '<div class="labels">'+rows.map(r=>
      '<div class="label"><div class="label-head"><div><b>KHO PU MAY GIÀY</b><h3>'+esc(r.roll_code)+'</h3>'+
      '<small>SAP: '+esc(r.sap_items?.sap_code)+'</small><small>P/O: '+esc(r.po)+'</small>'+
      '</div><div class="label-qr" data-qrcode="'+esc(r.roll_code)+'"></div></div>'+
      '<div class="label-foot"><span>Ban đầu: <b>'+money(r.initial_meters)+' m</b></span>'+
      '<span>Vị trí: <b>'+esc(locText(r))+'</b></span></div></div>'
    ).join("")+'</div>';
}
function buildQRCodes() {
  document.querySelectorAll("[data-qrcode]").forEach(el=>{
    new QRCode(el,{text:qrLink(el.dataset.qrcode),width:110,height:110,
      correctLevel:QRCode.CorrectLevel.M});
  });
}

function renderLocations() {
  const groups=state.locations.map(l=>{
    const rolls=state.rolls.filter(r=>r.locations?.area===l.area &&
      r.locations?.rack===l.rack && r.locations?.bin_name===l.bin_name &&
      Number(r.remaining_meters)>0);
    return {l,count:rolls.length,total:rolls.reduce((s,r)=>s+Number(r.remaining_meters),0)};
  });
  return page("Khu vực → Kệ → Ô","Tên ô tự nhập, một ô chứa nhiều đầu cây.")+
    card('<h2>Thêm ô kho</h2><form id="location-form" class="form-grid">'+
      '<label>Khu vực<input name="area" placeholder="A" required></label>'+
      '<label>Kệ<input name="rack" placeholder="K01" required></label>'+
      '<label>Ô (tự đặt tên)<input name="bin" placeholder="Ô A-01" required></label>'+
      '<div class="form-actions"><button class="btn primary" type="submit">+ Tạo vị trí</button></div></form>')+
    card('<h2>Danh sách vị trí kho</h2><div class="table-scroll"><table><thead><tr>'+
      '<th>Khu vực</th><th>Kệ</th><th>Ô</th><th>Số cây còn hàng</th><th>Số mét tồn</th></tr></thead><tbody>'+
      groups.map(x=>'<tr><td>'+esc(x.l.area)+'</td><td>'+esc(x.l.rack)+'</td>'+
        '<td><b>'+esc(x.l.bin_name)+'</b></td><td>'+x.count+'</td>'+
        '<td><b>'+money(x.total)+' m</b></td></tr>').join("")+
      (groups.length?"":'<tr><td colspan="5">'+empty("Chưa có ô kho.")+'</td></tr>')+'</tbody></table></div>');
}

function renderMovementsTable(rows,full=true) {
  return '<div class="table-scroll"><table><thead><tr><th>Thời gian</th>'+
    '<th>Loại</th><th>Mã cây</th><th>Mét</th>'+(full?'<th>Phân xưởng</th><th>Ô cũ</th><th>Ô mới</th><th>Người thực hiện</th><th>Ghi chú</th>':'')+
    '</tr></thead><tbody>'+
    rows.map(m=>{
      const roll=state.rolls.find(r=>r.id===m.roll_id);
      const color=m.movement_type==="IN"?"ok":m.movement_type==="OUT"?"empty":"info";
      return '<tr><td>'+time(m.created_at)+'</td><td><span class="tag '+color+'">'+
        ({IN:"Nhập",OUT:"Xuất",MOVE:"Chuyển ô"}[m.movement_type]||m.movement_type)+'</span></td>'+
        '<td>'+(roll?'<a href="#" data-open="'+esc(roll.roll_code)+'">'+esc(roll.roll_code)+'</a>':"—")+'</td>'+
        '<td>'+money(m.meters)+'</td>'+
        (full?'<td>'+esc(m.workshop||"—")+'</td><td>'+esc(m.from_location||"—")+'</td>'+
          '<td>'+esc(m.to_location||"—")+'</td><td>'+esc(m.actor_email||"—")+'</td>'+
          '<td>'+esc(m.note)+'</td>':'')+'</tr>';
    }).join("")+
    (rows.length?"":'<tr><td colspan="'+(full?"9":"4")+'">'+empty("Chưa có hoạt động.")+'</td></tr>')+
    '</tbody></table></div>';
}
function renderHistory() {
  return page("Lịch sử xuất – nhập – chuyển ô","Lưu ngày giờ và tài khoản thực hiện.",
    action("↓ Xuất Excel","export-history",true))+
    card('<h2>Nhật ký gần đây</h2>'+renderMovementsTable(state.movements.slice(0,1000)));
}
function summaryData() {
  const map=new Map();
  for(const r of state.rolls) {
    const sap=r.sap_items?.sap_code||"";
    const key=sap+"||"+r.po;
    if(!map.has(key))map.set(key,{sap,po:r.po,description:r.sap_items?.description||"",
      count:0,initial:0,used:0,balance:0});
    const x=map.get(key);
    x.count++;
    x.initial+=Number(r.initial_meters);
    x.balance+=Number(r.remaining_meters);
    x.used+=Number(r.initial_meters)-Number(r.remaining_meters);
  }
  return [...map.values()].sort((a,b)=>a.sap.localeCompare(b.sap)||a.po.localeCompare(b.po));
}
function renderReports() {
  const bySap=summaryData();
  const byWorkshop=new Map();
  state.movements.filter(m=>m.movement_type==="OUT").forEach(m=>{
    const key=m.workshop||"Chưa chọn";
    byWorkshop.set(key,(byWorkshop.get(key)||0)+Number(m.meters));
  });
  return page("Báo cáo tồn kho","Theo SAP, P/O, từng đầu cây, vị trí và phân xưởng.",
    action("↓ Xuất Excel","export-report"))+
    card('<h2>Tổng hợp theo SAP và P/O</h2><div class="table-scroll"><table><thead><tr>'+
      '<th>Mã SAP</th><th>P/O</th><th>Số cây</th><th>Tổng nhập</th><th>Đã xuất</th><th>Còn tồn</th></tr></thead><tbody>'+
      bySap.map(r=>'<tr><td>'+esc(r.sap)+'</td><td>'+esc(r.po)+'</td><td>'+r.count+
        '</td><td>'+money(r.initial)+'</td><td>'+money(r.used)+'</td><td><b>'+money(r.balance)+' m</b></td></tr>').join("")+
      (bySap.length?"":'<tr><td colspan="6">'+empty("Chưa có số liệu.")+'</td></tr>')+'</tbody></table></div>')+
    card('<h2>Tổng mét xuất theo phân xưởng</h2><div class="table-scroll"><table><thead>'+
      '<tr><th>Phân xưởng</th><th>Đã xuất (m)</th></tr></thead><tbody>'+
      [...byWorkshop].map(([key,val])=>'<tr><td>'+esc(key)+'</td><td>'+money(val)+' m</td></tr>').join("")+
      (byWorkshop.size?"":'<tr><td colspan="2">'+empty("Chưa có lượt xuất.")+'</td></tr>')+
      '</tbody></table></div>');
}

function renderScanner() {
  return page("Quét QR đầu cây","Mở camera điện thoại hoặc chụp ảnh mã QR.",
    action("← Danh sách","rolls-tab",true))+
    '<div class="cols">'+
    card('<h2>Camera quét mã QR</h2><div class="scanner"><div id="reader"></div>'+
      '<div id="camera-message" class="camera-msg">Nhấn bật camera để bắt đầu.</div></div>'+
      '<div class="form-actions">'+action("▣ Bật camera","start-scan")+
      action("■ Tắt camera","stop-scan",true)+'</div>'+
      '<p class="hint">Nếu camera không chạy, chụp ảnh mã QR bên dưới để quét từ ảnh.</p>'+
      '<label>Chụp / chọn ảnh QR<input id="qr-photo" type="file" accept="image/*" capture="environment"></label>')+
    card('<h2>Nhập mã cây để tra cứu</h2><form id="manual-scan-form" class="stack">'+
      '<label>Mã cây PU<input name="code" placeholder="PU-261119-XXXXXXXX" required></label>'+
      '<button class="btn primary" type="submit">Mở thông tin cây →</button></form>'+
      '<div class="notice">Quét QR → xem SAP, P/O và mét dư → xuất kho hoặc chuyển vị trí.</div>')+
    '</div>';
}

function normalizeCode(scanned) {
  let code=String(scanned||"").trim();
  try {
    const url=new URL(code);
    code=url.searchParams.get("roll")||code;
  } catch(_){}
  return /^PU-[A-Za-z0-9-]{4,90}$/.test(code) ? code : null;
}
async function scanResult(content) {
  if(state.scanHandled)return;
  const code=normalizeCode(content);
  if(!code) {toast("Đây không phải mã QR cây PU hợp lệ.",true);return;}
  state.scanHandled=true;
  if(state.qrRunning) await stopScanner();
  await refresh(false);
  await show("detail",{code});
}
async function startScanner() {
  if(state.qrRunning)return;
  if(!window.Html5Qrcode)throw new Error("Bộ đọc QR không tải được.");
  state.scanHandled=false;
  state.qr=new Html5Qrcode("reader");
  try {
    $("#camera-message").textContent="Đang yêu cầu quyền camera...";
    await state.qr.start({facingMode:"environment"},
      {fps:10,qrbox:{width:220,height:220}},
      text=>scanResult(text),()=>{});
    state.qrRunning=true;
    $("#camera-message").textContent="Đưa QR vào giữa khung hình.";
  } catch(err) {
    $("#camera-message").textContent="Không mở được camera. Hãy dùng ảnh QR hoặc nhập mã cây.";
    throw err;
  }
}
async function stopScanner() {
  if(state.qrRunning && state.qr) {
    try {await state.qr.stop();} catch(_){}
  }
  state.qrRunning=false;
}
async function scanPhoto(file) {
  if(!window.Html5Qrcode) throw new Error("Bộ đọc QR chưa tải.");
  state.scanHandled=false;
  if(state.qrRunning) await stopScanner();
  if(!state.qr)state.qr=new Html5Qrcode("reader");
  const decoded=await state.qr.scanFile(file,true);
  await scanResult(decoded);
}

async function downloadXlsx(name,headers,rows) {
  if(!window.ExcelJS)throw new Error("Không tải được thư viện Excel.");
  const wb=new ExcelJS.Workbook();
  const sheet=wb.addWorksheet("Kho PU");
  sheet.addRow(headers);
  sheet.getRow(1).font={bold:true,color:{argb:"FFFFFFFF"}};
  sheet.getRow(1).fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF123B55"}};
  sheet.views=[{state:"frozen",ySplit:1}];
  for(const row of rows)sheet.addRow(row.map(v=>{
    if(typeof v==="string" && /^[=+\-@]/.test(v)) return "'"+v;
    return v;
  }));
  sheet.columns=headers.map(()=>({width:23}));
  const buffer=await wb.xlsx.writeBuffer();
  const url=URL.createObjectURL(new Blob([buffer],{type:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
  const a=document.createElement("a");a.href=url;a.download=name;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),3000);
}
function templateXlsx() {
  return downloadXlsx("mau_nhap_kho_PU.xlsx",
    ["Mã SAP","P/O","Số mét","Khu vực","Kệ","Ô","Mô tả"],
    [["PU00125","PO2026-001",100,"A","K01","Ô số 1","PU đen"],
     ["PU00125","PO2026-001",120,"A","K01","Ô số 1","PU đen"]]);
}
async function importXlsx(file) {
  if(!file)throw new Error("Hãy chọn file Excel .xlsx.");
  if(!/\.xlsx$/i.test(file.name))throw new Error("Chỉ hỗ trợ Excel .xlsx.");
  if(file.size>7*1024*1024)throw new Error("File Excel không được quá 7 MB.");
  const wb=new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const sheet=wb.worksheets[0];
  if(!sheet)throw new Error("File Excel không có trang tính.");
  const header=sheet.getRow(1).values.slice(1).map(s=>String(s??"").trim().toLowerCase());
  const names=["mã sap","p/o","số mét","khu vực","kệ","ô"];
  if(names.some(s=>!header.includes(s)))throw new Error("Thiếu cột Excel: "+names.filter(s=>!header.includes(s)).join(", "));
  const rows=[];
  for(let i=2;i<=sheet.rowCount;i++) {
    const row=sheet.getRow(i);
    if(row.cellCount===0 || !row.values.some(v=>String(v??"").trim()))continue;
    const get=name=>{
      const idx=header.indexOf(name);
      return idx<0?"":String(row.getCell(idx+1).text??"").trim();
    };
    const rec={sap:get("mã sap"),po:get("p/o"),meters:get("số mét"),
      area:get("khu vực"),rack:get("kệ"),bin:get("ô"),description:get("mô tả")};
    validateLocation(rec);
    checkText(rec.sap,"SAP dòng "+i,80);
    checkText(rec.po,"P/O dòng "+i,100);
    validMeters(rec.meters);
    rows.push(rec);
    if(rows.length>500)throw new Error("Mỗi lần chỉ nhập tối đa 500 cây.");
  }
  if(!rows.length)throw new Error("Không có đầu cây nào trong Excel.");
  const {data,error}=await state.client.rpc("kho_receive",{p_rows:rows});
  if(error)throw error;
  state.lastCodes=data||[];
  await refresh(false);
  await show("labels");
  toast("Đã nhập "+rows.length+" đầu cây và tạo mã QR!");
}

async function handleSubmit(form) {
  const data=new FormData(form);
  await doWork(async()=>{
    if(form.id==="login-form") {
      const {error}=await state.client.auth.signInWithPassword({
        email:field(data,"email"),password:field(data,"password")
      });
      if(error)throw error;
      await displayAfterLogin();
      return;
    }
    if(form.id==="inbound-form") {
      const common={sap:checkText(field(data,"sap"),"SAP",80),
        po:checkText(field(data,"po"),"P/O",100),
        description:field(data,"description").slice(0,300),
        area:field(data,"area"),rack:field(data,"rack"),bin:field(data,"bin")};
      validateLocation(common);
      const values=splitMeters(field(data,"lengths"));
      const rows=values.map(m=>({...common,meters:m}));
      const {data:codes,error}=await state.client.rpc("kho_receive",{p_rows:rows});
      if(error)throw error;
      state.lastCodes=codes||[];
      await refresh(false);
      await show("labels");
      toast("Đã tạo "+values.length+" cây PU và mã QR.");
    }
    if(form.id==="issue-form" || form.id==="quick-issue-form") {
      const code=field(data,"code");
      const amount=validMeters(field(data,"meters"));
      if(form.id==="quick-issue-form") {
        const selected=state.rolls.find(r=>r.roll_code===code);
        if(!selected || selected.po.toLocaleLowerCase("vi-VN")!==state.issuePo.trim().toLocaleLowerCase("vi-VN") ||
           selected.sap_items?.sap_code!==state.issueSap || selected.roll_code!==state.selectedIssue)
          throw new Error("Đầu cây không khớp P/O và SAP đang chọn. Hãy chọn lại cây.");
      }
      const {data:balance,error}=await state.client.rpc("kho_issue",{
        p_code:code,p_meters:amount,p_workshop:field(data,"workshop"),
        p_note:field(data,"note")
      });
      if(error)throw error;
      await refresh(false);
      if(form.id==="quick-issue-form")await show("issue",{code});
      else renderCurrent();
      toast("Đã xuất "+money(amount)+" m, còn "+money(balance)+" m.");
    }
    if(form.id==="move-form" || form.id==="location-form") {
      const info={area:field(data,"area"),rack:field(data,"rack"),bin:field(data,"bin")};
      validateLocation(info);
      const which=form.id==="move-form";
      const {data:answer,error}=which?
        await state.client.rpc("kho_move",{p_code:field(data,"code"),
          p_area:info.area,p_rack:info.rack,p_bin:info.bin}):
        await state.client.rpc("kho_create_location",{
          p_area:info.area,p_rack:info.rack,p_bin:info.bin});
      if(error)throw error;
      await refresh();
      toast(which?"Đã chuyển cây sang "+answer:"Đã tạo ô kho.");
    }
    if(form.id==="manual-scan-form")await scanResult(field(data,"code"));
  });
}
async function handleAction(button) {
  const act=button.dataset.action;
  const map={
    "scan-tab":"scan","rolls-tab":"rolls","inbound-tab":"inbound"
  };
  if(map[act]){await show(map[act]);return;}
  await doWork(async()=>{
    if(act==="refresh"){await refresh();toast("Đã cập nhật số liệu.");}
    if(act==="template"){await templateXlsx();}
    if(act==="import"){await importXlsx($("#import-file")?.files?.[0]);}
    if(act==="print-one"){
      state.lastCodes=[state.selected];await show("labels");
    }
    if(act==="print-labels")window.print();
    if(act==="start-scan")await startScanner();
    if(act==="stop-scan"){await stopScanner();if($("#camera-message"))$("#camera-message").textContent="Camera đã tắt.";}
    if(act==="export-stock") {
      await downloadXlsx("ton_tung_dau_cay_PU.xlsx",
        ["Mã cây","Mã SAP","P/O","Tên vật tư","Nhập (m)","Đã xuất (m)","Còn dư (m)","Khu vực","Kệ","Ô","Ngày nhập"],
        state.rolls.map(r=>[r.roll_code,r.sap_items?.sap_code,r.po,r.sap_items?.description,
          Number(r.initial_meters),Number(r.initial_meters)-Number(r.remaining_meters),
          Number(r.remaining_meters),r.locations?.area||"",r.locations?.rack||"",
          r.locations?.bin_name||"",time(r.created_at)]));
    }
    if(act==="export-history") {
      await downloadXlsx("lich_su_kho_PU.xlsx",
        ["Ngày giờ","Loại","Mã cây","Số mét","Phân xưởng","Ô cũ","Ô mới","Người thực hiện","Ghi chú"],
        state.movements.map(m=>[time(m.created_at),m.movement_type,
          state.rolls.find(r=>r.id===m.roll_id)?.roll_code||"",Number(m.meters),
          m.workshop,m.from_location,m.to_location,m.actor_email,m.note]));
    }
    if(act==="export-issue-ledger") {
      if(!state.issuePo.trim() || !state.issueSap)throw new Error("Hãy chọn P/O và SAP trước khi tải bảng kê.");
      await downloadXlsx("bang_ke_xuat_PU.xlsx",
        ["Thời gian","P/O","Mã SAP","Mã đầu cây","Mét đầu cây","Số mét xuất","Dư sau xuất","Phân xưởng","Người xuất"],
        issueLedger().map(m=>[time(m.created_at),m.roll.po,m.roll.sap_items?.sap_code,
          m.roll.roll_code,Number(m.roll.initial_meters),Number(m.meters),Number(m.remainingAfter),m.workshop,m.actor_email]));
    }
    if(act==="export-report") {
      await downloadXlsx("bao_cao_SAP_PO_PU.xlsx",
        ["Mã SAP","P/O","Số cây","Tổng nhập","Đã xuất","Còn dư"],
        summaryData().map(r=>[r.sap,r.po,r.count,r.initial,r.used,r.balance]));
    }
  });
}

document.addEventListener("click",async event=>{
  const tab=event.target.closest("[data-tab]");
  if(tab){await show(tab.dataset.tab);return;}
  const issue=event.target.closest("[data-issue-code]");
  if(issue){await show("issue",{code:issue.dataset.issueCode});return;}
  const all=event.target.closest("[data-issue-all]");
  if(all){const input=$("#quick-issue-form [name=meters]");if(input)input.value=all.dataset.issueAll;return;}
  const open=event.target.closest("[data-open]");
  if(open){event.preventDefault();await show("detail",{code:open.dataset.open});return;}
  const print=event.target.closest("[data-print]");
  if(print){state.lastCodes=[print.dataset.print];await show("labels");return;}
  const actionButton=event.target.closest("[data-action]");
  if(actionButton)await handleAction(actionButton);
});
document.addEventListener("submit",event=>{
  const form=event.target.closest("form");
  if(!form)return;
  event.preventDefault();
  handleSubmit(form);
});
document.addEventListener("input",event=>{
  if(event.target.id==="issue-po") {
    state.issuePo=event.target.value;
    state.issueSap="";
    state.selectedIssue=null;
    state.issueSearch="";
    const cursor=event.target.selectionStart;
    renderCurrent();
    const replacement=$("#issue-po");
    replacement?.focus();
    replacement?.setSelectionRange(cursor,cursor);
  }
  if(event.target.id==="search-rolls") {
    state.find=event.target.value;
    const cursor=event.target.selectionStart;
    renderCurrent();
    const replacement=$("#search-rolls");
    replacement?.focus();
    replacement?.setSelectionRange(cursor,cursor);
  }
  if(event.target.id==="issue-search") {
    state.issueSearch=event.target.value;
    const cursor=event.target.selectionStart;
    renderCurrent();
    const replacement=$("#issue-search");
    replacement?.focus();
    replacement?.setSelectionRange(cursor,cursor);
  }
});
document.addEventListener("change",event=>{
  if(event.target.id==="issue-sap") {
    state.issueSap=event.target.value;
    state.selectedIssue=null;
    renderCurrent();
  }
  if(event.target.dataset.filter) {
    const prop={area:"filterArea",rack:"filterRack",bin:"filterBin"}[event.target.dataset.filter];
    state[prop]=event.target.value;
    renderCurrent();
  }
  if(event.target.id==="qr-photo" && event.target.files?.[0]) {
    doWork(()=>scanPhoto(event.target.files[0]));
  }
});

async function displayAfterLogin() {
  const {data}=await state.client.auth.getSession();
  state.session=data.session;
  if(!state.session){
    $("#app-shell").hidden=true;
    $("#login-screen").hidden=false;
    return;
  }
  $("#login-screen").hidden=true;
  $("#app-shell").hidden=false;
  $("#signed-user").textContent=state.session.user.email||"Nhân viên";
  $("#loading").hidden=false;
  try {
    await refresh();
    $("#loading").hidden=true;
    const code=new URLSearchParams(location.search).get("roll");
    if(code){await show("detail",{code});}
  } catch(err) {
    $("#loading").hidden=true;
    $("#view").innerHTML=card('<h2>Không tải được dữ liệu kho</h2><p class="error-text">'+
      esc(err.message)+'</p><p class="hint">Hãy kiểm tra SQL đã chạy trong Supabase và cấu hình địa chỉ dự án.</p>');
  }
}
async function startup() {
  const cfg=window.PU_CONFIG||{};
  if(!cfg.supabaseUrl?.startsWith("https://") ||
     cfg.supabasePublishableKey?.startsWith("DAN_") || !window.supabase) {
    $("#setup-screen").hidden=false;
    return;
  }
  state.client=window.supabase.createClient(cfg.supabaseUrl,cfg.supabasePublishableKey);
  $("#signout").addEventListener("click",async()=>{
    await stopScanner();
    await state.client.auth.signOut();
    location.reload();
  });
  await displayAfterLogin();
  setInterval(async()=>{
    if(state.session && !state.busy && !state.qrRunning &&
       !["inbound","issue","scan","detail","labels"].includes(state.active)) {
      try{await refresh();}catch(_){}
    }
  },30000);
}
startup().catch(err=>{
  $("#setup-screen").hidden=false;
  toast("Lỗi khởi tạo website: "+err.message,true);
});
