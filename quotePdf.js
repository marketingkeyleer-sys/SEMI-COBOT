// Quotation PDF for a priced BOM (jsPDF + AutoTable, loaded only when a quote is downloaded). Unit
// prices already include each line's markup or margin. Internal costs, markup or margin, supplier
// names and shipping, and net profit never appear on the quote; shipping shows as charged, or free.
// Amounts print with the currency code because the standard PDF fonts have no rupee sign.

const COPPER=[176,96,46],INK=[34,33,30],MUTED=[110,108,102],RULE=[214,210,200];

export async function quotePdf(q){
 const {jsPDF}=await import('jspdf');const mod=await import('jspdf-autotable');const autoTable=mod.autoTable||mod.default;
 const doc=new jsPDF({unit:'mm',format:'a4'}),W=doc.internal.pageSize.getWidth(),M=16;
 // Amounts on the quote come from the unit price as printed (rounded to 2 decimals, 4 below one unit), so
 // quantity × unit price always equals the amount and the total adds up line by line.
 const conv=usd=>q.currency==='INR'?usd*q.inrPerUsd:usd,dec=v=>Math.abs(v)<1&&v!==0?4:2,round=(v,d)=>Math.round(v*10**d)/10**d;
 const cur=v=>q.currency+' '+new Intl.NumberFormat(q.currency==='INR'?'en-IN':'en-US',{minimumFractionDigits:2,maximumFractionDigits:dec(v)}).format(v);
 const priced=l=>{const u=round(conv(l.unit),dec(conv(l.unit)));return {u,a:round(u*l.qty,2)}};
 let sum=0;
 const text=(s,x,y,o={})=>{doc.setFont('helvetica',o.bold?'bold':'normal');doc.setFontSize(o.size||9);doc.setTextColor(...(o.color||INK));doc.text(String(s??''),x,y,o.align?{align:o.align}:undefined)};
 // Header: who quotes (left), the document and its numbers (right).
 text(q.from.company||'Your company',M,20,{bold:true,size:15});
 let y=26;for(const line of String(q.from.address||'').split(/\n/).filter(Boolean).slice(0,4)){text(line,M,y,{color:MUTED});y+=4.4}
 if(q.from.contact){text(q.from.contact,M,y,{color:MUTED});y+=4.4}
 text('QUOTATION',W-M,20,{bold:true,size:16,color:COPPER,align:'right'});
 [['Quote no.',q.number],['Date',q.date],['Valid until',q.validUntil]].forEach(([k,v],i)=>{text(k,W-M-38,28+i*5,{color:MUTED});text(v,W-M,28+i*5,{align:'right',bold:true})});
 y=Math.max(y,44)+4;doc.setDrawColor(...RULE);doc.line(M,y,W-M,y);y+=7;
 text('Prepared for',M,y,{color:MUTED,size:8});text(q.to.customer||'Customer',M,y+5,{bold:true,size:11});if(q.to.contact)text(q.to.contact,M,y+10,{color:MUTED});
 text('Scope',W/2+4,y,{color:MUTED,size:8});text(q.scope,W/2+4,y+5,{bold:true,size:10});text(`${q.boards.toLocaleString('en-IN')} board${q.boards===1?'':'s'}`,W/2+4,y+10,{color:MUTED});
 y+=18;
 // Line items: every component, then the bare PCB and shipping when included.
 const row=(n,pn,desc,l)=>{if(l.onRequest)return [n,pn,desc,l.qty.toLocaleString('en-IN'),'Price on request','-'];const {u,a}=priced(l);sum+=a;return [n,pn,desc,l.qty.toLocaleString('en-IN'),cur(u),cur(a)]};
 const body=q.lines.map((l,i)=>row(i+1,l.mpn,l.description||'',l));let compSum=sum;
 if(q.pcb)body.push(row(body.length+1,'Bare PCB',q.pcb.label,q.pcb));const pcbSum=sum-compSum;
 const ship=q.shipping||{free:false,amount:0},shipNote=ship.free?'Free shipping'+(ship.note?' ('+ship.note+')':''):(ship.note||'Freight and packing');
 const shipAmt=ship.free||ship.tbc?0:round(conv(ship.amount||0),2);
 body.push([body.length+1,'Shipping',shipNote,'1',ship.free?'Free':ship.tbc?'To be confirmed':cur(shipAmt),ship.tbc?'-':cur(shipAmt)]);
 autoTable(doc,{startY:y,margin:{left:M,right:M},head:[['#','Part number','Description','Qty',`Unit price (${q.currency})`,`Amount (${q.currency})`]],body,
  styles:{font:'helvetica',fontSize:8,textColor:INK,cellPadding:{top:1.8,bottom:1.8,left:2,right:2},lineColor:RULE,lineWidth:.1},
  headStyles:{fillColor:[244,241,234],textColor:INK,fontStyle:'bold'},alternateRowStyles:{fillColor:[251,250,247]},
  columnStyles:{0:{cellWidth:8,halign:'right'},1:{cellWidth:38,fontStyle:'bold'},3:{cellWidth:16,halign:'right'},4:{cellWidth:30,halign:'right'},5:{cellWidth:30,halign:'right'}},
  didDrawPage:()=>{const H=doc.internal.pageSize.getHeight();text(`${q.from.company||''}  ·  ${q.number}`,M,H-8,{size:7,color:MUTED});text(`Page ${doc.internal.getNumberOfPages()}`,W-M,H-8,{size:7,color:MUTED,align:'right'})}});
 // Totals, right-aligned under the table.
 y=doc.lastAutoTable.finalY+6;const H=doc.internal.pageSize.getHeight();if(y>H-70){doc.addPage();y=24}
 const total=round(sum+shipAmt,2);
 const rows=[['Components',cur(round(compSum,2))],...(q.pcb?[['Bare PCBs',q.pcb.onRequest?'On request':cur(round(pcbSum,2))]]:[]),['Subtotal',cur(round(sum,2))],['Shipping',ship.free?'Free':ship.tbc?'To be confirmed':cur(shipAmt)]];
 rows.forEach(([k,v])=>{text(k,W-M-60,y,{color:MUTED});text(v,W-M,y,{align:'right'});y+=5.2});
 doc.setDrawColor(...RULE);doc.line(W-M-62,y-2,W-M,y-2);y+=3;
 text('Total',W-M-60,y,{bold:true,size:11});text(cur(total),W-M,y,{bold:true,size:11,align:'right'});y+=5.5;
 text('Per board',W-M-60,y,{color:MUTED});text(cur(round(q.boards?total/q.boards:0,2)),W-M,y,{align:'right',color:MUTED});y+=10;
 // Terms.
 text('Terms',M,y,{bold:true,size:9});y+=5;
 const terms=[`Valid until ${q.validUntil}. Component prices follow distributor quotes of ${q.priced||q.date} and depend on stock when the order is placed.`,
  q.currency==='INR'?`Prices in INR, converted at 1 USD = INR ${q.inrPerUsd.toFixed(2)}${q.rateSource?` (${q.rateSource}${q.rateTime?', rate of '+q.rateTime:''})`:''}.`:'Prices in US dollars.',
  ship.free?'Shipping is free of charge.':ship.tbc?'Shipping charges will be confirmed with the order.':'',
  q.lines.some(l=>l.onRequest)||q.pcb?.onRequest?'Items marked "Price on request" are not included in the total.':'',
  ...String(q.notes||'').split(/\n/).filter(Boolean)].filter(Boolean);
 doc.setFont('helvetica','normal');doc.setFontSize(8);doc.setTextColor(...MUTED);
 for(const t of terms){const wrapped=doc.splitTextToSize(t,W-2*M);if(y+wrapped.length*4>H-14){doc.addPage();y=24}doc.text(wrapped,M,y);y+=wrapped.length*4+1.5}
 return doc.output('blob');
}

export function quoteNumber(date=new Date()){const d=date.toISOString().slice(0,10).replace(/-/g,'');return 'Q-'+d+'-'+String(Math.floor(Math.random()*900)+100)}
