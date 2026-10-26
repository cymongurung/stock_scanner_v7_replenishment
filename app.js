// Version shown on the Data Status page, so you can check the new file is live
const APP_VERSION = "v7 – Replenishment";

const STORAGE_KEY = "theDealInventoryV1";
const META_KEY = "theDealInventoryMetaV1";

let inventory = [];
let meta = {};
let scanner = null;
let scannerRunning = false;
let pendingUpload = null;
let activeVideoTrack = null;
let activeZoom = null;

// Voice Dictation state
let isVoiceEnabled = true;

const $ = id => document.getElementById(id);

function clean(v){ return (v ?? "").toString().trim(); }
function normalize(v){ return clean(v).replace(/^'/,"").replace(/\s+/g,""); }

function money(v){
  const n = Number(String(v).replace(/,/g,""));
  return Number.isFinite(n) ? "AED " + n.toLocaleString("en-AE",{minimumFractionDigits:2,maximumFractionDigits:2}) : clean(v) || "—";
}

function qty(v){
  const n = Number(String(v).replace(/,/g,""));
  return Number.isFinite(n) ? n.toLocaleString("en-AE") : clean(v) || "0";
}

// ---------- Link to The Deal website ----------
// If the site's search address is different, change only this line.
const DEAL_SEARCH_URL = "https://www.thedealoutlet.com/ae-en/search?q=";

function dealSearchLink(itemId){
  return DEAL_SEARCH_URL + encodeURIComponent(clean(itemId));
}

const DB_NAME = "TheDealStockScannerDB";
const DB_VERSION = 1;
const STORE_NAME = "inventory";

function openDB(){
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(STORE_NAME)){
        db.createObjectStore(STORE_NAME, {keyPath:"key"});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function save(){
  const db = await openDB();
  await new Promise((resolve,reject)=>{
    const tx = db.transaction(STORE_NAME,"readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({key:"inventory", value:inventory});
    store.put({key:"meta", value:meta});
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function loadSaved(){
  try{
    const db = await openDB();
    const result = await new Promise((resolve,reject)=>{
      const tx = db.transaction(STORE_NAME,"readonly");
      const store = tx.objectStore(STORE_NAME);
      const req1 = store.get("inventory");
      const req2 = store.get("meta");
      tx.oncomplete = () => resolve({
        inventory:req1.result?.value || [],
        meta:req2.result?.value || {}
      });
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    if(Array.isArray(result.inventory) && result.inventory.length){
      inventory=result.inventory;
      meta=result.meta;
      return true;
    }
  }catch(e){
    console.error("IndexedDB load error:",e);
  }
  return false;
}

function updateHeader(){
  $("topDate").textContent = meta.stockDate
    ? `Current data: ${meta.stockDate} • ${inventory.length.toLocaleString()} rows`
    : "No data loaded";
  renderStatus();
}

function parseCSVLine(line){
  const out = [];
  let field = "";
  let quoted = false;

  for(let i=0;i<line.length;i++){
    const ch = line[i];
    if(ch === '"'){
      if(quoted && line[i+1] === '"'){
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if(ch === "," && !quoted){
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

function parseCSV(text){
  const rows = [];
  let line = "";
  let quoted = false;

  for(let i=0;i<text.length;i++){
    const ch = text[i];
    if(ch === '"'){
      if(quoted && text[i+1] === '"'){
        line += '""';
        i++;
      } else {
        quoted = !quoted;
        line += ch;
      }
    } else if((ch === "\n" || ch === "\r") && !quoted){
      if(line.length || (rows.length && rows[rows.length-1].length)){
        rows.push(parseCSVLine(line));
      }
      line = "";
      if(ch === "\r" && text[i+1] === "\n") i++;
    } else {
      line += ch;
    }
  }
  if(line.length) rows.push(parseCSVLine(line));
  return rows;
}

function parseStoreCSV(text, filename){
  const rows = parseCSV(text);
  const headerIndex = rows.findIndex(r =>
    r.some(c => clean(c).toLowerCase() === "product id")
  );
  if(headerIndex < 0) throw new Error("Could not find the Product ID header in this CSV.");

  const headers = rows[headerIndex].map(clean);
  const body = rows.slice(headerIndex+1).filter(r => r.some(clean));
  const idx = {};
  headers.forEach((h,i)=>idx[h]=i);

  const get = (row, name) => row[idx[name]] ?? "";
  const data = body.map(r => ({
    stockDate: clean(get(r,"Stock Date")),
    productId: normalize(get(r,"Product ID")),
    description: clean(get(r,"Product Description w/o vpn")),
    zone: clean(get(r,"Zone Description")),
    department: clean(get(r,"Department")),
    brand: clean(get(r,"Brand")),
    barcode: normalize(get(r,"Barcode")),
    vpn: clean(get(r,"VPN")),
    retailPrice: clean(get(r,"Retail Selling Price Local")),
    consignment: clean(get(r,"Is Consignment? (Yes / No)")),
    season: clean(get(r,"Season")),
    wac: clean(get(r,"WAC in USD")),
    sold: clean(get(r,"Total Quantity Sold")),
    closingSoh: clean(get(r,"Daily closing SOH quantity")),
    closingValue: clean(get(r,"Daily closing SOH Local Retail Value"))
  })).filter(x => x.productId || x.barcode);

  if(!data.length) throw new Error("No product records were found.");
  const stockDate = data.find(x=>x.stockDate)?.stockDate || "";
  return {data, stockDate, filename, headers};
}

async function loadInitial(){
  if(await loadSaved()){ updateHeader(); return; }
  fetch("data/current.csv")
    .then(r => { if(!r.ok) throw new Error("Initial CSV not found"); return r.text(); })
    .then(async text => {
      const result = parseStoreCSV(text,"data/current.csv");
      inventory = result.data;
      meta = {stockDate:result.stockDate, filename:result.filename, uploadedAt:new Date().toISOString()};
      await save();
      updateHeader();
      toast("Today's inventory loaded");
    })
    .catch(err=>{ console.error(err); updateHeader(); });
}

function findProduct(term){
  const q = normalize(term);
  if(!q) return [];
  return inventory.filter(x => normalize(x.barcode) === q || normalize(x.productId) === q);
}

// Voice Dictation Helper Function
function speakPrice(priceVal) {
  if (!isVoiceEnabled || !('speechSynthesis' in window)) return;
  
  // Cancel any ongoing speech
  window.speechSynthesis.cancel();

  const num = Number(String(priceVal).replace(/,/g, ""));
  let textToSpeak = "";
  
  if (Number.isFinite(num)) {
    textToSpeak = `Price is ${Math.round(num)} dirhams`;
  } else {
    textToSpeak = "Price not available";
  }

  const utterance = new SpeechSynthesisUtterance(textToSpeak);
  utterance.rate = 0.95;
  utterance.pitch = 1.0;
  window.speechSynthesis.speak(utterance);
}

// ---------- Size grid (size is the 2nd part of the description, e.g. ADS.CBWHGO:7:GAZELLE) ----------
const SIZE_ORDER = ["XXXS","XXS","XS","S","M","L","XL","XXL","XXXL","3XL","4XL","OS","TU"];
function sizeOf(x){ const m = clean(x.description).match(/^[^:]+:([^:]*):/); return m ? m[1].trim() : ""; }
function sizeRank(s){
  const i = SIZE_ORDER.indexOf(s.toUpperCase());
  if(i >= 0) return [0, i];
  if(/^[\d.]+$/.test(s)) return [1, parseFloat(s)];
  return [2, 0];
}
function sizeItemsFor(product){
  if(!product.vpn) return [];
  return inventory.filter(x => x.vpn === product.vpn && sizeOf(x)).sort((a,b) => {
    const ra = sizeRank(sizeOf(a)), rb = sizeRank(sizeOf(b));
    return ra[0]-rb[0] || ra[1]-rb[1] || sizeOf(a).localeCompare(sizeOf(b));
  });
}
function sizeGridHtml(product, items){
  if(items.length < 2) return "";
  return `<div class="size-grid"><label>Sizes in this color — tap for details</label><div class="size-chips">${
    items.map((x,i) => {
      const q = Number(String(x.closingSoh).replace(/,/g,"")) || 0;
      return `<button class="size-chip ${q>0?"in":"out"} ${x.productId===product.productId?"current":""}" data-i="${i}"><b>${esc(sizeOf(x))}</b><small>${q}</small></button>`;
    }).join("")
  }</div></div>`;
}

function showProduct(product){
  const related = inventory.filter(x => x.vpn && x.vpn === product.vpn);
  const sizeItems = sizeItemsFor(product);
  
  // Determine consignment / supplier text
  const consignmentVal = (product.consignment || "").toLowerCase();
  const isSupplier = (consignmentVal === "yes" || consignmentVal === "y") ? "Yes (Consignment)" : "No";

  // Trigger voice dictation
  speakPrice(product.retailPrice);

  $("resultArea").innerHTML = `
    <div class="result-card">
      <div class="result-head">
        <h2>${esc(product.description || "Product found")}</h2>
        <p>${esc(product.brand || "")} ${product.department ? "• "+esc(product.department):""}</p>
      </div>
      <div class="metrics">
        <div class="metric"><label>Retail Price</label><strong>${money(product.retailPrice)}</strong></div>
        <div class="metric"><label>Daily Closing SOH</label><strong>${qty(product.closingSoh)}</strong></div>
        <div class="metric"><label>VPN</label><strong>${esc(product.vpn || "—")}</strong></div>
      </div>
      ${sizeGridHtml(product, sizeItems)}
      <div class="details">
        <div class="detail-row"><span>Product ID</span><strong>${
          product.productId
            ? `<a class="deal-link" href="${esc(dealSearchLink(product.productId))}" target="_blank" rel="noopener">${esc(product.productId)} ↗</a>`
            : "—"
        }</strong></div>
        <div class="detail-row"><span>Barcode</span><strong>${esc(product.barcode)}</strong></div>
        <div class="detail-row"><span>Supplier / Consignment Item</span><strong>${esc(isSupplier)}</strong></div>
        <div class="detail-row"><span>Description</span><strong>${esc(product.description)}</strong></div>
        <div class="detail-row"><span>Brand</span><strong>${esc(product.brand)}</strong></div>
        <div class="detail-row"><span>Department</span><strong>${esc(product.department)}</strong></div>
      </div>
      <div class="actions">
        <button class="primary" id="relatedYes" ${related.length <= 1 ? "disabled":""}>YES — Related Items (${Math.max(related.length-1,0)})</button>
        <button class="primary" id="colorsBtn" ${colorGroups(product).length <= 1 ? "disabled":""}>COLORS (${colorGroups(product).length})</button>
        <button class="secondary" id="clearResult">NO / Next Scan</button>
      </div>
      <div class="related" id="relatedArea"></div>
    </div>`;
  document.querySelectorAll("#resultArea .size-chip").forEach(b =>
    b.addEventListener("click", () => { showProduct(sizeItems[Number(b.dataset.i)]); $("resultArea").scrollIntoView({behavior:"smooth", block:"start"}); }));
  $("relatedYes").addEventListener("click",()=>showRelated(product));
  $("colorsBtn").addEventListener("click",()=>showColors(product));
  $("clearResult").addEventListener("click",()=>clearResult());
}

function itemsTable(list){
  const rows = list.map(x => `
    <tr>
      <td>${esc(x.productId)}</td>
      <td>${esc(x.barcode)}</td>
      <td>${esc(x.description)}</td>
      <td>${money(x.retailPrice)}</td>
      <td class="soh ${Number(x.closingSoh)===0?'zero':'positive'}">${qty(x.closingSoh)}</td>
    </tr>`).join("");
  return `<div class="table-wrap"><table>
      <thead><tr><th>Product ID</th><th>Barcode</th><th>Product Description</th><th>Retail Price</th><th>Daily Closing SOH</th></tr></thead>
      <tbody>${rows || "<tr><td colspan='5'>No related items found.</td></tr>"}</tbody>
    </table></div>`;
}

function showRelated(product){
  const related = inventory.filter(x => x.vpn && x.vpn === product.vpn);
  $("relatedArea").innerHTML = `<h3>Related Items — Same VPN</h3>` + itemsTable(related);
}

// ---------- Colors: same style, different colour (VPN = STYLE-COLOR) ----------
function vpnStyle(v){
  const s = clean(v); const i = s.indexOf("-");
  if(i <= 0) return "";
  // Normally the style is the first part (e.g. S0940651 in S0940651-861-JADE).
  // Very short first parts are too generic, so use everything before the last dash instead.
  if(i >= 5) return s.slice(0,i);
  const j = s.lastIndexOf("-");
  return s.slice(0,j);
}
function vpnColor(v){ const s = clean(v); const i = s.lastIndexOf("-"); return i > 0 ? s.slice(i+1) : ""; }

function colorGroups(product){
  const style = vpnStyle(product.vpn);
  if(!style) return [];
  const map = new Map();
  inventory.forEach(x => {
    if(x.brand !== product.brand || vpnStyle(x.vpn) !== style) return;
    const g = map.get(x.vpn) || {vpn:x.vpn, color:vpnColor(x.vpn), soh:0, sizes:0};
    g.soh += Number(String(x.closingSoh).replace(/,/g,"")) || 0;
    g.sizes++;
    map.set(x.vpn, g);
  });
  const list = [...map.values()];
  // if two colours end with the same code, show the longer part of the VPN so they can be told apart
  const count = {};
  list.forEach(g => count[g.color] = (count[g.color]||0) + 1);
  list.forEach(g => { if(count[g.color] > 1) g.color = g.vpn.slice(style.length + 1); });
  // this item's colour first, then in-stock colours, then the rest
  return list.sort((a,b) =>
    (b.vpn===product.vpn) - (a.vpn===product.vpn) ||
    (b.soh>0) - (a.soh>0) ||
    a.color.localeCompare(b.color));
}

function showColors(product){
  const groups = colorGroups(product);
  $("relatedArea").innerHTML = `
    <h3>Colors — Style ${esc(vpnStyle(product.vpn))}</h3>
    <div class="kw-list" style="padding:0">${groups.map((g,i)=>`
      <button class="kw-item" data-i="${i}">
        <span class="kw-main">
          <strong>${esc(g.color)}</strong>
          <small class="${g.vpn===product.vpn?'this':''}">${g.vpn===product.vpn?"This item's color • ":""}${esc(g.vpn)}</small>
        </span>
        <span class="kw-side">
          <strong>SOH ${qty(g.soh)}</strong>
          <small>${g.sizes} size${g.sizes===1?"":"s"}</small>
        </span>
      </button>`).join("")}</div>`;
  document.querySelectorAll("#relatedArea .kw-item").forEach(b =>
    b.addEventListener("click", () => showColorItems(product, groups[Number(b.dataset.i)])));
  $("relatedArea").scrollIntoView({behavior:"smooth", block:"start"});
}

function showColorItems(product, g){
  const list = inventory.filter(x => x.vpn === g.vpn);
  $("relatedArea").innerHTML = `
    <button class="secondary" id="colorsBack" style="margin:0 0 12px">← Back to colors</button>
    <h3>Color ${esc(g.color)} — ${esc(g.vpn)}</h3>` + itemsTable(list);
  $("colorsBack").addEventListener("click", () => showColors(product));
  $("relatedArea").scrollIntoView({behavior:"smooth", block:"start"});
}

function search(){
  const term = $("searchInput").value;
  const matches = findProduct(term);
  if(matches.length === 1){ showProduct(matches[0]); return; }
  if(matches.length > 1){
    $("resultArea").innerHTML = `<div class="result-card"><div class="result-head"><h2>Multiple matches</h2><p>Please select a product.</p></div><div class="details">${
      matches.map((x,i)=>`<button class="secondary select-match" data-i="${i}" style="display:block;width:100%;margin:8px 0;text-align:left">
        ${esc(x.productId)} • ${esc(x.barcode)} • ${esc(x.description)} • SOH ${qty(x.closingSoh)}
      </button>`).join("")
    }</div></div>`;
    document.querySelectorAll(".select-match").forEach(b=>b.addEventListener("click",()=>showProduct(matches[Number(b.dataset.i)])));
    return;
  }
  $("resultArea").innerHTML = `<div class="result-card"><div class="result-head"><h2>Not found</h2><p>No matching Barcode or Product ID was found in the current inventory.</p></div></div>`;
}

// ---------- Manual keyword lookup ----------
const KEYWORD_MAX_RESULTS = 50;

function keywordSearch(){
  const words = clean($("keywordInput").value).toLowerCase().split(/\s+/).filter(Boolean);
  if(!words.length){ $("resultArea").innerHTML = ""; return; }

  // Every typed word must appear somewhere (partial match, any order)
  const matches = inventory.filter(x => {
    const hay = `${x.description} ${x.brand} ${x.vpn}`.toLowerCase();
    return words.every(w => hay.includes(w));
  });

  // In-stock items first, then alphabetical
  matches.sort((a,b) => {
    const sa = Number(String(a.closingSoh).replace(/,/g,"")) > 0 ? 0 : 1;
    const sb = Number(String(b.closingSoh).replace(/,/g,"")) > 0 ? 0 : 1;
    return sa - sb || a.description.localeCompare(b.description);
  });

  if(!matches.length){
    $("resultArea").innerHTML = `<div class="result-card"><div class="result-head"><h2>No matches</h2><p>Nothing found for "${esc(words.join(" "))}". Try fewer or shorter keywords.</p></div></div>`;
    return;
  }

  const shown = matches.slice(0, KEYWORD_MAX_RESULTS);
  $("resultArea").innerHTML = `
    <div class="result-card">
      <div class="result-head">
        <h2>${matches.length.toLocaleString()} item${matches.length===1?"":"s"} found</h2>
        <p>${matches.length > shown.length ? `Showing first ${shown.length} — add more keywords to narrow down.` : "Tap an item to see details."}</p>
      </div>
      <div class="details kw-list">
        ${shown.map((x,i)=>`
          <button class="kw-item" data-i="${i}">
            <span class="kw-main">
              <strong>${esc(x.description || x.productId)}</strong>
              <small>${esc(x.brand)}${x.brand&&x.productId?" • ":""}${esc(x.productId)}</small>
            </span>
            <span class="kw-side">
              <strong>${money(x.retailPrice)}</strong>
              <small class="${Number(String(x.closingSoh).replace(/,/g,""))>0?'positive':'zero'}">SOH ${qty(x.closingSoh)}</small>
            </span>
          </button>`).join("")}
      </div>
    </div>`;
  document.querySelectorAll(".kw-item").forEach(b => b.addEventListener("click", () => openKeywordResult(shown[Number(b.dataset.i)])));
}

function openKeywordResult(product){
  showProduct(product);
  const head = document.querySelector("#resultArea .result-card");
  if(head){
    const back = document.createElement("button");
    back.className = "secondary kw-back";
    back.textContent = "← Back to results";
    back.addEventListener("click", keywordSearch);
    head.insertBefore(back, head.firstChild);
  }
  $("resultArea").scrollIntoView({behavior:"smooth", block:"start"});
}

let keywordTimer = null;
$("keywordBtn").addEventListener("click", keywordSearch);
$("keywordInput").addEventListener("keydown", e => { if(e.key==="Enter") keywordSearch(); });
$("keywordInput").addEventListener("input", () => {
  clearTimeout(keywordTimer);
  keywordTimer = setTimeout(() => { if(clean($("keywordInput").value).length >= 2) keywordSearch(); }, 350);
});

function clearResult(){ $("resultArea").innerHTML=""; $("searchInput").value=""; $("keywordInput").value=""; $("searchInput").focus(); }

function esc(v){
  return String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function updateZoomLabel(text){
  const el=document.getElementById("zoomStatus");
  if(el) el.textContent=text;
}

function setScannerZoom(){
  const video=document.querySelector("#reader video");
  if(!video || !video.srcObject) return;
  const tracks=video.srcObject.getVideoTracks();
  if(!tracks.length) return;
  const track=tracks[0];
  activeVideoTrack=track;
  const capabilities=track.getCapabilities ? track.getCapabilities() : {};
  if(Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("continuous")){
    track.applyConstraints({advanced:[{focusMode:"continuous"}]}).catch(()=>{});
  }
  if(!capabilities.zoom){ activeZoom=null; updateZoomLabel("Zoom: not supported by this camera/browser"); return; }
  const min=Number(capabilities.zoom.min ?? 1), max=Number(capabilities.zoom.max ?? min), step=Number(capabilities.zoom.step ?? 0.1);
  let target=max >= 2 ? 2 : max;
  target=Math.max(min,Math.min(max,target));
  if(step>0){ target=min+Math.round((target-min)/step)*step; target=Math.max(min,Math.min(max,target)); }
  track.applyConstraints({advanced:[{zoom:target}]})
    .then(()=>{ activeZoom=target; updateZoomLabel(`Zoom: ${Number(target).toFixed(target%1?1:0)}×`); })
    .catch(()=>updateZoomLabel("Zoom: camera default"));
}

const SUPPORTED_FORMATS = ["EAN_13","EAN_8","UPC_A","UPC_E","CODE_128","CODE_39"];

function openCamera(){
  if(scannerRunning) return;
  $("reader").classList.remove("hidden");
  $("openScanner").textContent="✕ Close Scanner";
  updateZoomLabel("Opening camera… Default zoom: 2×");
  if(typeof Html5Qrcode === "undefined"){
    $("reader").classList.add("hidden");
    $("openScanner").textContent="📷 Scan Barcode";
    updateZoomLabel("Scanner library did not load");
    toast("Scanner library could not load. Check internet and refresh the page.");
    return;
  }
  // Use the phone's built-in barcode detector when available (much better for EAN/UPC); falls back automatically
  scanner=new Html5Qrcode("reader", {
    verbose:false,
    experimentalFeatures:{useBarCodeDetectorIfSupported:true}
  });
  scanner.start(
    {facingMode:"environment"},
    {
      fps:15,
      // wide, short box that suits 1D barcodes and adapts to screen size
      qrbox:(w,h)=>({width:Math.floor(Math.min(w*0.9,420)), height:Math.floor(Math.min(h*0.5,180))}),
      // higher resolution = sharper bars, which is what makes small barcodes readable
      videoConstraints:{facingMode:"environment", width:{ideal:1920}, height:{ideal:1080}}
    },
    (code,result)=>{
      // Accept only the supported retail barcode formats; ignore anything else and keep scanning
      const fmt = result?.result?.format?.formatName;
      if(fmt && !SUPPORTED_FORMATS.includes(fmt)) return;
      stopCamera(); $("searchInput").value=code; search(); toast("Barcode scanned");
    },
    ()=>{}
  ).then(()=>{
    scannerRunning=true;
    setScannerZoom();
    setTimeout(setScannerZoom,250);
    setTimeout(setScannerZoom,800);
  }).catch(err=>{
    $("reader").classList.add("hidden");
    $("openScanner").textContent="📷 Scan Barcode";
    updateZoomLabel("Camera unavailable");
    toast("Camera could not be opened. Check browser camera permission.");
    console.error(err);
  });
}

function stopCamera(){
  if(scanner && scannerRunning){
    scanner.stop().catch(()=>{}).finally(()=>{ scannerRunning=false; activeVideoTrack=null; activeZoom=null; });
  } else { activeVideoTrack=null; activeZoom=null; }
  $("reader").classList.add("hidden");
  $("openScanner").textContent="📷 Scan Barcode";
  updateZoomLabel("Camera closed");
}

function renderStatus(){
  const totalSoh = inventory.reduce((s,x)=>s+(Number(String(x.closingSoh).replace(/,/g,""))||0),0);
  const totalValue = inventory.reduce((s,x)=>s+(Number(String(x.closingValue).replace(/,/g,""))||0),0);
  $("statusGrid").innerHTML = `
    <div class="status-item"><small>Status</small><strong>● Current</strong></div>
    <div class="status-item"><small>Stock Date</small><strong>${esc(meta.stockDate||"—")}</strong></div>
    <div class="status-item"><small>Rows / SKUs</small><strong>${inventory.length.toLocaleString()}</strong></div>
    <div class="status-item"><small>Total Closing SOH</small><strong>${totalSoh.toLocaleString()}</strong></div>
    <div class="status-item"><small>Total Retail Stock Value</small><strong>${money(totalValue)}</strong></div>
    <div class="status-item"><small>App Version</small><strong>${APP_VERSION}</strong></div>
    <div class="status-item"><small>File</small><strong style="font-size:13px;word-break:break-word">${esc(meta.filename||"—")}</strong></div>`;
}

function toast(msg){
  const t=$("toast"); t.textContent=msg; t.classList.add("show");
  clearTimeout(window.__toast); window.__toast=setTimeout(()=>t.classList.remove("show"),2500);
}

function showPage(page){
  document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));
  document.querySelectorAll(".nav").forEach(n=>n.classList.remove("active"));
  $(`${page}Page`).classList.add("active");
  document.querySelector(`.nav[data-page="${page}"]`).classList.add("active");
  const titles = {scanner:"Stock Scanner", upload:"Upload Data", qr:"QR Code Maker", status:"Data Status", analyze:"Analyze Data", replenish:"Replenishment"};
  $("pageTitle").textContent = titles[page] || "Stock Scanner";
  if(page==="status") renderStatus();
  if(page==="analyze") openAnalyze();
  $("sidebar").classList.remove("open"); $("backdrop").classList.remove("show");
}

// Voice Toggle Handler
$("voiceToggle").addEventListener("click", () => {
  isVoiceEnabled = !isVoiceEnabled;
  const btn = $("voiceToggle");
  if (isVoiceEnabled) {
    btn.classList.add("active");
    btn.textContent = "🔊 Voice: ON";
    toast("Voice dictation enabled");
  } else {
    btn.classList.remove("active");
    btn.textContent = "🔇 Voice: OFF";
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    toast("Voice dictation muted");
  }
});

$("searchBtn").addEventListener("click",search);
$("searchInput").addEventListener("keydown",e=>{if(e.key==="Enter")search();});
$("openScanner").addEventListener("click",()=>scannerRunning?stopCamera():openCamera());
$("chooseFile").addEventListener("click",()=>$("csvFile").click());
$("csvFile").addEventListener("change",e=>e.target.files[0]&&handleUpload(e.target.files[0]));
$("confirmReplace").addEventListener("click",confirmUpload);
$("cancelReplace").addEventListener("click",cancelUpload);

$("dropzone").addEventListener("dragover",e=>{e.preventDefault();$("dropzone").style.borderColor="#111827";});
$("dropzone").addEventListener("dragleave",()=>$("dropzone").style.borderColor="");
$("dropzone").addEventListener("drop",e=>{e.preventDefault();$("dropzone").style.borderColor="";const f=e.dataTransfer.files[0];if(f)handleUpload(f);});
document.querySelectorAll(".nav").forEach(n=>n.addEventListener("click",()=>showPage(n.dataset.page)));
$("menuBtn").addEventListener("click",()=>{$("sidebar").classList.add("open");$("backdrop").classList.add("show");});
$("backdrop").addEventListener("click",()=>{$("sidebar").classList.remove("open");$("backdrop").classList.remove("show");});

function handleUpload(file){
  if(!file.name.toLowerCase().endsWith(".csv")){
    return uploadMsg("Please select a CSV file.","error");
  }
  const reader = new FileReader();
  reader.onload = e => {
    try{
      const result = parseStoreCSV(e.target.result,file.name);
      pendingUpload = result;
      $("currentUploadInfo").textContent =
        meta.stockDate ? `${meta.stockDate} • ${inventory.length.toLocaleString()} rows` : "No current inventory";
      let newInfo = `${result.stockDate || "Date not detected"} • ${result.data.length.toLocaleString()} rows`;
      if(meta.stockDate && result.stockDate && result.stockDate < meta.stockDate) newInfo += " ⚠ Older date";
      $("newUploadInfo").textContent = newInfo;
      $("newFileInfo").textContent = file.name;
      $("replaceModal").classList.remove("hidden");
    }catch(err){
      uploadMsg(err.message || "Could not process the CSV.","error");
    }
  };
  reader.onerror = () => uploadMsg("The browser could not read this file.","error");
  reader.readAsText(file);
}

async function confirmUpload(){
  if(!pendingUpload) return;
  const result = pendingUpload;
  inventory = result.data;
  meta = {stockDate:result.stockDate,filename:result.filename,uploadedAt:new Date().toISOString()};
  try{
    await save();
    updateHeader();
    $("replaceModal").classList.add("hidden");
    pendingUpload = null;
    $("csvFile").value = "";
    uploadMsg(`✓ Inventory replaced successfully. ${inventory.length.toLocaleString()} product rows loaded for ${result.stockDate || "the supplied date"}.`, "success");
    toast("Inventory updated");
  }catch(err){
    uploadMsg("The file was read, but the browser could not save the inventory. Please use a normal HTTPS website (such as GitHub Pages) and try again.", "error");
    console.error(err);
  }
}

function cancelUpload(){
  pendingUpload = null;
  $("replaceModal").classList.add("hidden");
  $("csvFile").value = "";
}

function uploadMsg(text,type){
  const m=$("uploadMessage");m.textContent=text;m.className="message "+(type==="error"?"error":"");m.classList.remove("hidden");
}

// ---------- QR Code Maker ----------
const QR_API = "https://qrcode.tec-it.com/API/QRCode";
let qrUrl = "";

function qrMake(){
  const text = $("qrInput").value.trim();
  if(!text){ toast("Paste item details or barcode first"); return; }
  qrUrl = `${QR_API}?data=${encodeURIComponent(text)}&backcolor=%23ffffff`;
  const img = $("qrImg");
  img.onerror = () => { toast("Could not load QR code. Check your internet connection."); $("qrPreview").classList.add("hidden"); };
  img.src = qrUrl;
  $("qrCaption").textContent = text.length > 80 ? text.slice(0,80) + "…" : text;
  $("qrPreview").classList.remove("hidden");
}

function qrCancel(){
  $("qrPreview").classList.add("hidden");
  $("qrImg").removeAttribute("src");
  $("qrInput").value = "";
  qrUrl = "";
}

async function qrSave(){
  if(!qrUrl) return;
  try{
    const res = await fetch(qrUrl);
    if(!res.ok) throw new Error("Download failed");
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "qr-code.png";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
    toast("QR code saved");
  }catch(e){
    // Fallback if the browser blocks the direct download: open the image so it can be saved manually
    window.open(qrUrl, "_blank");
    toast("Press and hold the image to save it");
  }
}

$("qrMake").addEventListener("click", qrMake);
$("qrCancel").addEventListener("click", qrCancel);
$("qrSave").addEventListener("click", qrSave);

// ---------- Analyze Data ----------
// Your CSV has Department but no Division, so departments are grouped into divisions here.
// To change a group, edit this list. Anything not listed becomes "Other".
const DIVISION_MAP = {
  "APPAREL":"Apparel", "INTIMATE":"Apparel", "APPAREL COMPLEMENTS":"Apparel", "NURSERY":"Apparel", "BATH & BEACHWEAR":"Apparel",
  "FOOTWEAR":"Footwear",
  "LEATHER GOODS & LUGGAGE":"Accessories", "EYE WEAR":"Accessories", "WATCHES":"Accessories", "JEWELRY":"Accessories", "COSTUME JEWELRY":"Accessories",
  "FRAGRANCES":"Beauty", "MAKE UP":"Beauty", "SKINCARE":"Beauty", "TOILETRIES":"Beauty", "HAIR CARE":"Beauty", "BEAUTY SET":"Beauty", "AMBIENT SCENTS":"Beauty",
  "DECORATION":"Home", "TABLE STYLE":"Home", "LINENS":"Home"
};
// Departments (and the store's own "THE DEAL" brand: bags, boxes) that are not real items for sale, so they would always look "cheapest"
const NON_SALE_DEPTS = ["PLV","GWP","SERVICE MATERIAL"];
const ANALYZE_PAGE_SIZE = 50;
let analyzeRows = [];
let analyzeLimit = ANALYZE_PAGE_SIZE;

function num(v){ return Number(String(v ?? "").replace(/,/g,"")) || 0; }
function divisionOf(x){ return DIVISION_MAP[clean(x.department).toUpperCase()] || "Other"; }
function isNonSale(x){ return NON_SALE_DEPTS.includes(clean(x.department).toUpperCase()) || clean(x.brand).toUpperCase() === "THE DEAL"; }
function uniqSorted(arr){ return [...new Set(arr.filter(Boolean))].sort((a,b)=>a.localeCompare(b)); }

function fillSelect(id, values, allLabel){
  const sel = $(id), old = sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` + values.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join("");
  sel.value = values.includes(old) ? old : "";
}

// Division -> Category -> Brand lists narrow each other, like an online shop
function refreshAnalyzeOptions(){
  let list = $("anHideNonSale").checked ? inventory.filter(x => !isNonSale(x)) : inventory;
  fillSelect("anDivision", uniqSorted(list.map(divisionOf)), "All divisions");
  const div = $("anDivision").value;
  if(div) list = list.filter(x => divisionOf(x) === div);
  fillSelect("anDepartment", uniqSorted(list.map(x => clean(x.department))), "All categories");
  const dep = $("anDepartment").value;
  if(dep) list = list.filter(x => clean(x.department) === dep);
  fillSelect("anBrand", uniqSorted(list.map(x => clean(x.brand))), "All brands");
}

function runAnalyze(resetLimit = true){
  if(resetLimit) analyzeLimit = ANALYZE_PAGE_SIZE;
  if(!inventory.length){
    $("analyzeResult").innerHTML = `<div class="result-card"><div class="result-head"><h2>No data yet</h2><p>Upload today's SOH file first.</p></div></div>`;
    return;
  }
  const div = $("anDivision").value, dep = $("anDepartment").value, brand = $("anBrand").value;
  const minP = $("anMin").value === "" ? null : Number($("anMin").value);
  const maxP = $("anMax").value === "" ? null : Number($("anMax").value);
  const inStock = $("anInStock").checked, hide = $("anHideNonSale").checked, group = $("anGroup").checked;
  const cons = $("anConsign").value, sort = $("anSort").value;

  const items = inventory.filter(x => {
    if(hide && isNonSale(x)) return false;
    if(div && divisionOf(x) !== div) return false;
    if(dep && clean(x.department) !== dep) return false;
    if(brand && clean(x.brand) !== brand) return false;
    const p = num(x.retailPrice);
    if(minP !== null && p < minP) return false;
    if(maxP !== null && p > maxP) return false;
    if(inStock && num(x.closingSoh) <= 0) return false;
    const isCons = clean(x.consignment).toLowerCase() === "yes";
    if(cons === "only" && !isCons) return false;
    if(cons === "exclude" && isCons) return false;
    return true;
  });

  // Group sizes of the same style+colour (same VPN) into one row
  const map = new Map();
  items.forEach(x => {
    const key = group && x.vpn ? "v:" + x.vpn : "p:" + x.productId + "|" + x.barcode;
    const price = num(x.retailPrice);
    const r = map.get(key) || {item:x, price, stock:0, sold:0, sizes:0};
    if(price < r.price){ r.item = x; r.price = price; }
    r.stock += num(x.closingSoh);
    r.sold += num(x.sold);
    r.sizes++;
    map.set(key, r);
  });
  analyzeRows = [...map.values()];

  const byName = (a,b) => clean(a.item.description).localeCompare(clean(b.item.description));
  analyzeRows.sort((a,b) =>
    sort === "expensive" ? (b.price - a.price || byName(a,b)) :
    sort === "stock"     ? (b.stock - a.stock || a.price - b.price) :
    sort === "sold"      ? (b.sold - a.sold || a.price - b.price) :
                           (a.price - b.price || byName(a,b)));

  renderAnalyze();
}

function renderAnalyze(){
  const total = analyzeRows.length;
  if(!total){
    $("analyzeResult").innerHTML = `<div class="result-card"><div class="result-head"><h2>No items match</h2><p>Try removing a filter or widening the price range.</p></div></div>`;
    return;
  }
  const shown = analyzeRows.slice(0, analyzeLimit);
  const label = {cheap:"cheapest", expensive:"most expensive", stock:"highest stock", sold:"most sold"}[$("anSort").value];
  $("analyzeResult").innerHTML = `
    <div class="result-card">
      <div class="result-head">
        <h2>${total.toLocaleString()} ${$("anGroup").checked ? "style" : "item"}${total===1?"":"s"} found</h2>
        <p>Showing the ${esc(label)} ${shown.length}${total > shown.length ? " of " + total.toLocaleString() : ""}.</p>
      </div>
      <div class="details kw-list">
        ${shown.map((r,i) => `
          <button class="kw-item" data-i="${i}">
            <span class="kw-main">
              <strong>${esc(r.item.description || r.item.productId)}</strong>
              <small>${esc(r.item.brand)} • ${esc(r.item.department)}${r.sizes>1 ? ` • <span class="sizes">${r.sizes} sizes</span>` : ""}</small>
            </span>
            <span class="kw-side">
              <strong>${money(r.price)}</strong>
              <small class="${r.stock>0?'positive':'zero'}">SOH ${qty(r.stock)}</small>
            </span>
          </button>`).join("")}
      </div>
      ${total > shown.length ? `<button class="secondary an-more" id="anMore">Show ${Math.min(ANALYZE_PAGE_SIZE, total - shown.length)} more</button>` : ""}
    </div>`;
  document.querySelectorAll("#analyzeResult .kw-item").forEach(b => b.addEventListener("click", () => openAnalyzeItem(shown[Number(b.dataset.i)].item)));
  const more = $("anMore");
  if(more) more.addEventListener("click", () => { analyzeLimit += ANALYZE_PAGE_SIZE; renderAnalyze(); });
}

function openAnalyzeItem(product){
  showPage("scanner");
  showProduct(product);
  const card = document.querySelector("#resultArea .result-card");
  if(card){
    const back = document.createElement("button");
    back.className = "secondary kw-back";
    back.textContent = "← Back to analysis";
    back.addEventListener("click", () => { showPage("analyze"); });
    card.insertBefore(back, card.firstChild);
  }
  $("resultArea").scrollIntoView({behavior:"smooth", block:"start"});
}

function openAnalyze(){
  // keep the person's filters when coming back; only rebuild the lists
  refreshAnalyzeOptions();
  runAnalyze(false);
}

function resetAnalyze(){
  ["anDivision","anDepartment","anBrand","anMin","anMax"].forEach(id => $(id).value = "");
  $("anSort").value = "cheap"; $("anConsign").value = "all";
  $("anInStock").checked = true; $("anHideNonSale").checked = true; $("anGroup").checked = true;
  refreshAnalyzeOptions(); runAnalyze();
}

$("anDivision").addEventListener("change", () => { refreshAnalyzeOptions(); runAnalyze(); });
$("anDepartment").addEventListener("change", () => { refreshAnalyzeOptions(); runAnalyze(); });
$("anHideNonSale").addEventListener("change", () => { refreshAnalyzeOptions(); runAnalyze(); });
["anBrand","anSort","anConsign","anInStock","anGroup"].forEach(id => $(id).addEventListener("change", () => runAnalyze()));
let analyzeTimer = null;
["anMin","anMax"].forEach(id => $(id).addEventListener("input", () => { clearTimeout(analyzeTimer); analyzeTimer = setTimeout(() => runAnalyze(), 350); }));
$("anReset").addEventListener("click", resetAnalyze);

// ---------- Replenishment (compare yesterday's file with today's) ----------
// A size that lost stock between the two files counts as sold.
// Note: if new stock arrived on the same day, the sale can be hidden (stock goes down and up).
const repFiles = {prev:null, today:null};
let repRows = [];
let repLimit = ANALYZE_PAGE_SIZE;

function repMsg(text, type){
  const m = $("rpMsg");
  m.textContent = text;
  m.className = "message" + (type === "error" ? " error" : "");
  if(!text) m.classList.add("hidden");
}

function loadRepFile(slot, file){
  if(!file) return;
  if(!file.name.toLowerCase().endsWith(".csv")){ repMsg("Please select a CSV file.", "error"); return; }
  const reader = new FileReader();
  reader.onload = e => {
    try{
      repFiles[slot] = parseStoreCSV(e.target.result, file.name);
      const box = slot === "prev" ? "rpPrevBox" : "rpTodayBox";
      const info = slot === "prev" ? "rpPrevInfo" : "rpTodayInfo";
      $(box).classList.add("done");
      $(info).textContent = `${file.name} • ${repFiles[slot].stockDate || "date not found"} • ${repFiles[slot].data.length.toLocaleString()} rows`;
      repMsg("");
      if(repFiles.prev && repFiles.today) computeReplenish();
    }catch(err){
      repMsg(err.message, "error");
    }
  };
  reader.readAsText(file);
}

function stockMapOf(data){
  const m = new Map();
  data.forEach(x => {
    const k = x.productId || x.barcode;
    const e = m.get(k);
    if(e) e.soh += num(x.closingSoh); else m.set(k, {item:x, soh:num(x.closingSoh)});
  });
  return m;
}

function sortSizeList(list){
  return list.sort((a,b) => {
    const ra = sizeRank(a.size), rb = sizeRank(b.size);
    return ra[0]-rb[0] || ra[1]-rb[1] || a.size.localeCompare(b.size);
  });
}

function computeReplenish(){
  let older = repFiles.prev, newer = repFiles.today, note = "";
  if(older.stockDate && newer.stockDate){
    if(older.stockDate === newer.stockDate){
      repRows = []; $("rpFilters").classList.add("hidden"); $("rpResult").innerHTML = "";
      repMsg(`Both files have the same stock date (${older.stockDate}). Please choose two different days.`, "error");
      return;
    }
    if(older.stockDate > newer.stockDate){ [older, newer] = [newer, older]; note = "The two files were in the wrong order, so I switched them. "; }
  }
  const prevMap = stockMapOf(older.data), todayMap = stockMapOf(newer.data);
  const vpnOf = it => it.vpn || ("id:" + (it.productId || it.barcode));

  // sizes that have stock today, per style+colour (VPN)
  const stockByVpn = new Map();
  todayMap.forEach(e => {
    if(e.soh <= 0) return;
    const v = vpnOf(e.item);
    if(!stockByVpn.has(v)) stockByVpn.set(v, []);
    stockByVpn.get(v).push({size: sizeOf(e.item) || "–", qty: e.soh});
  });

  const styles = new Map();
  prevMap.forEach((p, key) => {
    const t = todayMap.get(key);
    const nowSoh = t ? t.soh : 0;
    const dropped = p.soh - nowSoh;
    if(dropped <= 0) return;
    const item = t ? t.item : p.item;
    const v = vpnOf(item);
    const g = styles.get(v) || {vpn:v, item, soldSizes:[], soldUnits:0};
    g.soldSizes.push({size: sizeOf(item) || "–", qty: dropped});
    g.soldUnits += dropped;
    styles.set(v, g);
  });

  repRows = [...styles.values()].map(g => {
    g.stockSizes = sortSizeList(stockByVpn.get(g.vpn) || []);
    g.stockUnits = g.stockSizes.reduce((s,x) => s + x.qty, 0);
    sortSizeList(g.soldSizes);
    return g;
  });

  const totalSold = repRows.reduce((s,g) => s + g.soldUnits, 0);
  repMsg(`${note}Comparing ${older.stockDate || "yesterday"} → ${newer.stockDate || "today"}: ${totalSold.toLocaleString()} units sold across ${repRows.length.toLocaleString()} styles.`);
  $("rpFilters").classList.remove("hidden");
  refreshRepOptions(true);
  runReplenish();
}

function repBase(){
  const hide = $("rpHideNonSale").checked;
  return hide ? repRows.filter(g => !isNonSale(g.item)) : repRows;
}

function refreshRepOptions(firstTime){
  const base = repBase();
  const depts = uniqSorted(base.map(g => clean(g.item.department)));
  fillSelect("rpDept", depts, "All categories");
  if(firstTime && depts.includes("FOOTWEAR")) $("rpDept").value = "FOOTWEAR";   // footwear is the usual need
  const dep = $("rpDept").value;
  const list = dep ? base.filter(g => clean(g.item.department) === dep) : base;
  fillSelect("rpBrand", uniqSorted(list.map(g => clean(g.item.brand))), "All brands");
}

function runReplenish(resetLimit = true){
  if(resetLimit) repLimit = ANALYZE_PAGE_SIZE;
  const dep = $("rpDept").value, brand = $("rpBrand").value, sort = $("rpSort").value, onlyStock = $("rpOnlyStock").checked;
  let list = repBase().filter(g =>
    (!dep || clean(g.item.department) === dep) &&
    (!brand || clean(g.item.brand) === brand) &&
    (!onlyStock || g.stockUnits > 0));
  list.sort((a,b) =>
    sort === "brand" ? (clean(a.item.brand).localeCompare(clean(b.item.brand)) || b.soldUnits - a.soldUnits) :
    sort === "stock" ? (b.stockUnits - a.stockUnits || b.soldUnits - a.soldUnits) :
                       (b.soldUnits - a.soldUnits || clean(a.item.brand).localeCompare(clean(b.item.brand))));
  renderReplenish(list);
}

function chipsHtml(list, cls, prefix){
  return list.map(x => `<div class="size-chip ${cls}"><b>${esc(x.size)}</b><small>${prefix}${qty(x.qty)}</small></div>`).join("");
}

function renderReplenish(list){
  if(!list.length){
    $("rpResult").innerHTML = `<div class="result-card"><div class="result-head"><h2>Nothing to check</h2><p>No styles match. Try another category, or untick "Only styles that still have stock".</p></div></div>`;
    return;
  }
  const shown = list.slice(0, repLimit);
  const units = list.reduce((s,g) => s + g.soldUnits, 0);
  $("rpResult").innerHTML = `
    <div class="result-card">
      <div class="result-head">
        <h2>${list.length.toLocaleString()} style${list.length===1?"":"s"} to check</h2>
        <p>${units.toLocaleString()} units sold. Tap a style for full details.${list.length > shown.length ? ` Showing ${shown.length}.` : ""}</p>
      </div>
      ${shown.map((g,i) => {
        const nm = clean(g.item.description).split(":")[2] || clean(g.item.description);
        return `
        <div class="rp-card">
          <button class="rp-head" data-i="${i}">
            <strong>${esc(nm)}</strong>
            <small>${esc(g.item.brand)} • ${esc(g.item.department)}${g.vpn.startsWith("id:") ? "" : " • VPN " + esc(g.vpn)}</small>
          </button>
          <span class="rp-label">Sold (${qty(g.soldUnits)})</span>
          <div class="size-chips">${chipsHtml(g.soldSizes, "sold", "−")}</div>
          <span class="rp-label">Still in stock (${qty(g.stockUnits)})</span>
          <div class="size-chips">${g.stockSizes.length ? chipsHtml(g.stockSizes, "in", "") : "<small>None</small>"}</div>
        </div>`;
      }).join("")}
      ${list.length > shown.length ? `<button class="secondary an-more" id="rpMore">Show ${Math.min(ANALYZE_PAGE_SIZE, list.length - shown.length)} more</button>` : ""}
    </div>`;
  document.querySelectorAll("#rpResult .rp-head").forEach(b => b.addEventListener("click", () => openReplenishItem(shown[Number(b.dataset.i)].item)));
  const more = $("rpMore");
  if(more) more.addEventListener("click", () => { repLimit += ANALYZE_PAGE_SIZE; runReplenish(false); });
}

function openReplenishItem(product){
  const p = inventory.find(x => x.productId === product.productId) || product;
  showPage("scanner");
  showProduct(p);
  const card = document.querySelector("#resultArea .result-card");
  if(card){
    const back = document.createElement("button");
    back.className = "secondary kw-back";
    back.textContent = "← Back to replenishment";
    back.addEventListener("click", () => showPage("replenish"));
    card.insertBefore(back, card.firstChild);
  }
  $("resultArea").scrollIntoView({behavior:"smooth", block:"start"});
}

$("rpPrevBtn").addEventListener("click", () => $("rpPrevFile").click());
$("rpTodayBtn").addEventListener("click", () => $("rpTodayFile").click());
$("rpPrevFile").addEventListener("change", e => { loadRepFile("prev", e.target.files[0]); e.target.value = ""; });
$("rpTodayFile").addEventListener("change", e => { loadRepFile("today", e.target.files[0]); e.target.value = ""; });
$("rpDept").addEventListener("change", () => { refreshRepOptions(false); runReplenish(); });
$("rpHideNonSale").addEventListener("change", () => { refreshRepOptions(false); runReplenish(); });
["rpBrand","rpSort","rpOnlyStock"].forEach(id => $(id).addEventListener("change", () => runReplenish()));

// Offline support: lets the app open without internet after the first visit
if("serviceWorker" in navigator){
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(()=>{}));
}

loadInitial();
