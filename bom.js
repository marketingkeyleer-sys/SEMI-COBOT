// BOM tool: pricing a bill of materials for a build. Pure functions over plain data (prices in USD)
// so the browser and the Node tests share them.
//
// A BOM row: {id, mpn, manufacturer, description, package, type, refs[], qty (per board), margin
// (% or null for the default), source ('auto' | 'own' | an offer key), offers[] from /api/compare,
// manualOffers[] entered by the user (excess stock, broker quotes), fetchedAt, lifecycle}.
// An offer: {seller, source, marketType ('authorized' | 'ems-excess' | 'oem-excess' | 'broker' |
// 'marketplace'), stock, priceUsd, breaksUsd[{qty,price}], moq, mult, leadDays, factoryLeadDays,
// authorized, lifecycle, compliance{rohs,reach,hts}, condition, dateCode, coc, shippingUsd, contact,
// url, image}. Fields a supplier does not report stay null and show as "Not available".

const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
export const offerKey=o=>o.id?'manual|'+o.id:[o.source||'',o.seller||'',o.url||o.mpn||'',o.moq||''].join('|');
// An authorised distributor offer: marked so, or an API offer that is not a marketplace listing.
export const isAuthorized=o=>o?.marketType?o.marketType==='authorized':o?.authorized!==false&&o?.source!=='serpapi'&&o?.source!=='manual';
export const allOffers=row=>[...(row?.offers||[]),...(row?.manualOffers||[])];
export const MARKET_TYPES=[['authorized','Authorised distributor'],['ems-excess','EMS excess'],['oem-excess','OEM/ODM excess'],['broker','Broker'],['marketplace','Marketplace listing']];
export const marketLabel=t=>(MARKET_TYPES.find(m=>m[0]===t)||[null,'Not stated'])[1];
// Quantity that must actually be ordered: at least the MOQ, rounded up to the order multiple.
export function orderQty(offer,qty){const q=Math.max(num(qty),num(offer?.moq)||0),m=num(offer?.mult)||1;return q>0?Math.ceil(q/m)*m:0}
// Days until the parts can ship: 0 when the offer holds enough stock, else the factory lead time.
export function offerLeadDays(offer,qty){if(Number.isFinite(offer?.stock)&&offer.stock>=Math.max(1,qty))return 0;const d=offer?.factoryLeadDays??offer?.leadDays;return d>0?d:null}

// Unit price (USD) for buying qty from an offer: the largest price break at or below qty; below the
// first break the first break applies. moqShort: qty is under the supplier's minimum order.
export function unitAt(offer,qty){
 const breaks=(offer?.breaksUsd||[]).filter(b=>b.price>0).sort((a,b)=>a.qty-b.qty);
 let unit=offer?.priceUsd>0?offer.priceUsd:null,breakQty=offer?.quantity||1;
 for(const b of breaks)if(b.qty<=qty||b===breaks[0]){unit=b.price;breakQty=b.qty}
 if(unit==null)return null;
 return {unit,breakQty,moqShort:!!(offer.moq&&qty<offer.moq)};
}

// Units held by distributors and other stockholders (marketplace listings are left out). null when no
// such offer reports a stock count, so "not reported" never reads as zero.
export const marketStock=offers=>{const known=(offers||[]).filter(o=>o.marketType!=='marketplace'&&o.source!=='serpapi'&&o.authorized!==false&&Number.isFinite(o.stock));return known.length?known.reduce((s,o)=>s+Math.max(0,o.stock),0):null};

// Best purchasing option for `need` units: the cheapest authorised offer with enough stock, then any
// offer with enough stock, else the offer with the most stock (a partial buy). Ties go to more stock.
export function recommend(offers,need){
 const priced=(offers||[]).map(o=>({o,u:unitAt(o,Math.max(1,need))})).filter(x=>x.u);
 if(!priced.length)return null;
 const enough=x=>Number.isFinite(x.o.stock)&&x.o.stock>=need;
 const cheapest=list=>[...list].sort((a,b)=>a.u.unit-b.u.unit||num(b.o.stock)-num(a.o.stock))[0];
 const auth=priced.filter(x=>enough(x)&&x.o.authorized!==false);
 if(auth.length){const b=cheapest(auth);return {offer:b.o,unit:b.u.unit,short:false,reason:auth.length>1?`Lowest price of ${auth.length} distributors with stock`:'Only distributor with enough stock'}}
 const any=priced.filter(enough);
 if(any.length){const b=cheapest(any);return {offer:b.o,unit:b.u.unit,short:false,reason:'Lowest price with enough stock (not an authorised distributor)'}}
 // Short everywhere: an authorised source before an unverified listing, then the most stock, then price.
 const listing=o=>o.marketType==='marketplace'||o.authorized===false?1:0;
 const most=[...priced].sort((a,b)=>listing(a.o)-listing(b.o)||num(b.o.stock)-num(a.o.stock)||a.u.unit-b.u.unit)[0];
 return {offer:most.o,unit:most.u.unit,short:true,reason:Number.isFinite(most.o.stock)&&most.o.stock>0?`Most stock (${most.o.stock}) but short of ${need}`:'No supplier has stock'};
}

const EOL=/obsolete|end of life|\beol\b|nrnd|not recommended|discontinu|last time buy/i;
// Why a row needs an alternative: end of life, out of stock everywhere, or high demand (the market
// holds less than five builds' worth). Only judged once prices were fetched.
export function sourcingAlerts(row,calc){
 const out=[];const life=[row.lifecycle,...allOffers(row).map(o=>o.lifecycle),...allOffers(row).filter(o=>o.discontinued).map(()=>'discontinued')].filter(Boolean).join(' ');
 if(EOL.test(life))out.push({kind:'eol',label:'End of life'});
 if(!row.fetchedAt)return out;
 const market=marketStock(allOffers(row)),need=calc?.need||0,own=calc?.own||0;
 if(market==null)return out;
 if(own<need&&market===0)out.push({kind:'out',label:'Out of stock'});
 else if(own<need&&market<(need-own)*5)out.push({kind:'demand',label:'High demand',detail:`market holds ${market} for ${need-own} needed`});
 return out;
}

// Selling price from cost. Markup adds a percentage of the cost (cost × (1 + p)); margin makes the
// percentage a share of the selling price (cost ÷ (1 − p)), capped at 95 %.
export const PRICING=[['markup','Markup on cost','Selling price = cost × (1 + markup %). A 20 % markup on ₹100 sells at ₹120.'],['margin','Gross margin on price','Selling price = cost ÷ (1 − margin %). A 20 % margin on ₹100 sells at ₹125.']];
export const MAX_MARGIN=95;
export const sellPrice=(cost,pct,method='markup')=>method==='margin'?cost/(1-Math.min(MAX_MARGIN,Math.max(0,num(pct)))/100):cost*(1+Math.max(0,num(pct))/100);

// One row priced for the build. Own stock is used first (at its inventory price) unless the row says
// otherwise; the rest is bought from the chosen or recommended offer, at the quantity that must
// actually be ordered (MOQ and order multiple) and that quantity's price break. margin: the row's
// percentage (markup or margin, see PRICING). A line is "missing" when part of it has no price: no
// offer price, own stock without an inventory price, or own stock that is short.
export function rowCost(row,{boards=1,inventory=null,defaultMargin=0,method='markup'}={}){
 const need=Math.max(0,Math.round(num(row.qty)*Math.max(0,num(boards))));
 const own=Math.max(0,num(inventory?.stock)),ownPrice=num(inventory?.price),ownPriced=ownPrice>0;
 const margin=row.margin==null||row.margin===''?num(defaultMargin):num(row.margin);
 const mode=row.source==='own'&&!inventory?'auto':row.source||'auto';
 const forced=mode!=='auto'&&mode!=='own'?allOffers(row).find(o=>offerKey(o)===mode)||null:null;
 const useOwn=forced?0:Math.min(own,need);
 const buy=mode==='own'?0:need-useOwn,ownShort=mode==='own'?need-useOwn:0;
 let offer=null,unit=null,reason='',short=false,stockUnknown=false;
 if(buy>0){
  const r=forced?{offer:forced,reason:'Chosen supplier'}:recommend(allOffers(row),buy);
  if(r){offer=r.offer;reason=r.reason;unit=unitAt(offer,orderQty(offer,buy))?.unit??null;
   if(Number.isFinite(offer.stock))short=offer.stock<buy;else stockUnknown=true}
 }
 if(ownShort>0){short=true;reason=`Own stock is ${ownShort} short: choose a supplier for the rest`}
 const ord=offer?orderQty(offer,buy):0,ownCostMissing=useOwn>0&&!ownPriced;
 const missing=(buy>0&&unit==null)||ownShort>0||ownCostMissing;
 if(ownCostMissing&&!reason)reason='Own stock has no price in the inventory';
 const lineCost=useOwn*(ownPriced?ownPrice:0)+(unit!=null?ord*unit:0);
 const lineSell=sellPrice(lineCost,margin,method);
 return {need,own,useOwn,buy,offer,unit,reason,short,stockUnknown,missing,ownPrice,ownCostMissing,ownShort,margin,lineCost,lineSell,
  unitCost:need?lineCost/need:0,unitSell:need?lineSell/need:0,orderQty:ord,surplus:Math.max(0,ord-buy),
  source:useOwn>=need&&need>0?'own':offer?(useOwn?'mixed':'offer'):'none'};
}

// Bare PCB price estimate (USD) for a standard FR-4, 1.6 mm, HASL, green mask board: tooling per order
// plus an area rate by layer count. A starting point; replace it with the fab's quote.
const PCB_RATE={1:.01,2:.012,4:.024,6:.04,8:.058,10:.078,12:.098},PCB_SETUP={1:20,2:25,4:60,6:120,8:180,10:240,12:300};
// Board materials: the area rate and tooling scale by material; aluminium core boards are one or two
// layers, flex up to four.
export const PCB_MATERIALS=[
 {id:'fr4',label:'FR-4',note:'standard glass-epoxy, 1.6 mm, HASL',rate:1,setup:1,layers:[1,2,4,6,8,10,12]},
 {id:'fr4-high-tg',label:'FR-4 high-Tg (Tg 170)',note:'for lead-free reflow and hot boards',rate:1.25,setup:1.1,layers:[2,4,6,8,10,12]},
 {id:'aluminium',label:'Aluminium core (MCPCB)',note:'1.6 mm aluminium base, 1 W/m·K dielectric, for LEDs and power',rate:1.7,setup:1.6,layers:[1,2]},
 {id:'polyimide',label:'Polyimide flex',note:'0.1 mm polyimide, for bends and tight spaces',rate:3.2,setup:2,layers:[1,2,4]}];
export function pcbEstimate({layers=2,widthMm=50,heightMm=50,qty=1,material='fr4'}={}){
 const m=PCB_MATERIALS.find(x=>x.id===material)||PCB_MATERIALS[0];
 const L=m.layers.find(l=>l>=num(layers))||m.layers[m.layers.length-1];const area=Math.max(1,num(widthMm)*num(heightMm)/100);
 const n=Math.max(1,Math.round(num(qty)));const board=Math.max(.3,area*PCB_RATE[L]*m.rate);const setup=Math.round(PCB_SETUP[L]*m.setup);
 return {layers:L,material:m.id,areaCm2:Math.round(area*10)/10,perBoard:Math.round((board+setup/n)*1e4)/1e4,setup,qty:n};
}
// A board type's typical size from board-types.json (sizeMm is the range of the long edge) for the estimate.
export function typicalBoard(type){const [a,b]=type?.signals?.sizeMm||[50,50],[l]=type?.signals?.layers||[2];const w=Math.round((num(a)+num(b))/2)||50;return {widthMm:w,heightMm:Math.round(w*.7),layers:num(l)||2}}

// Purchase plan: lines grouped by where they come from, the largest spend first.
export function purchasePlan(rows,calcs){
 const groups=new Map();const add=(k,label,row,c,qty,cost)=>{if(!groups.has(k))groups.set(k,{key:k,label,lines:[],cost:0});const g=groups.get(k);g.lines.push({mpn:row.mpn,qty});g.cost+=cost};
 rows.forEach((row,i)=>{const c=calcs[i];if(c.useOwn)add('own','Own stock',row,c,c.useOwn,c.useOwn*c.ownPrice);if(c.buy>0)c.offer&&c.unit!=null?add('s:'+c.offer.seller,c.offer.seller,row,c,c.orderQty,c.orderQty*c.unit):add('none','No price yet',row,c,c.buy,0);if(c.ownShort)add('none','No price yet',row,c,c.ownShort,0)});
 return [...groups.values()].sort((a,b)=>(a.key==='none')-(b.key==='none')||b.cost-a.cost);
}

// BOM rows from board components (grouped by part number, else value + package) or from a table
// with a header row (MPN / part number, quantity, references, description, manufacturer, package).
export function rowsFromParts(parts){
 const map=new Map();
 for(const p of parts||[]){const mpn=String(p.mpn||p.inv?.mpn||'').trim(),key=(mpn||(p.value||'')+'|'+(p.package||'')).toUpperCase();if(!key.replace('|',''))continue;
  if(!map.has(key))map.set(key,{id:'r'+map.size+'-'+key.replace(/[^A-Z0-9]/g,'').slice(0,24),mpn:mpn||String(p.value||''),manufacturer:p.inv?.manufacturer||p.manufacturer||'',description:p.inv?.description||p.description||[p.value,p.package].filter(Boolean).join(' '),package:p.package||p.inv?.package||'',type:p.type||'',refs:[],qty:0,margin:null,source:'auto',offers:[],fetchedAt:null,lifecycle:p.inv?.lifecycle||null});
  const r=map.get(key);r.qty+=1;if(p.ref)r.refs.push(p.ref)}
 return [...map.values()];
}
const HEAD={mpn:/^(mpn|mfr\.?\s*(part|p\/?n)|manufacturer\s*part\s*(number|no\.?)?|part\s*(number|no\.?)|p\/?n|component)$/i,qty:/^(qty|quantity|qty\s*per\s*board|count)$/i,refs:/^(ref(erence)?s?|designators?|ref\s*des)$/i,description:/^(desc(ription)?|value)$/i,manufacturer:/^(manufacturer|mfr|make|brand)$/i,package:/^(package|footprint|case)$/i};
export function rowsFromTable(table){
 const rows=(table||[]).map(r=>(r||[]).map(c=>String(c??'').trim()));const h=rows.findIndex(r=>r.some(c=>HEAD.mpn.test(c)));if(h<0)return [];
 const col={};rows[h].forEach((c,i)=>{for(const k in HEAD)if(col[k]==null&&HEAD[k].test(c))col[k]=i});
 const out=[];for(const r of rows.slice(h+1)){const mpn=r[col.mpn]||'';if(!mpn)continue;const refs=col.refs!=null?r[col.refs].split(/[\s,;]+/).filter(Boolean):[];
  const qty=col.qty!=null&&num(r[col.qty])>0?num(r[col.qty]):refs.length||1;
  out.push({id:'t'+out.length+'-'+mpn.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,24),mpn,manufacturer:col.manufacturer!=null?r[col.manufacturer]:'',description:col.description!=null?r[col.description]:'',package:col.package!=null?r[col.package]:'',type:'',refs,qty,margin:null,source:'auto',offers:[],fetchedAt:null,lifecycle:null})}
 return out;
}

// --- Shipping and the customer total -------------------------------------------------------------
// Supplier shipping (what suppliers charge us to deliver the parts) is counted once per supplier
// order: its rule (flat charge, free above an order value) or, for an offer entered by hand, the
// shipping quoted on it. Suppliers without a rule are "not quoted" and add nothing.
export function supplierShipping(calcs,rules={}){
 const groups=new Map();
 for(const c of calcs){if(!c.offer||c.buy<=0||c.unit==null)continue;const k=c.offer.seller||'Supplier';if(!groups.has(k))groups.set(k,{seller:k,subtotal:0,quoted:[],lines:0});const g=groups.get(k);g.subtotal+=c.orderQty*c.unit;g.lines++;if(c.offer.shippingUsd!=null&&c.offer.shippingUsd!=='')g.quoted.push(num(c.offer.shippingUsd))}
 const out=[...groups.values()].map(g=>{const r=rules[g.seller];
  if(r&&(r.flat!=null&&r.flat!=='')){const free=r.freeAbove!=null&&r.freeAbove!==''&&g.subtotal>=num(r.freeAbove);return {...g,charge:free?0:Math.max(0,num(r.flat)),basis:free?'free above the order value':'flat charge per order'}}
  if(g.quoted.length)return {...g,charge:Math.max(0,...g.quoted),basis:'quoted on the offer'};
  return {...g,charge:null,basis:'not quoted'}});
 return {groups:out,total:out.reduce((a,g)=>a+(g.charge||0),0),unquoted:out.filter(g=>g.charge==null).map(g=>g.seller)};
}
// Totals for the customer and for us. Every shipping expense is counted once:
//   actual shipping       = supplier shipping + delivery to the customer (our cost)
//   shipping charged      = 0 with free shipping, else the amount set to charge (default: actual shipping)
//   customer total        = selling subtotal + shipping charged
//   net profit            = customer total − component cost − PCB cost − actual shipping
export function quoteTotals(calcs,{boards=1,pcb=null,method='markup',inbound=0,deliveryCost=0,freeShipping=false,charge=null}={}){
 const n=Math.max(0,num(boards));
 const componentCost=calcs.reduce((a,c)=>a+c.lineCost,0),componentsSell=calcs.reduce((a,c)=>a+c.lineSell,0);
 const pcbPriced=!!pcb?.on&&pcb.unit!=null&&pcb.unit!=='';const pcbCost=pcbPriced?Math.max(0,num(pcb.unit))*n:0,pcbSell=pcbPriced?sellPrice(pcbCost,pcb.margin,method):0;
 const sellingSubtotal=componentsSell+pcbSell;
 const actualShipping=Math.max(0,num(inbound))+Math.max(0,num(deliveryCost));
 const shippingCharged=freeShipping?0:charge==null||charge===''?actualShipping:Math.max(0,num(charge));
 const customerTotal=sellingSubtotal+shippingCharged;
 const netProfit=customerTotal-componentCost-pcbCost-actualShipping;
 return {componentCost,componentsSell,pcbCost,pcbSell,sellingSubtotal,supplierShipping:Math.max(0,num(inbound)),deliveryCost:Math.max(0,num(deliveryCost)),actualShipping,shippingCharged,customerTotal,netProfit,
  perBoard:n?customerTotal/n:0,margin:sellingSubtotal-componentCost-pcbCost,missing:calcs.filter(c=>c.missing).length,short:calcs.filter(c=>c.short).length,pcbUnpriced:!!pcb?.on&&!pcbPriced};
}

// --- Component overview ----------------------------------------------------------------------------
// Availability across every offer for the quantity still to buy.
export function availability(row,calc){
 const offers=allOffers(row),need=Math.max(1,calc?.buy||calc?.need||1);
 const withStock=offers.filter(o=>Number.isFinite(o.stock));const total=withStock.reduce((a,o)=>a+Math.max(0,o.stock),0);
 const holders=offers.filter(o=>o.stock>0&&isAuthorized(o));
 const leads=offers.map(o=>offerLeadDays(o,need)).filter(d=>d!=null);
 const factory=offers.map(o=>o.factoryLeadDays).filter(d=>d>0);
 const priced=offers.map(o=>({o,u:unitAt(o,need)})).filter(x=>x.u);const enough=priced.filter(x=>Number.isFinite(x.o.stock)&&x.o.stock>=need);
 const best=(enough.length?enough:priced).sort((a,b)=>a.u.unit-b.u.unit)[0]||null;
 return {total:withStock.length?total:null,distributors:holders.length,sources:offers.length,minLeadDays:leads.length?Math.min(...leads):null,factoryLeadDays:factory.length?Math.min(...factory):null,
  best:best?{unit:best.u.unit,offer:best.o,enough:enough.length>0}:null};
}
// HS code: the first six digits of an HTS code ("8542.33.0001" or "8542330001" → "8542.33"), which
// India's 8-digit HSN shares.
export function hsCode(hts){const d=String(hts||'').replace(/\D/g,'');return d.length>=6?d.slice(0,4)+'.'+d.slice(4,6):null}
export function complianceOf(row,selected=null){
 const offers=allOffers(row),first=k=>offers.map(o=>o.compliance?.[k]).find(Boolean)||null;
 const hts=first('hts');
 const coc=selected?.coc===true?'Offered by the seller':selected?.coc===false?'Not offered':null;
 return {rohs:first('rohs'),reach:first('reach'),msl:first('msl'),eccn:first('eccn'),hts,hs:hsCode(hts),coc};
}

// --- Risk and summary --------------------------------------------------------------------------------
// A line is at risk when it is end of life, out of stock, in high demand, short, without a price,
// or its resilience score is under 40.
export function riskOf(row,calc,scores){
 const reasons=sourcingAlerts(row,calc).map(a=>a.label);
 if(calc.short&&!reasons.includes('Out of stock'))reasons.push('Short of stock');
 if(calc.ownCostMissing)reasons.push('No inventory price');
 else if(calc.missing&&row.fetchedAt&&!calc.ownShort)reasons.push('No price');
 const r=scores?.resilience?.score;if(r!=null&&r<40&&!reasons.length)reasons.push('Low resilience');
 return {atRisk:reasons.length>0,reasons,level:reasons.some(x=>/End of life|Out of stock|No price|No inventory price/.test(x))?'high':reasons.length?'medium':null};
}
// Matched: the exact part number was found at a connected distributor (marketplace listings and offers
// entered by hand do not count) or in the inventory.
export function bomSummary(rows,calcs,risks,inventoryHas=()=>false){
 const cp=v=>String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
 const matched=rows.filter(r=>(r.offers||[]).some(o=>o.source!=='serpapi'&&o.marketType!=='marketplace'&&cp(o.mpn||r.mpn)===cp(r.mpn))||inventoryHas(r)).length;
 return {lines:rows.length,matched,matchedPct:rows.length?Math.round(matched/rows.length*100):0,atRisk:risks.filter(r=>r.atRisk).length,priced:rows.filter(r=>r.fetchedAt).length};
}

// --- Purchase list and bids----------------------------------------------------------------------------------
// The purchase list (cart* helpers): semi-cobot never places orders. Lines are grouped per supplier and
// export as CSV for the supplier's BOM upload.
// sum: add the quantity to a line already in the list (the same part on two BOM lines) instead of replacing it.
export function cartAdd(cart,item,{sum=false}={}){const k=x=>String(x.mpn).toUpperCase()+'|'+x.seller;const i=cart.findIndex(x=>k(x)===k(item));
 if(i<0)return [...cart,{...item,id:item.id||'c'+Math.random().toString(36).slice(2,9)}];
 return cart.map((x,j)=>{if(j!==i)return x;const qty=sum?num(x.qty)+num(item.qty):num(item.qty);const unit=item.breaksUsd?.length?unitAt({breaksUsd:item.breaksUsd,priceUsd:item.unit},qty)?.unit??item.unit:item.unit;return {...x,...item,qty,unit,id:x.id}})}
// List unit price follows the offer's price breaks when the quantity changes.
export const cartUnit=(item,qty)=>item.breaksUsd?.length?unitAt({breaksUsd:item.breaksUsd,priceUsd:item.unit},qty)?.unit??item.unit:item.unit;
export function cartGroups(cart){const m=new Map();for(const it of cart){if(!m.has(it.seller))m.set(it.seller,{seller:it.seller,items:[],subtotal:0});const g=m.get(it.seller);g.items.push(it);g.subtotal+=num(it.qty)*num(it.unit)}return [...m.values()]}
// Cells that a spreadsheet would read as a formula (=, +, -, @) are prefixed with an apostrophe.
const csvCell=v=>{let t=String(v??'');if(/^[=+\-@\t\r]/.test(t))t="'"+t;return /[",\n]/.test(t)?'"'+t.replace(/"/g,'""')+'"':t};
export function cartCsv(items){return ['Manufacturer Part Number,Quantity,Customer Reference,Unit Price USD',...items.map(i=>[i.mpn,i.qty,i.ref||'',num(i.unit).toFixed(4)].map(csvCell).join(','))].join('\r\n')+'\r\n'}
