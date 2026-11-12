(function(){
const $=s=>document.querySelector(s);
const fmt=n=>n>=1e6?'$'+(n/1e6).toFixed(2).replace(/0$/,'')+'M':'$'+Math.round(n/1000)+'K';
const URG={today:1.6,week:1.4,month:1.1,quarter:1};
const ACT=[
{id:'a1',t:'Renew Polk Co. A anchor before rollover',sub:'Rent 18% under market · expires in 7 mo',p:'Polk Co. A',cat:'Leasing',usd:58000,kind:'gain',due:'Nov 14',u:'week',c:.6,own:'GG',dest:'leasing',tab:'Rollover',verb:'Draft offer',why:['Market rent comps: $8.40/SF vs in-place $6.90/SF','Tenant has no renewal signal on file','Rollover window opens in 21 days'],src:'Leasing › Rollover · Lease Market › Market Rents'},
{id:'a2',t:'Northwood roof: quote exceeds reserve',sub:'2 bids in · low bid $45K over funded reserve',p:'Northwood',cat:'Capex',usd:45000,kind:'risk',due:'Nov 30',u:'month',c:.7,own:'GG',dest:'property-condition',tab:'Quotes & prices',verb:'Compare bids',why:['PCA flags roof at end of useful life','Reserve funded $72K, low bid $117K','Deferral adds ~$9K/yr leak risk'],src:'Property Condition › Quotes & prices'},
{id:'a3',t:'Lock Salisbury refi before rate reset',sub:'Reset Jan 1 · +140 bps if unhedged',p:'Salisbury',cat:'Debt',usd:37000,kind:'risk',due:'Dec 15',u:'month',c:.8,own:'GG',dest:'capital',tab:'Debt',verb:'Open term sheets',why:['Two lender quotes expire Dec 15','DSCR stays above 1.30x at quoted rate','Prepay penalty steps down Dec 1'],src:'Capital › Debt'},
{id:'a4',t:'Suite 110 vacant 62 days',sub:'Listing below market velocity · 0 tours in 14 days',p:'Salisbury',cat:'Vacancy',usd:29000,kind:'risk',due:'This week',u:'week',c:.8,own:'Broker',dest:'leasing',tab:'Rent roll',verb:'Review listing',why:['Downtime cost $2,400/mo','Comparable suites leasing in 41 days','Asking rent 6% above submarket'],src:'Leasing › Rent roll · Market › Demand'},
{id:'a5',t:'Appeal Raytown assessment',sub:'Assessed 22% above comps · filing deadline Dec 1',p:'Raytown',cat:'Taxes',usd:21000,kind:'gain',due:'Dec 1',u:'month',c:.65,own:'GG',dest:'obligations',tab:'Taxes',verb:'Start appeal',why:['Income approach implies $1.9M vs $2.4M assessed','Hard filing deadline','Prior appeal won 2023'],src:'Obligations › Taxes'},
{id:'a6',t:'3 tenants 30+ days past due',sub:'Grouped: Easton Ste 4 · Columbia Ste 2 · Raytown Ste 7',p:'Easton',cat:'Collections',usd:18400,kind:'risk',due:'Today',u:'today',c:.9,own:'PM',dest:'worklist',tab:'Alerts',verb:'Send notices',n:3,why:['One cause, one decision: send default notices','Oldest balance 47 days','Security deposits cover 61%'],src:'Worklist › Alerts (grouped by cause)'},
{id:'a7',t:'Countersign Salisbury estoppel',sub:'Lender requested · closes the refi file',p:'Salisbury',cat:'Task',usd:15000,kind:'info',due:'Today',u:'today',c:1,own:'GG',dest:'worklist',tab:'Today',verb:'Sign',why:['Blocking item on the refi checklist','Tenant returned it clean'],src:'Worklist › Today'},
{id:'a8',t:'Easton CAM reconciliation under-billed',sub:'2025 recon shows $11K recoverable',p:'Easton',cat:'Revenue',usd:11000,kind:'gain',due:'Dec 31',u:'quarter',c:.85,own:'PM',dest:'intel',tab:'Lease Run',verb:'Bill tenants',why:['Expense pools exceed estimates by 9%','Lease permits true-up within 12 mo'],src:'Financials › Lease Run'},
{id:'a9',t:'HVAC RTU-3 past useful life',sub:'Raytown · no failure yet',p:'Raytown',cat:'Capex',usd:19000,kind:'risk',due:'Q1',u:'quarter',c:.5,own:'GG',dest:'property-condition',tab:'Replacement schedule',verb:'Request quote',why:['Installed 2009, EUL 15 yrs','No quote on file'],src:'Property Condition › Replacement schedule'},
{id:'a10',t:'Columbia expense watchlist: utilities +31%',sub:'YoY, cash basis',p:'Columbia',cat:'Expense',usd:8600,kind:'risk',due:'Q1',u:'quarter',c:.6,own:'PM',dest:'property-financials',tab:'Expense watchlist',verb:'Ask PM',why:['Spike starts in June','No occupancy change to explain it'],src:'Property Financials › Expense watchlist'},
{id:'a11',t:'Polk Co. B rent 12% under market',sub:'Expires in 9 mo',p:'Polk Co. B',cat:'Leasing',usd:33000,kind:'gain',due:'Feb',u:'quarter',c:.6,own:'GG',dest:'leasing',tab:'Rollover',verb:'Plan renewal',why:['Same submarket as Polk Co. A — negotiate together'],src:'Leasing › Rollover'},
{id:'a12',t:'12 unmapped GL accounts',sub:'Blocks 2 properties from NOI roll-up',p:null,cat:'Data',usd:null,kind:'info',due:'This week',u:'week',c:1,own:'Ops',dest:'data',tab:'Mappings',verb:'Map accounts',why:['New chart of accounts from PM migration'],src:'Data › Mappings'}
];
ACT.forEach(a=>a.score=(a.usd||4000)*URG[a.u]*a.c);
const PROPS=[
['Salisbury',[[88.4,2],[-9.1,2],[22,1],[14,0],[0,0],[99,0]]],
['Polk Co. A',[[100,0],[-3.2,1],[61,3],[0,0],[4,0],[100,0]]],
['Northwood',[[96,0],[1.4,0],[8,0],[117,3],[2,0],[100,0]]],
['Raytown',[[92,1],[-2.1,1],[14,0],[19,1],[22,3],[94,1]]],
['Easton',[[95.5,0],[3.8,0],[11,0],[6,0],[1,0],[91,2]]],
['Columbia',[[97,0],[-5.4,1],[9,0],[3,0],[0,0],[96,1]]],
['Polk Co. B',[[100,0],[-1.0,0],[48,2],[0,0],[3,0],[100,0]]],
['1100 Rarig Ave',[[100,0],[0.6,0],[0,0],[8,0],[0,0],[100,0]]]];
const COLS=[['Occupancy','%','leasing'],['NOI vs budget','%','property-financials'],['12-mo rollover','% rent','leasing'],['Capex due','$K','property-condition'],['Tax vs comps','%','obligations'],['Collected','%','worklist']];
const KPI=[
{l:'NOI · TTM',v:'$3.47M',pct:.953,tgt:1,note:'−4.7% vs plan $3.64M',tone:'warn',dest:'property-financials'},
{l:'Occupancy',v:'93.1%',pct:.931/1,tgt:.95,note:'1.9 pts under 95% target',tone:'warn',dest:'leasing'},
{l:'DSCR',v:'1.42x',pct:1.42/2,tgt:1.25/2,note:'Covenant 1.25x · clear',tone:'pos',dest:'capital'},
{l:'Cash vs reserve',v:'$2.31M',pct:2.31/3,tgt:1.5/3,note:'$810K above $1.5M floor',tone:'pos',dest:'capital'},
{l:'WALT',v:'3.4 yrs',pct:3.4/6,tgt:4/6,note:'Target 4.0 · rollover heavy 2027',tone:'warn',dest:'leasing'},
{l:'Debt maturing 12 mo',v:'$6.2M',pct:6.2/20,tgt:null,note:'1 loan · Salisbury',tone:'neg',dest:'capital'}];
const D={
overview:{l:'Overview',g:'Command'},
pipeline:{l:'Acquisitions',g:'Command',b:[2,'n'],verdict:'2 deals need a go/no-go this week; Polk Co. C LOI expires Friday.',k:[['Active deals','9'],['In DD','2'],['Hit rate TTM','11%']],tabs:['Pipeline','Workbench','Sourcing','Grader','Edge']},
worklist:{l:'Worklist',g:'Command',b:[4,'neg'],verdict:'4 items are due today; 3 past-due tenants roll up to one notice decision.',k:[['Due today','4'],['Overdue','1'],['Snoozed','6']],tabs:['Today','Alerts','Calendar','Renewals'],tb:{Alerts:[3,'neg']}},
'command-brain':{l:'Brain',g:'Command',b:[4,'n'],verdict:'4 open questions are blocking calibration; track record is 71% on resolved calls.',k:[['Open questions','4'],['Resolved calls','38'],['Accuracy','71%']],tabs:['Digest','Insights','Track record','Feedback','Memory'],tb:{Feedback:[4,'n']}},
portfolio:{l:'Portfolio',g:'Assets',verdict:'8 assets; 2 are under budget on NOI and account for 81% of the shortfall.',k:[['Assets','8'],['Value','$61.4M'],['Under budget','2']],tabs:['Properties','Trends','Expenses']},
'property-financials':{l:'Property Financials',g:'Assets',b:[1,'warn'],verdict:'Salisbury is the only property more than 5% under NOI budget.',k:[['NOI · TTM','$3.47M'],['vs plan','−4.7%'],['Watchlist','3']],tabs:['Overview','Property explorer','Scorecard table','Rent & NOI levers','Expense watchlist','Evaluation scorecard'],view:1},
intel:{l:'Financials',g:'Assets',verdict:'One recoverable CAM true-up ($11K) and no manager outliers this month.',k:[['Entities','11'],['Recoverable','$11K'],['Managers','3']],tabs:['Ownership','Property','Lease Run','Benchmarks','Managers']},
leasing:{l:'Leasing',g:'Assets',b:[3,'warn'],verdict:'$91K/yr of below-market rent rolls in the next 9 months — two Polk tenants.',k:[['Rolling 12 mo','23% rent'],['Below market','$91K/yr'],['Vacant SF','14,200']],tabs:['Rollover','Rent roll','Forecast','Market rents','Tenants'],tb:{'Rent roll':[2,'neg']}},
capital:{l:'Capital',g:'Capital',b:[1,'warn'],verdict:'One maturity in 12 months; deployable capacity is $3.1M after reserves.',k:[['Deployable','$3.1M'],['DSCR','1.42x'],['Maturing 12 mo','$6.2M']],tabs:['Allocation','Pipeline','Debt','Cash','Close']},
'property-condition':{l:'Property Condition',g:'Capital',b:[2,'neg'],verdict:'Northwood roof is $45K over reserve; everything else is inside funded reserves.',k:[['Immediate','$162K'],['Reserves','$1.1M'],['Over reserve','1']],tabs:['Capex outlook','Replacement schedule','Estimate vs actual','Quotes & prices','Open items','29000 Info Ln','Building specs','Cost seg'],view:1},
obligations:{l:'Obligations',g:'Capital',b:[1,'warn'],verdict:'Raytown appeal deadline Dec 1; all policies renewed through Q2.',k:[['Next deadline','Dec 1'],['Appeal upside','$21K'],['Renewals 90d','0']],tabs:['Insurance','Taxes']},
market:{l:'Market',g:'Market',verdict:'Polk submarket rents +6.2% YoY — supports the renewal push.',k:[['Markets','6'],['Rent growth','+4.1%'],['Vacancy','5.8%']],tabs:['Macro','Scorecards','Comps','Demand']},
'lease-market':{l:'Lease Market',g:'Market',verdict:'14 new listings, 3 price cuts in our submarkets this week.',k:[['New listings','14'],['Price cuts','3'],['Stale','5']],tabs:['Portfolio','Market Rents','Acquisition Radar','Changes','Data Quality']},
data:{l:'Data',g:'System',b:[4,'n'],verdict:'12 unmapped GL accounts block 2 properties from the NOI roll-up.',k:[['Last import','2h ago'],['Unmapped','12'],['Issues','4']],tabs:['Imports','Quality','Mappings','Calibration','Documents']}};
const ORDER=['overview','pipeline','worklist','command-brain','portfolio','property-financials','intel','leasing','capital','property-condition','obligations','market','lease-market','data'];
const S={dest:'overview',cap:7,badge:'count',prop:null,drawer:null,tab:0,life:{}};
const ranked=()=>ACT.filter(a=>!S.prop||a.p===S.prop||(a.n&&S.prop==='Easton')).slice().sort((a,b)=>b.score-a.score);
const destUsd=id=>ACT.filter(a=>a.dest===id).reduce((s,a)=>s+(a.usd||0),0);
const tone={neg:'p-neg',warn:'p-warn',pos:'p-pos',n:'p-n'};
const LIFE=['New','Acknowledged','In progress','Resolved'];

function rail(){let last='';$('#ccRail').innerHTML=ORDER.map(id=>{const m=D[id];const g=m.g!==last?'<div class="railgroup">'+m.g+'</div>':'';last=m.g;let b='';
if(m.b){const usd=destUsd(id);if(S.badge==='count')b='<span class="rb '+m.b[1]+'">'+m.b[0]+'</span>';else if(S.badge==='usd')b=usd?'<span class="rb '+m.b[1]+' num">'+fmt(usd)+'</span>':'<span class="rb n">'+m.b[0]+'</span>';else b='<span class="rdot '+m.b[1]+'"></span>'}
return g+'<button class="railitem" data-m="'+id+'" aria-current="'+(id===S.dest?'page':'false')+'"><span class="rl">'+m.l+'</span>'+b+'</button>'}).join('');
document.querySelectorAll('#ccRail .railitem').forEach(b=>b.onclick=()=>go(b.dataset.m))}
function go(id,tab){S.dest=id;S.tab=tab||0;S.drawer=null;paint()}

function actRow(a,i,max){const w=a.usd?Math.max(6,a.usd/max*100):0;const st=S.life[a.id]||0;
return '<li class="act'+(st===3?' done':'')+'" data-a="'+a.id+'"><span class="rk num">'+(i+1)+'</span>'+
'<div class="am"><div class="at">'+a.t+(a.n?' <span class="grp num">×'+a.n+'</span>':'')+'</div><div class="as"><span class="pill p-n">'+a.cat+'</span><span>'+a.sub+'</span></div>'+
'<div class="ameta num"><span class="due '+(a.u==='today'?'hot':'')+'">'+a.due+'</span>'+(a.p?'<span>'+a.p+'</span>':'')+'<span class="own">'+a.own+'</span>'+(st?'<span class="life">'+LIFE[st]+'</span>':'')+'</div></div>'+
'<div class="aval"><div class="num v '+a.kind+'">'+(a.usd?fmt(a.usd):'—')+'</div><div class="abar"><i class="'+a.kind+'" style="width:'+w+'%"></i></div><div class="note">'+(a.kind==='gain'?'upside / yr':a.kind==='risk'?'at risk / yr':'unblocks')+'</div></div>'+
'<button class="btn pri" data-verb="'+a.id+'">'+a.verb+'</button></li>'}

function overview(){const r=ranked();const shown=r.slice(0,S.cap);const max=Math.max(...r.map(a=>a.usd||0));
const tot=r.reduce((s,a)=>s+(a.usd||0),0),sh=shown.reduce((s,a)=>s+(a.usd||0),0);const wk=r.filter(a=>a.u==='today'||a.u==='week');const wkUsd=wk.reduce((s,a)=>s+(a.usd||0),0);
let h='<div class="verdict card"><div class="vl"><div class="eyebrow">Briefing · Wed Oct 28</div><div class="vt">'+(S.prop?'<strong>'+S.prop+'</strong> — '+r.length+' open items carrying <span class="num">'+fmt(tot)+'</span>.':'<strong>'+wk.length+' decisions this week</strong> carry <span class="num">'+fmt(wkUsd)+'</span>. NOI is <span class="t-warn">4.6% behind plan</span>, mostly Salisbury vacancy and below-market rent at Polk Co. A.')+'</div></div>'+
'<div class="vr"><div class="cov"><div class="note">On screen</div><div class="num">'+shown.length+' of '+r.length+'</div></div><div class="cov"><div class="note">$ coverage</div><div class="num">'+(tot?Math.round(sh/tot*100):0)+'%</div></div>'+(S.prop?'<button class="btn" id="clrProp">Clear '+S.prop+' ×</button>':'')+'</div></div>';
h+='<div class="ovgrid"><section class="card ovact"><div class="ch"><h3>Do next</h3><span class="note">ranked by $ × urgency × confidence</span></div><ol class="acts">'+shown.map((a,i)=>actRow(a,i,max)).join('')+'</ol>'+
(r.length>shown.length?'<button class="held" data-go="worklist">+'+(r.length-shown.length)+' more · '+fmt(tot-sh)+' held back in Worklist →</button>':'')+'</section>';
h+='<section class="ovkpi"><div class="ch"><h3>Against plan</h3><span class="note">tick = target</span></div><div class="kgrid">'+KPI.map(k=>'<button class="tk" data-go="'+k.dest+'"><div class="l">'+k.l+'</div><div class="v num">'+k.v+'</div><div class="bullet"><i class="'+k.tone+'" style="width:'+Math.min(100,k.pct*100)+'%"></i>'+(k.tgt!=null?'<b style="left:'+k.tgt*100+'%"></b>':'')+'</div><div class="s t-'+k.tone+'">'+k.note+'</div></button>').join('')+'</div></section></div>';
h+='<section class="card heat"><div class="ch"><h3>Where it hurts</h3><span class="note">click a property to filter the action list · click a column to open it</span></div><div class="hwrap"><table class="hm"><thead><tr><th>Property</th>'+COLS.map(c=>'<th><button data-go="'+c[2]+'">'+c[0]+'</button></th>').join('')+'</tr></thead><tbody>'+
PROPS.map(([p,cells])=>'<tr class="'+(S.prop===p?'sel':'')+'"><th><button data-prop="'+p+'">'+p+'</button></th>'+cells.map(([v,lv],ci)=>{const u=COLS[ci][1];const t=u==='$K'?(v?'$'+v+'K':'—'):(ci===1&&v>0?'+':'')+v+(u==='%'||u==='% rent'?'%':'');return '<td class="lv'+lv+' num">'+t+'</td>'}).join('')+'</tr>').join('')+
'</tbody></table></div><div class="legend note"><span><i class="lv0"></i>on plan</span><span><i class="lv1"></i>watch</span><span><i class="lv2"></i>act</span><span><i class="lv3"></i>urgent</span></div></section>';
return h}

function destPage(){const m=D[S.dest];const acts=ACT.filter(a=>a.dest===S.dest).sort((a,b)=>b.score-a.score).slice(0,3);const max=Math.max(1,...acts.map(a=>a.usd||0));
let h='<div class="dhead"><div><div class="eyebrow">'+m.g+'</div><h2>'+m.l+'</h2><p class="dv">'+m.verdict+'</p></div><div class="dk">'+m.k.map(k=>'<div class="kpi"><div class="l">'+k[0]+'</div><div class="v num">'+k[1]+'</div></div>').join('')+'</div></div>';
if(m.view)h+='<div class="seg" role="tablist">'+m.tabs.map((t,i)=>'<button data-t="'+i+'" aria-selected="'+(i===S.tab)+'">'+t+'</button>').join('')+'<span class="note">?view=</span></div>';
else h+='<div class="tabstrip" role="tablist">'+m.tabs.map((t,i)=>{const tb=m.tb&&m.tb[t];return '<button class="tab" data-t="'+i+'" aria-selected="'+(i===S.tab)+'">'+t+(tb?'<span class="cnt '+tb[1]+'">'+tb[0]+'</span>':'')+'</button>'}).join('')+'</div>';
if(acts.length)h+='<section class="card" style="margin-bottom:12px"><div class="ch"><h3>Needs you here</h3><span class="note">same ranked feed, scoped to '+m.l+'</span></div><ol class="acts">'+acts.map((a,i)=>actRow(a,i,max)).join('')+'</ol></section>';
h+='<div class="card ph"><div class="note">'+m.l.toUpperCase()+' · '+m.tabs[S.tab].toUpperCase()+'</div><p>Existing panel content carries over unchanged below the header.</p></div>';return h}

function drawer(){const a=ACT.find(x=>x.id===S.drawer);const el=$('#ccDrawer');if(!a){el.classList.remove('open');el.innerHTML='';return}
const st=S.life[a.id]||0;el.classList.add('open');
el.innerHTML='<div class="dw-h"><span class="pill p-n">'+a.cat+'</span><button class="x" id="dwX" aria-label="Close">×</button></div><h3 class="dw-t">'+a.t+'</h3><p class="note" style="margin:0 0 14px">'+(a.p||'Portfolio')+' · due '+a.due+' · owner '+a.own+'</p>'+
'<div class="dw-v"><div><div class="note">'+(a.kind==='gain'?'Upside / yr':a.kind==='risk'?'At risk / yr':'Value')+'</div><div class="num big '+a.kind+'">'+(a.usd?fmt(a.usd):'—')+'</div></div><div class="math num">'+(a.usd?fmt(a.usd):'$4K floor')+' × '+URG[a.u]+' urgency × '+a.c+' conf.<br>= score '+Math.round(a.score/1000)+'</div></div>'+
'<div class="mini">Why it is here</div><ul>'+a.why.map(w=>'<li>'+w+'</li>').join('')+'</ul>'+
'<div class="mini">Status</div><div class="life-steps">'+LIFE.map((l,i)=>'<button data-life="'+i+'" class="'+(i<=st?'on':'')+'">'+l+'</button>').join('')+'</div>'+
'<div class="dw-act"><button class="btn pri" data-verb="'+a.id+'">'+a.verb+'</button><button class="btn" data-toast="Assigned">Assign…</button><button class="btn" data-toast="Snoozed 7 days — it will return ranked">Snooze 7d</button><button class="btn ghost" data-toast="Dismissed with reason — feeds Brain › Feedback">Dismiss</button></div>'+
'<button class="src" data-go="'+a.dest+'" data-tab="'+a.tab+'">Open in '+a.src+' →</button>'}

function toast(t){const el=$('#ccToast');el.textContent=t;el.classList.add('on');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('on'),2200)}

function paint(){rail();$('#ccCrumb').textContent=D[S.dest].l;$('#ccMain').innerHTML=S.dest==='overview'?overview():destPage();drawer();wire()}
function wire(){const root=$('#ccProto');
root.querySelectorAll('[data-go]').forEach(b=>b.onclick=e=>{e.stopPropagation();const m=D[b.dataset.go];const ti=b.dataset.tab&&m.tabs?Math.max(0,m.tabs.indexOf(b.dataset.tab)):0;go(b.dataset.go,ti)});
root.querySelectorAll('.act').forEach(li=>li.onclick=()=>{S.drawer=li.dataset.a;drawer();wire()});
root.querySelectorAll('[data-verb]').forEach(b=>b.onclick=e=>{e.stopPropagation();const a=ACT.find(x=>x.id===b.dataset.verb);S.life[a.id]=Math.max(2,S.life[a.id]||0);toast(a.verb+' — opened, marked In progress');paint();if(S.drawer)drawer()});
root.querySelectorAll('[data-prop]').forEach(b=>b.onclick=()=>{S.prop=S.prop===b.dataset.prop?null:b.dataset.prop;paint()});
root.querySelectorAll('[data-t]').forEach(b=>b.onclick=()=>{S.tab=+b.dataset.t;paint()});
root.querySelectorAll('[data-life]').forEach(b=>b.onclick=()=>{S.life[S.drawer]=+b.dataset.life;paint()});
root.querySelectorAll('[data-toast]').forEach(b=>b.onclick=()=>toast(b.dataset.toast));
const x=$('#dwX');if(x)x.onclick=()=>{S.drawer=null;drawer()};const c=$('#clrProp');if(c)c.onclick=()=>{S.prop=null;paint()}}

document.querySelectorAll('[data-cap]').forEach(b=>b.onclick=()=>{S.cap=+b.dataset.cap;document.querySelectorAll('[data-cap]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));paint()});
document.querySelectorAll('[data-badge]').forEach(b=>b.onclick=()=>{S.badge=b.dataset.badge;document.querySelectorAll('[data-badge]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));paint()});
$('#ccStatus').onclick=()=>toast('Live · snapshot 4 min old · 2 feeds warn (CoStar, PM portal) → System Health');
$('#ccSettings').onclick=()=>$('#ccMenu').classList.toggle('open');
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&S.drawer){S.drawer=null;drawer()}});
paint();
})();
