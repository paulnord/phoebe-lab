const $ = (id) => document.getElementById(id);
const DEFAULTS = {inclination:84.5,radius_primary:.21,radius_secondary:.17,temperature_ratio:.84,mass_ratio:.75,eccentricity:0,omega:90,period:1.8,epoch:0,distortion:false,irradiation:false};
const GROUPS = [
  {name:'Orbit',items:[
    ['inclination','Inclination',65,90,.1,1,'°','90° is edge-on. Lower angles reduce eclipses.'],
    ['eccentricity','Eccentricity',0,.35,.005,3,'','Zero is a circular orbit.'],
    ['omega','Periastron angle',0,360,1,0,'°','The orientation of an eccentric orbit.'],
  ]},
  {name:'The stars',items:[
    ['radius_primary','Primary radius / separation',.10,.32,.002,3,'','Larger stars generally make broader eclipses.'],
    ['radius_secondary','Secondary radius / separation',.08,.29,.002,3,'','Compare the eclipse widths and depths.'],
    ['temperature_ratio','Temperature ratio T₂ / T₁',.58,1.10,.005,3,'','Watch the relative depths of the two eclipses.'],
    ['mass_ratio','Mass ratio M₂ / M₁',.2,1.5,.01,2,'','Affects the stars’ tidal distortion.'],
  ]},
  {name:'Timing',items:[
    ['period','Orbital period',.1,100,.01,3,'d','Used to fold time-series observations.'],
    ['epoch','Primary-eclipse epoch',-1e9,1e9,.001,5,'d','Use the same time system as your observations.'],
  ]},
];
const state = {parameters:{...DEFAULTS},quality:'preview',dataset:null,result:null,revision:0,ready:false,busy:false,fitting:false,queued:false,worker:null,request:0,current:null};
let computeTimer,toastTimer,parsedFile;
const parameterInputs = new Map();

function toast(text) { $('toast').textContent=text; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,6500); }
function status(text,kind='ready') { const el=$('model-status'); el.replaceChildren(); const dot=document.createElement('span');dot.className=`status-dot ${kind==='busy'?'loading':kind==='error'?'error':''}`;const label=document.createElement('span');label.textContent=text;el.append(dot,label); }
function cleanError(error) { return String(error).trim().split('\n').filter(Boolean).slice(-1)[0].replace(/^(ValueError|RuntimeError|PythonError):\s*/,''); }
function median(values) { const x=[...values].sort((a,b)=>a-b);const i=Math.floor(x.length/2);return x.length%2?x[i]:(x[i-1]+x[i])/2; }
function wrapPhase(value) { return ((value+.5)%1+1)%1-.5; }

function renderControls() {
  for (const group of GROUPS) {
    const section=document.createElement('section');section.className='parameter-group';
    const heading=document.createElement('h3');heading.textContent=group.name;section.append(heading);
    if(group.name==='Timing') { section.classList.add('timing-group');heading.title='Timing values are in days.'; }
    for(const [key,label,min,max,step,digits,unit,help] of group.items) {
      const row=document.createElement('div');row.className='parameter';
      const top=document.createElement('div');top.className='parameter-label';
      const title=document.createElement('label');title.htmlFor=`number-${key}`;title.textContent=label;
      const box=document.createElement('span');box.className='value-box';
      const number=document.createElement('input');Object.assign(number,{type:'number',id:`number-${key}`,min,max,step,value:state.parameters[key]});number.setAttribute('aria-label',label);
      const suffix=document.createElement('span');suffix.textContent=unit;box.append(number,suffix);top.append(title,box);row.append(top);
      let range;
      if(key!=='epoch') { range=document.createElement('input');Object.assign(range,{type:'range',id:`range-${key}`,min,max,step,value:state.parameters[key]});range.setAttribute('aria-label',`${label} slider`);row.append(range); }
      const hint=document.createElement('small');hint.className='parameter-help';hint.textContent=help;row.append(hint);section.append(row);
      parameterInputs.set(key,{number,range,digits,min,max});
      const update=(source)=>{
        const value=Number(source.value);
        if(!Number.isFinite(value)||value<min||value>max) {number.setCustomValidity(`Choose a value from ${min} to ${max}.`);return;}
        number.setCustomValidity('');state.parameters[key]=value;updateControlValues();parametersChanged();
      };
      number.addEventListener('change',()=>update(number));
      if(range) {range.addEventListener('input',()=>update(range));range.addEventListener('change',()=>scheduleCompute(80));}
    }
    $('parameter-controls').append(section);
  }
  for(const key of ['distortion','irradiation']) $(key).addEventListener('change',()=>{state.parameters[key]=$(key).checked;parametersChanged();});
  updateControlValues();
}

function updateControlValues() {
  for(const [key,{number,range,digits,min,max}] of parameterInputs) {
    number.value=Number(state.parameters[key]).toFixed(digits);
    if(range) {range.value=state.parameters[key];range.style.setProperty('--fill',`${100*(state.parameters[key]-min)/(max-min)}%`);}
  }
  $('distortion').checked=state.parameters.distortion;$('irradiation').checked=state.parameters.irradiation;
  const a=56*state.parameters.radius_primary/.21,b=56*state.parameters.radius_secondary/.21;
  Object.assign($('primary-star').style,{width:`${a}px`,height:`${a}px`});Object.assign($('secondary-star').style,{width:`${b}px`,height:`${b}px`});
}

function parametersChanged() {state.revision++;$('export-button').disabled=true;$('fit-button').disabled=true;status(state.busy?'Parameters changed; latest model is queued.':'Parameters changed; updating the model…','busy');drawPlots();scheduleCompute();}
function scheduleCompute(delay=450) {clearTimeout(computeTimer);computeTimer=setTimeout(()=>requestModel('compute'),delay);}
function setBusy(busy,fitting=false) {
  state.busy=busy;state.fitting=fitting;
  $('fit-button').disabled=!state.ready||busy||!state.result;
  $('stop-button').hidden=!busy;
  $('import-button').disabled=fitting;$('example-button').disabled=fitting;$('reset-button').disabled=fitting;
  for(const {number,range} of parameterInputs.values()) {number.disabled=fitting;if(range)range.disabled=fitting;}
  $('distortion').disabled=fitting;$('irradiation').disabled=fitting;
}

function startEngine() {
  if(state.worker)state.worker.terminate();
  state.ready=false;setBusy(false);state.queued=false;state.current=null;
  $('engine-banner').hidden=false;$('engine-retry').hidden=true;
  $('engine-pill').innerHTML='<span class="status-dot loading"></span>Loading engine';
  status('Starting the browser engine…','busy');
  state.worker=new Worker(new URL('./engine.worker.js',import.meta.url),{type:'module'});
  state.worker.onmessage=({data})=>{
    if(data.type==='status') {$('engine-title').textContent=data.title;$('engine-detail').textContent=data.detail;return;}
    if(data.type==='ready') {
      state.ready=true;$('engine-banner').hidden=true;$('engine-pill').innerHTML='<span class="status-dot"></span>Browser engine ready';
      requestModel('compute');return;
    }
    if(data.type==='fatal') {
      state.ready=false;setBusy(false);$('engine-title').textContent='The scientific engine could not start';$('engine-detail').textContent=cleanError(data.error);$('engine-retry').hidden=false;
      $('engine-pill').innerHTML='<span class="status-dot error"></span>Engine unavailable';status(cleanError(data.error),'error');return;
    }
    if(data.id!==state.current?.id)return;
    if(data.type==='progress') {status(data.stage||`Fitting · model evaluation ${data.evaluation} · RMS ${Number(data.rms).toFixed(4)}`,'busy');return;}
    if(data.type==='result') {
      const current=state.current;
      if(data.operation==='fit') {state.parameters={...data.result.parameters};state.revision++;updateControlValues();}
      const matches=data.operation==='fit'||current.revision===state.revision;
      setBusy(false);
      if(matches) {
        state.result=data.result;state.result.revision=state.revision;
        $('plot-placeholder').hidden=true;$('export-button').disabled=false;$('fit-button').disabled=false;
        let text=`${data.result.quality==='refined'?'Refined':'Preview'} model · ${data.result.phases.length} phases · ${data.result.seconds.toFixed(1)} s`;
        if(data.result.fit) {text=`Local fit complete · ${data.result.fit.evaluations} model evaluations · ${data.result.seconds.toFixed(1)} s`;toast(data.result.fit.converged?'Local fit completed. Inspect the residuals before accepting the model.':'The short fit reached its stopping limit. Inspect the residuals and starting values.');}
        status(text);drawPlots();updateStats();
      }
      if(state.queued||!matches) {state.queued=false;requestModel('compute');}
      return;
    }
    if(data.type==='error') {
      const outdated=state.current.revision!==state.revision;
      setBusy(false);
      if(outdated||state.queued) {state.queued=false;requestModel('compute');return;}
      status(cleanError(data.error),'error');toast(cleanError(data.error));
      if(!state.result){$('plot-placeholder').hidden=true;drawPlots();}
    }
  };
  state.worker.onerror=(e)=>{state.ready=false;status(e.message||'The browser worker stopped.','error');setBusy(false);$('engine-title').textContent='The browser engine stopped';$('engine-detail').textContent=e.message||'Restart the engine to continue.';$('engine-retry').hidden=false;$('engine-banner').hidden=false;};
  state.worker.postMessage({type:'initialize'});
}

function requestModel(type='compute',fit=[]) {
  clearTimeout(computeTimer);
  if(!state.ready||!state.dataset)return;
  if(state.busy){state.queued=true;return;}
  const id=++state.request;
  state.current={id,revision:state.revision};state.queued=false;setBusy(true,type==='fit');
  status(type==='fit'?'Fitting selected parameters in this browser…':`Computing ${state.quality} model in this browser…`,'busy');
  state.worker.postMessage({type,id,payload:{parameters:{...state.parameters},dataset:state.dataset,quality:state.quality,fit}});
}

function normalizedData() {
  if(!state.dataset)return {phase:[],flux:[],sigma:null};
  const d=state.dataset;let y=[...d.y],sigma=d.sigma?[...d.sigma]:null;
  if(d.y_kind==='magnitude') {const center=median(y);y=y.map(v=>10**(-.4*(v-center)));if(sigma)sigma=sigma.map((s,i)=>.4*Math.log(10)*y[i]*s);}
  const norm=median(y);y=y.map(v=>v/norm);if(sigma)sigma=sigma.map(v=>v/norm);
  const rows=d.x.map((x,i)=>({x:wrapPhase(d.x_kind==='time'?(x-state.parameters.epoch)/state.parameters.period:x),y:y[i],s:sigma?.[i]})).sort((a,b)=>a.x-b.x);
  return {phase:rows.map(r=>r.x),flux:rows.map(r=>r.y),sigma:sigma?rows.map(r=>r.s):null};
}

function drawPlots() {drawChart($('light-curve'),false);drawChart($('residual-curve'),true);}
function drawChart(canvas,residual) {
  const rect=canvas.getBoundingClientRect();if(!rect.width||!rect.height)return;
  const dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const w=rect.width,h=rect.height,L=49,R=18,T=residual?8:20,B=residual?23:26,iw=w-L-R,ih=h-T-B;
  const comparison=state.result?.comparison||normalizedData();
  let ys=residual?(comparison.residual||[]):comparison.flux||[];
  const model=residual?[]:state.result?.model||[];
  let min,max;
  if(residual){const a=Math.max(.005,...ys.map(Math.abs))*1.2;min=-a;max=a;}
  else{const all=[...ys,...model];min=all.length?Math.min(...all):.65;max=all.length?Math.max(...all):1.05;const gap=Math.max(.03,(max-min)*.15);min-=gap;max+=gap;}
  const px=(x)=>L+(x+.5)*iw,py=(y)=>T+(max-y)/(max-min)*ih;
  ctx.clearRect(0,0,w,h);ctx.font='10px system-ui, sans-serif';ctx.lineWidth=1;
  for(let i=0;i<=(residual?2:4);i++) {
    const value=min+(max-min)*i/(residual?2:4),pos=py(value);
    ctx.strokeStyle='#efedf3';ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(L,pos);ctx.lineTo(w-R,pos);ctx.stroke();
    ctx.fillStyle='#9a96a3';ctx.textAlign='right';ctx.fillText(value.toFixed(residual?3:2),L-9,pos+3);
  }
  for(const x of [-.5,-.25,0,.25,.5]) {
    ctx.strokeStyle='#f1eff5';ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(px(x),T);ctx.lineTo(px(x),h-B);ctx.stroke();
    if(residual){ctx.fillStyle='#9a96a3';ctx.textAlign='center';ctx.fillText(x.toFixed(2),px(x),h-6);}
  }
  if(residual){ctx.strokeStyle='#bcb4d3';ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(L,py(0));ctx.lineTo(w-R,py(0));ctx.stroke();}
  else{ctx.save();ctx.translate(12,T+ih/2);ctx.rotate(-Math.PI/2);ctx.fillStyle='#8c8796';ctx.textAlign='center';ctx.fillText('Normalized flux',0,0);ctx.restore();}
  ctx.save();ctx.beginPath();ctx.rect(L,T,iw,ih);ctx.clip();ctx.setLineDash([]);
  const xs=comparison.phase||[];
  for(let i=0;i<ys.length;i++) {
    const x=px(xs[i]),y=py(ys[i]);
    if(!residual&&comparison.sigma?.[i]) {ctx.strokeStyle='#bbc0d25a';ctx.lineWidth=.8;ctx.beginPath();ctx.moveTo(x,py(ys[i]-comparison.sigma[i]));ctx.lineTo(x,py(ys[i]+comparison.sigma[i]));ctx.stroke();}
    ctx.fillStyle=residual?'#8e83bd9c':'#737b969c';ctx.beginPath();ctx.arc(x,y,residual?1.7:2,0,Math.PI*2);ctx.fill();
  }
  if(!residual&&state.result) {
    ctx.strokeStyle='#6a59da';ctx.lineWidth=2.2;ctx.setLineDash(state.result.revision===state.revision?[]:[5,4]);ctx.beginPath();
    state.result.phases.forEach((x,i)=>i?ctx.lineTo(px(x),py(model[i])):ctx.moveTo(px(x),py(model[i])));ctx.stroke();
  }
  ctx.restore();canvas.chart={L,R,T,B,px,py,min,max,w,h,data:comparison};
}

function updateStats() {
  $('residual-summary').textContent=state.result?`${state.result.comparison.residual.length} points`:'—';
  const c=state.result?.comparison;$('rms-stat').textContent=c?c.rms.toFixed(4):'—';$('chi-stat').textContent=c?.reduced_chi2!=null?c.reduced_chi2.toFixed(2):'—';
  $('chi-note').textContent=c?.reduced_chi2!=null?'Uses measurement errors':'Add errors to estimate χ²';
}

function installDataset(dataset,parameters=null) {
  validateDataset(dataset);state.dataset=dataset;if(parameters)state.parameters={...DEFAULTS,...parameters};
  if(dataset.x_kind==='time'){state.parameters.period=dataset.period||state.parameters.period;state.parameters.epoch=dataset.epoch??state.parameters.epoch;}
  state.result=null;state.revision++;updateControlValues();updateStats();drawPlots();
  $('dataset-name').textContent=dataset.name||'Uploaded observations';$('dataset-description').textContent=`${dataset.synthetic?'Synthetic observations':'Your observations'} · ${dataset.x.length} points · ${dataset.y_kind==='magnitude'?'magnitudes converted to flux':'normalized flux'}`;
  $('export-button').disabled=true;$('fit-button').disabled=true;requestModel('compute');
}

function validateDataset(d) {
  if(!d||!Array.isArray(d.x)||!Array.isArray(d.y)||d.x.length!==d.y.length||d.x.length<8||d.x.length>5000)throw Error('Choose between 8 and 5,000 observations with matching coordinates and brightness values.');
  if(!['time','phase'].includes(d.x_kind)||!['flux','magnitude'].includes(d.y_kind))throw Error('Choose the coordinate and brightness formats.');
  if(!d.x.every(Number.isFinite)||!d.y.every(Number.isFinite))throw Error('Some selected data values are missing or non-numeric.');
  if(d.y_kind==='flux'&&d.y.some(v=>v<=0))throw Error('Flux values must be greater than zero.');
  if(d.sigma&&(!Array.isArray(d.sigma)||d.sigma.length!==d.x.length||d.sigma.some(v=>!Number.isFinite(v)||v<=0)))throw Error('Uncertainties must be finite and greater than zero.');
  if(d.x_kind==='time'&&(!Number.isFinite(d.period)||d.period<=0||!Number.isFinite(d.epoch)))throw Error('Time-series data need a positive period and a finite epoch, both in days.');
}

function parseText(text) {
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).map((s,i)=>({text:s.trim(),line:i+1})).filter(s=>s.text&&!s.text.startsWith('#'));
  if(lines.length<2)throw Error('The file does not contain enough rows.');
  const delimiter=lines[0].text.includes(',')?',':lines[0].text.includes('\t')?'\t':lines[0].text.includes(';')?';':null;
  function split(line) {
    if(!delimiter)return line.split(/\s+/);
    const cells=[];let cell='',quote=false;
    for(let i=0;i<line.length;i++) {const c=line[i];if(c==='"'){if(quote&&line[i+1]==='"'){cell+='"';i++;}else quote=!quote;}else if(c===delimiter&&!quote){cells.push(cell.trim());cell='';}else cell+=c;}
    if(quote)throw Error('A quoted field is not closed.');cells.push(cell.trim());return cells;
  }
  const first=split(lines[0].text),numeric=(s)=>s!==''&&Number.isFinite(Number(s));
  const header=first.slice(0,2).some(s=>!numeric(s));
  const headers=header?first:first.map((_,i)=>`Column ${i+1}`);
  const rows=lines.slice(header?1:0).map(s=>({cells:split(s.text),line:s.line}));
  if(headers.length<2)throw Error('The file needs at least two columns.');
  return {headers,rows};
}

function prepareImport(parsed,name) {
  parsedFile={...parsed,name};
  for(const [id,extra] of [['x-column',false],['y-column',false],['sigma-column',true]]) {
    const select=$(id);select.replaceChildren();if(extra)select.add(new Option('No uncertainty column','none'));
    parsed.headers.forEach((h,i)=>select.add(new Option(h,String(i))));
  }
  $('x-column').value='0';$('y-column').value='1';$('sigma-column').value=parsed.headers.length>=3?'2':'none';
  const first=Number(parsed.rows[0]?.cells[0]);$('x-kind').value=/phase/i.test(parsed.headers[0])||Math.abs(first)<=2?'phase':'time';
  $('y-kind').value=/mag/i.test(parsed.headers[1])?'magnitude':'flux';
  $('import-period').value=state.parameters.period;$('import-epoch').value=$('x-kind').value==='time'?first:state.parameters.epoch;
  $('timing-options').hidden=$('x-kind').value!=='time';$('import-options').hidden=false;$('load-file-button').disabled=false;
  const table=document.createElement('table'),head=document.createElement('tr');
  for(const h of parsed.headers){const td=document.createElement('th');td.textContent=h;head.append(td);}table.append(head);
  for(const row of parsed.rows.slice(0,4)){const tr=document.createElement('tr');for(const v of row.cells){const td=document.createElement('td');td.textContent=v;tr.append(td);}table.append(tr);}
  $('data-preview').replaceChildren(table);
}

function download(name,text,type='application/json') {const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function bindEvents() {
  for(const el of document.querySelectorAll('.close-dialog'))el.addEventListener('click',()=>el.closest('dialog').close());
  for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',(e)=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
  $('guide-button').onclick=()=>$('guide-dialog').showModal();
  $('engine-retry').onclick=startEngine;
  $('reset-button').onclick=()=>{state.parameters={...DEFAULTS};updateControlValues();parametersChanged();};
  $('example-button').onclick=async()=>{try {const r=await fetch(new URL('../example.json',import.meta.url));installDataset(await r.json(),DEFAULTS);toast('Loaded the synthetic example.');}catch(e){toast(cleanError(e));}};
  for(const button of document.querySelectorAll('.quality'))button.onclick=()=>{state.quality=button.dataset.quality;document.querySelectorAll('.quality').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});parametersChanged();scheduleCompute(50);};
  $('save-button').onclick=()=>{if(!state.dataset){toast('Load observations first.');return;}download('phoebe-lab-session.json',JSON.stringify({schema:'phoebe-lab-session-v1',parameters:state.parameters,dataset:state.dataset,quality:state.quality},null,2));};
  $('export-button').onclick=()=>{if(!state.result)return;download('phoebe-model.csv','phase,normalized_flux\n'+state.result.phases.map((x,i)=>`${x},${state.result.model[i]}`).join('\n')+'\n','text/csv');};
  $('stop-button').onclick=()=>{toast('Calculation stopped. Restarting the cached browser engine.');startEngine();};
  $('import-button').onclick=()=>{$('import-error').textContent='';$('import-dialog').showModal();};
  $('x-kind').onchange=()=>$('timing-options').hidden=$('x-kind').value!=='time';
  $('data-file').onchange=async(e)=>{
    const file=e.target.files[0];if(!file)return;$('import-error').textContent='';
    try {
      if(file.size>5000000)throw Error('Choose a file smaller than 5 MB.');
      const text=await file.text();
      if(file.name.toLowerCase().endsWith('.json')) {
        const project=JSON.parse(text);if(project.schema!=='phoebe-lab-session-v1')throw Error('This is not a PHOEBE Lab session file.');
        for(const [key,spec] of parameterInputs){const value=Number(project.parameters?.[key]);if(!Number.isFinite(value)||value<spec.min||value>spec.max)throw Error(`The saved ${key} value is outside this app’s supported range.`);}
        for(const key of ['distortion','irradiation'])if(typeof project.parameters?.[key]!=='boolean')throw Error(`The saved ${key} setting is invalid.`);
        state.quality=project.quality==='refined'?'refined':'preview';
        document.querySelectorAll('.quality').forEach(b=>{const active=b.dataset.quality===state.quality;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
        installDataset(project.dataset,project.parameters);$('import-dialog').close();toast('Restored the saved session.');return;
      }
      prepareImport(parseText(text),file.name);
    }catch(error){$('import-error').textContent=cleanError(error);$('load-file-button').disabled=true;}
  };
  $('import-form').onsubmit=(e)=>{
    e.preventDefault();if(!parsedFile)return;
    try {
      const xc=Number($('x-column').value),yc=Number($('y-column').value),sc=$('sigma-column').value;
      if(xc===yc)throw Error('Choose different coordinate and brightness columns.');
      const d={name:parsedFile.name,x_kind:$('x-kind').value,y_kind:$('y-kind').value,x:[],y:[],sigma:sc==='none'?null:[],period:Number($('import-period').value),epoch:Number($('import-epoch').value),synthetic:false};
      const read=(row,col)=>{const value=row.cells[col];if(value===undefined||value.trim()===''||!Number.isFinite(Number(value)))throw Error(`Row ${row.line} has an invalid value in column ${col+1}.`);return Number(value);};
      for(const row of parsedFile.rows){d.x.push(read(row,xc));d.y.push(read(row,yc));if(d.sigma)d.sigma.push(read(row,Number(sc)));}
      installDataset(d);$('import-dialog').close();toast(`Loaded ${d.x.length} observations.`);
    }catch(error){$('import-error').textContent=cleanError(error);}
  };
  $('fit-button').onclick=()=>{$('fit-error').textContent='';$('fit-dialog').showModal();};
  $('fit-form').onsubmit=(e)=>{e.preventDefault();const keys=[...document.querySelectorAll('input[name=fit]:checked')].map(x=>x.value);if(keys.length<1||keys.length>2){$('fit-error').textContent='Select one or two parameters.';return;}if(state.busy){$('fit-error').textContent='Wait for the current model to finish.';return;}$('fit-dialog').close();requestModel('fit',keys);};
  $('light-curve').addEventListener('pointermove',(e)=>{
    const canvas=$('light-curve'),c=canvas.chart;if(!c||!c.data.phase.length)return;
    const rect=canvas.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;
    let nearest=-1,distance=18;
    c.data.phase.forEach((phase,i)=>{const d=Math.hypot(c.px(phase)-x,c.py(c.data.flux[i])-y);if(d<distance){nearest=i;distance=d;}});
    let tip=$('plot-tooltip');if(!tip){tip=document.createElement('div');tip.id='plot-tooltip';tip.className='plot-tooltip';canvas.parentElement.append(tip);}
    tip.hidden=nearest<0;if(nearest<0)return;
    tip.textContent=`Phase ${c.data.phase[nearest].toFixed(4)} · Flux ${c.data.flux[nearest].toFixed(4)}`;tip.style.left=`${Math.min(x+10,c.w-220)}px`;tip.style.top=`${Math.max(7,y-35)}px`;
  });
  $('light-curve').addEventListener('pointerleave',()=>{if($('plot-tooltip'))$('plot-tooltip').hidden=true;});
  new ResizeObserver(drawPlots).observe($('light-curve'));
}

renderControls();bindEvents();drawPlots();
try {const response=await fetch(new URL('../example.json',import.meta.url));if(!response.ok)throw Error('The example observations could not be loaded.');installDataset(await response.json(),DEFAULTS);}catch(error){toast(cleanError(error));}
startEngine();
