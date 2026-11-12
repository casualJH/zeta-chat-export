// ==UserScript==
// @name         제타 대화 내보내기 (TXT/JSON)
// @namespace    zeta-chat-export
// @version      1.1.3
// @updateURL    https://raw.githubusercontent.com/casualJH/zeta-chat-export/main/zeta-chat-export.user.js
// @downloadURL  https://raw.githubusercontent.com/casualJH/zeta-chat-export/main/zeta-chat-export.user.js
// @description  제타 대화·상태창 불러오기, 선택 및 TXT/JSON 내보내기
// @match        https://zeta-ai.io/*
// @match        https://*.zeta-ai.io/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==
(function () {
  'use strict';
  if (window.__zetaChatExport011) return;
  window.__zetaChatExport011 = true;
  const VERSION = '1.1.3';
  const apiOrigin = 'https://api.zeta-ai.io';
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const headerNames = ['authorization','x-client-native-version','x-client-type','x-client-version','x-device-type','x-user-language'];
  let captured = null, roomFromRequest = null, roomPath = null;
  let messages = [], chosen = new Set(), running = false, aborter = null, stopped = false;
  let selectionMode = false, previewLimit = 40, loadEpoch = 0;
  const expanded = new Set(), pageMarked = new Map();
  let pages = 0, totalRaw = 0, complete = false, info = '채팅방을 열고 대화 불러오기를 누르세요.';
  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalSend = XMLHttpRequest.prototype.send;
  const xhrData = new WeakMap();
  function isApi(u) { try { const url = new URL(String(u), location.href); return url.origin === apiOrigin; } catch (_) { return false; } }
  function requestRoom(u) { const m = /\/rooms\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(String(u)); if (m && uuid.test(m[1])) {roomFromRequest=m[1];roomPath=location.pathname+location.search;} }
  function keepHeaders(entries) {
    const h = {};
    for (const [k,v] of entries) { const name = String(k).toLowerCase(); if (headerNames.includes(name) && v != null) h[name] = String(v); }
    if (h.authorization) captured = h;
  }
  function headerEntries(h) { try { if (!h) return []; if (h instanceof Headers) return Array.from(h.entries()); if (Array.isArray(h)) return h; return Object.entries(h); } catch (_) { return []; } }
  window.fetch = function(input, init) {
    try {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      if (isApi(u)) { keepHeaders(headerEntries((init && init.headers) || (input && input.headers))); requestRoom(u); }
    } catch (_) {}
    return originalFetch.apply(this, arguments);
  };
  XMLHttpRequest.prototype.open = function(method, url) { xhrData.set(this,{url:String(url),headers:[]}); return originalOpen.apply(this,arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function(name,value) { const o=xhrData.get(this); if(o && isApi(o.url)) o.headers.push([name,value]); return originalHeader.apply(this,arguments); };
  XMLHttpRequest.prototype.send = function() { const o=xhrData.get(this); if(o && isApi(o.url)) {keepHeaders(o.headers);requestRoom(o.url);} return originalSend.apply(this,arguments); };
  function roomId() { const m=/\/rooms\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(location.pathname); return m && uuid.test(m[1]) ? m[1] : (roomPath===location.pathname+location.search?roomFromRequest:null); }
  function sleep(n) {return new Promise(r=>setTimeout(r,n));}
  function fmtTime(v) {if(!v)return ''; const d=new Date(v);return isNaN(d.getTime())?String(v):d.toLocaleString('ko-KR');}
  // INFO_BOX arrives in the same API messages as TEXT, but has structured
  // scenes/characters/items rather than a text field. Keep both types in memory;
  // the InfoBox checkbox is applied only when exporting.
  function infoValue(value) {
    if(typeof value==='string')return value.trim();
    if(typeof value==='number'||typeof value==='boolean')return String(value);
    return '';
  }
  function infoItems(section) {
    const lines=[];
    if(!section||typeof section!=='object')return lines;
    for(const item of Array.isArray(section.items)?section.items:[]) {
      if(!item||typeof item!=='object')continue;
      const label=infoValue(item.label), value=infoValue(item.value);
      if(value)lines.push(label?`${label}: ${value}`:value);
      else if(label)lines.push(label);
    }
    // Some scene objects may have a value without an items array.
    if(!lines.length){
      const value=infoValue(section.value)||infoValue(section.description);
      if(value)lines.push(value);
    }
    return lines;
  }
  function readInfoBox(content) {
    const scenes=Array.isArray(content.scenes)?content.scenes:[];
    const characters=Array.isArray(content.characters)?content.characters:[];
    const parts=[];
    const speaker='상태창';
    for(const scene of scenes){
      const lines=infoItems(scene);
      if(!lines.length)continue;
      const heading=infoValue(scene?.name)||infoValue(scene?.title)||infoValue(scene?.label);
      parts.push((heading?heading+'\n':'')+lines.join('\n'));
    }
    for(const character of characters){
      const lines=infoItems(character);
      if(!lines.length)continue;
      const name=infoValue(character?.name);
      // Keep character headings inside the InfoBox body for every room.
      parts.push((name?name+'\n':'')+lines.join('\n'));
    }
    if(!parts.length){
      const lines=infoItems(content);
      if(lines.length)parts.push(lines.join('\n'));
      else if(typeof content.text==='string'&&content.text.trim())parts.push(content.text.trim());
    }
    return {speaker,text:parts.join('\n\n').trim()};
  }
  function normalize(raw) {
    const out=[];let i=0;
    for(const msg of raw) {
      if(!msg||typeof msg!=='object')continue;
      const isUser=msg.sender?.type==='USER';
      for(const content of Array.isArray(msg.contents)?msg.contents:[]) {
        if(!content||typeof content!=='object')continue;
        let speaker,text,kind;
        if(content.type==='TEXT') {
          if(typeof content.text!=='string'||!content.text.trim())continue;
          speaker=isUser?'사용자':(content.speakerName||'캐릭터');
          text=content.text;
          kind='text';
        } else if(content.type==='INFO_BOX') {
          const box=readInfoBox(content);
          if(!box.text)continue; // An empty INFO_BOX is harmless.
          speaker=box.speaker;
          text=box.text;
          kind='info_box';
        } else continue;
        out.push({id:String(msg.id||'')+':'+(i++),messageId:msg.id||null,
          time:msg.messageTime||null,speaker,role:isUser?'user':'character',text,kind});
      }
    }
    out.sort((a,b)=>{const x=Date.parse(a.time)||0,y=Date.parse(b.time)||0;return x-y;});
    return out;
  }
  async function load() {
    if(running)return;
    const room=roomId();
    if(!room) {setInfo('채팅방 식별자를 찾지 못했습니다. 채팅방 안에서 다시 시도하세요.');return;}
    if(!captured?.authorization) {setInfo('인증 정보를 아직 확인하지 못했습니다. 채팅방을 새로고침한 뒤 대화가 표시되면 다시 누르세요.');return;}
    if(selectionMode)setSelectionMode(false);
    const epoch=++loadEpoch;
    running=true;stopped=false;complete=false;pages=0;totalRaw=0;messages=[];chosen.clear();expanded.clear();pageMarked.clear();previewLimit=40;
    const headers={...captured}; const seen=new Set(), cursors=new Set(), collected=[];
    let cursor=null, limit=100, note='', throttles=0;
    update();
    try {
      for(let p=1;p<=300;p++) {
        if(stopped||epoch!==loadEpoch||roomId()!==room){note='수집이 중단되었습니다.';break;}
        aborter=new AbortController();
        let url=`${apiOrigin}/v1/rooms/${room}/messages?limit=${limit}`;
        if(cursor)url+='&cursor='+encodeURIComponent(cursor);
        let response;
        try {response=await originalFetch.call(window,url,{headers,credentials:'include',cache:'no-store',signal:aborter.signal});}
        catch(e) {note=stopped?'사용자가 중단했습니다.':`연결 오류: ${String(e.message||e)}`;break;}
        if(stopped||epoch!==loadEpoch||roomId()!==room){note='수집이 중단되었습니다.';break;}
        if((response.status===400 || response.status===422) && limit!==20) {limit=20;p--;continue;}
        if(response.status===429) {
          if(++throttles>4){note='요청 제한(HTTP 429)이 반복되어 수집을 중단했습니다. 잠시 후 다시 시도하세요.';break;}
          await sleep(2500);p--;continue;
        }
        throttles=0;
        if(!response.ok) {note=`HTTP ${response.status}: 일부 대화만 불러왔을 수 있습니다.`;break;}
        const data=await response.json();
        if(stopped||epoch!==loadEpoch||roomId()!==room){note='수집이 중단되었습니다.';break;}
        const batch=Array.isArray(data.messages)?data.messages:[];
        if(!batch.length) {complete=true;break;}
        for(const m of batch) {if(!m || typeof m.id!=='string' || seen.has(m.id)) continue;seen.add(m.id);collected.push(m);}
        pages=p;totalRaw=seen.size;messages=normalize(collected);update();
        if(!data.nextCursor) {complete=true;break;}
        if(typeof data.nextCursor!=='string' || cursors.has(data.nextCursor)) {note='페이지 커서가 중복되거나 올바르지 않아 중단했습니다.';break;}
        cursors.add(data.nextCursor);cursor=data.nextCursor;
        if(p===300)note='300페이지 제한에 도달했습니다.';
        await sleep(250);
      }
    } catch(e) {note='데이터 처리 오류: '+String(e.message||e);}
    finally {
      running=false;aborter=null;
      // A previous room's finished request must never overwrite the current room's status.
      if(epoch===loadEpoch&&roomId()===room)
        setInfo(`수집 ${messages.length}개 (텍스트 ${messages.filter(m=>m.kind==='text').length}개 · 상태창 ${messages.filter(m=>m.kind==='info_box').length}개) · 원본 메시지 ${totalRaw}개 · ${pages}페이지\n${complete?'마지막 페이지까지 수집 완료':'부분 수집'}${note?'\n'+note:''}`);
      update();
    }
  }
  function setInfo(s){info=s;update();}
  function selectedRows(){return messages.filter(m=>chosen.has(m.id));}
  function pickRecent(n){let count=0;for(let i=messages.length-1;i>=0&&count<n;i--)if(!chosen.has(messages[i].id)){chosen.add(messages[i].id);count++;}update();}
  // Only removes COMPLETE fenced blocks. An unclosed fence is kept verbatim to avoid data loss.
  // InfoBox is separate from ordinary code fences so users can independently preserve either type.
  function stripFencedBlocks(text, removeInfoBox, removeOther) {
    const src=String(text ?? '').replace(/\r\n?/g,'\n');
    const lines=src.split('\n');
    const result=[];
    for(let i=0;i<lines.length;){
      const opener=/^ {0,3}(`{3,}|~{3,})([^`~]*)$/.exec(lines[i]);
      if(!opener){result.push(lines[i++]);continue;}
      const fence=opener[1], marker=fence[0], length=fence.length;
      const lang=opener[2].trim().split(/\s+/)[0].toLowerCase();
      const isInfo=lang==='infobox';
      const selected=isInfo?removeInfoBox:removeOther;
      if(!selected){result.push(lines[i++]);continue;}
      let end=-1;
      for(let j=i+1;j<lines.length;j++){
        const close=/^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j]);
        if(close && close[1][0]===marker && close[1].length>=length){end=j;break;}
      }
      if(end<0){result.push(lines[i++]);continue;}
      i=end+1;
    }
    return result.join('\n').replace(/\n{3,}/g,'\n\n').trim();
  }
  // Evaluate OOC/summary against the ORIGINAL complete message, not against filtered content.
  // This deliberately discards the whole message, even when the trigger occurs mid-message.
  function isExcludedMessage(m) {
    const text=String(m.text||'');
    return (!!panel?.querySelector('#zce-remove-ooc')?.checked && /ooc\s*:/i.test(text)) ||
           (!!panel?.querySelector('#zce-remove-summary')?.checked && text.includes('요약'));
  }
  function excludedMessageIds() {
    // A Zeta response can have multiple TEXT parts (narration and character lines).
    // If any part contains a trigger, omit that whole original response.
    const excluded=new Set();
    for(const m of messages)if(isExcludedMessage(m)&&m.messageId)excluded.add(m.messageId);
    return excluded;
  }
  function exportRows() {
    const removeInfo=!!panel?.querySelector('#zce-remove-info')?.checked;
    const removeCode=!!panel?.querySelector('#zce-remove-code')?.checked;
    const excluded=excludedMessageIds();
    return selectedRows()
      .filter(m=>!(removeInfo&&m.kind==='info_box')&&!isExcludedMessage(m)&&!(m.messageId&&excluded.has(m.messageId)))
      .map(m=>({...m,text:stripFencedBlocks(m.text,removeInfo,removeCode)}))
      .filter(m=>m.text.trim());
  }
  function safeName(s){return (s||'제타_대화').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').trim().slice(0,90)||'제타_대화';}
  function customUserName() {
    const value=panel?.querySelector('#zce-user-name')?.value||'';
    return value.trim().replace(/\s+/g,' ').slice(0,60)||'사용자';
  }
  // Preserve the original body including *actions* and line breaks.
  // Only the role prefix (and optional time) is formatted for export.
  function formatLine(m, removeTime, userName) {
    const speaker=m.kind==='info_box'?'상태창':(m.role==='user'?userName:(m.speaker||'캐릭터'));
    const stamp=!removeTime&&m.time?' ('+fmtTime(m.time)+')':'';
    return `${speaker}${stamp}: ${m.text}`;
  }
  function download(kind){
    const rows=exportRows();
    if(!rows.length){setInfo('저장할 본문이 없습니다. 선택 또는 제외 옵션을 확인하세요.');return;}
    const removeTime=!!panel.querySelector('#zce-remove-time')?.checked;
    const userName=customUserName();
    // Keep the established TXT/JSON formats; omit internal messageId from JSON.
    const content=kind==='json'
      ?JSON.stringify({
        format:'zeta-chat-export',version:VERSION,sourceUrl:location.href,
        roomId:roomId(),exportedAt:new Date().toISOString(),complete,
        filters:{
          excludeInfoBox:!!panel.querySelector('#zce-remove-info').checked,
          excludeCodeBlocks:!!panel.querySelector('#zce-remove-code').checked,
          excludeOoc:!!panel.querySelector('#zce-remove-ooc').checked,
          excludeSummary:!!panel.querySelector('#zce-remove-summary').checked
        },
        count:rows.length,
        messages:rows.map((m,i)=>({
          index:i+1,
          time:m.time,
          role:m.kind==='info_box'?'info_box':m.role,
          speaker:m.kind==='info_box'?'상태창':(m.role==='user'?userName:m.speaker),
          ...(m.kind==='info_box'?{type:'INFO_BOX'}:{}),
          text:m.text
        }))
      },null,2)
      :rows.map(m=>formatLine(m,removeTime,userName)).join('\n\n');
    const blob=new Blob(['\ufeff',content],{type:kind==='json'?'application/json;charset=utf-8':'text/plain;charset=utf-8'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;
    a.download=safeName(panel.querySelector('#zce-name')?.value)+'.'+kind;
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    setInfo(`선택 ${chosen.size}개 중 제외 조건 적용 후 ${rows.length}개 ${kind.toUpperCase()} 다운로드를 요청했습니다.`);
  }
  let panel, status, list, summary, launch, launchLabel, launchCount, startInput, endInput, listNote;
  const UI_KEY='zeta-chat-export-ui-v1';
  const defaultUi=()=>({buttonSize:100,panelSize:100,buttonPos:null,panelPos:null});
  function readUi() {
    try {
      const data=JSON.parse(localStorage.getItem(UI_KEY)||'{}');
      return {
        buttonSize:Number.isFinite(data.buttonSize)?Math.max(60,Math.min(160,data.buttonSize)):100,
        panelSize:Number.isFinite(data.panelSize)?Math.max(70,Math.min(130,data.panelSize)):100,
        buttonPos:data.buttonPos&&Number.isFinite(data.buttonPos.x)&&Number.isFinite(data.buttonPos.y)?data.buttonPos:null,
        panelPos:data.panelPos&&Number.isFinite(data.panelPos.x)&&Number.isFinite(data.panelPos.y)?data.panelPos:null
      };
    } catch (_) {return defaultUi();}
  }
  let ui=readUi();
  function saveUi(){try{localStorage.setItem(UI_KEY,JSON.stringify(ui));}catch(_){}}
  function clamp(n,min,max){return Math.min(Math.max(n,min),Math.max(min,max));}
  function setAbsPosition(el,pos) {
    if(!el)return;
    if(!pos){el.style.left='';el.style.top='';el.style.right='';el.style.bottom='';return;}
    // The coordinates are viewport-based. Constrain them after rotation/resizing.
    const w=el.offsetWidth||el.getBoundingClientRect().width||48;
    const h=el.offsetHeight||el.getBoundingClientRect().height||32;
    pos.x=clamp(pos.x,4,window.innerWidth-w-4);
    pos.y=clamp(pos.y,4,window.innerHeight-h-4);
    el.style.left=pos.x+'px';el.style.top=pos.y+'px';el.style.right='auto';el.style.bottom='auto';
  }
  function applyUi(){
    if(!launch||!panel)return;
    const b=ui.buttonSize/100;
    launch.style.fontSize=(13*b).toFixed(2)+'px';
    launch.style.padding=`${(10*b).toFixed(1)}px ${(13*b).toFixed(1)}px`;
    launch.style.borderRadius=(22*b).toFixed(1)+'px';
    if(ui.panelSize===100){panel.style.width='';panel.style.maxHeight='';}
    else {
      panel.style.width=`min(${Math.round(360*ui.panelSize/100)}px, calc(100vw - 20px))`;
      panel.style.maxHeight=`min(${Math.round(74*ui.panelSize/100)}vh, calc(100dvh - 16px))`;
    }
    // Preserve original mobile Safari right/bottom + safe-area defaults until moved.
    setAbsPosition(launch,ui.buttonPos);
    if(!panel.hidden)setAbsPosition(panel,ui.panelPos);
    const bRange=panel.querySelector('#zce-button-size');
    const pRange=panel.querySelector('#zce-panel-size');
    if(bRange)bRange.value=ui.buttonSize;
    if(pRange)pRange.value=ui.panelSize;
    const bLabel=panel.querySelector('#zce-button-size-label');
    const pLabel=panel.querySelector('#zce-panel-size-label');
    if(bLabel)bLabel.textContent=ui.buttonSize+'%';
    if(pLabel)pLabel.textContent=ui.panelSize+'%';
  }
  // Pointer Events work for touch and mouse; moving is separate from ordinary click/tap.
  let draggedLaunch=false;
  function addDrag(handle,target,kind) {
    handle.style.touchAction='none';
    handle.addEventListener('pointerdown',down=>{
      if(down.button!==undefined&&down.button!==0)return;
      if(kind==='panel'&&down.target.closest('button,input,summary,select'))return;
      const rect=target.getBoundingClientRect();
      const startX=down.clientX,startY=down.clientY;
      const baseX=rect.left,baseY=rect.top;
      let moving=false;
      function onMove(e){
        if(e.pointerId!==down.pointerId)return;
        const dx=e.clientX-startX,dy=e.clientY-startY;
        if(!moving && Math.hypot(dx,dy)<7)return;
        if(!moving){moving=true;target.style.left=baseX+'px';target.style.top=baseY+'px';target.style.right='auto';target.style.bottom='auto';}
        e.preventDefault();
        const x=clamp(baseX+dx,4,window.innerWidth-rect.width-4);
        const y=clamp(baseY+dy,4,window.innerHeight-rect.height-4);
        target.style.left=x+'px';target.style.top=y+'px';
      }
      function end(e){
        if(e.pointerId!==down.pointerId)return;
        window.removeEventListener('pointermove',onMove);
        window.removeEventListener('pointerup',end);
        window.removeEventListener('pointercancel',end);
        if(!moving)return;
        const final=target.getBoundingClientRect();
        ui[kind+'Pos']={x:final.left,y:final.top};saveUi();
        if(kind==='button'){
          draggedLaunch=true;
          // A drag may synthesize a click: suppress it once without blocking a later tap.
          setTimeout(()=>{draggedLaunch=false;},250);
        }
      }
      window.addEventListener('pointermove',onMove,{passive:false});
      window.addEventListener('pointerup',end);
      window.addEventListener('pointercancel',end);
    });
  }
  function flashTip(message){
    let tip=document.getElementById('zce-tip');
    if(!tip){tip=document.createElement('div');tip.id='zce-tip';document.body.appendChild(tip);}
    tip.textContent=message;tip.hidden=false;
    clearTimeout(flashTip.timeout);
    flashTip.timeout=setTimeout(()=>{tip.hidden=true;},2700);
  }
  function norm(s){
    // Zeta may render Markdown as formatted HTML, so ignore formatting markers.
    return String(s||'').normalize('NFC').toLocaleLowerCase()
      .replace(/[\u200b-\u200f\ufeff]/g,'').replace(/[\s*`~_>#]/g,'');
  }
  function matchBubbles(node){
    let el=node instanceof Element?node:node?.parentElement;
    for(let depth=0;el&&el!==document.body&&depth<13;el=el.parentElement,depth++){
      if(el===panel||el===launch)return null;
      // Prefer an exact ID match if Zeta exposes the ID on the bubble element.
      const attr=[el.getAttribute('data-message-id'),el.getAttribute('data-id'),el.id]
        .find(v=>v&&/MESSAGE-/i.test(v));
      // Zeta's BodyView / data-index wrapper is the visible message card.
      const bodyView=el.closest('[data-sentry-component="BodyView"]');
      const visualRoot=bodyView?(bodyView.closest('[data-index]')||bodyView):el;
      if(attr){
        const found=messages.filter(m=>m.messageId&&attr.includes(m.messageId));
        if(found.length)return {element:visualRoot,items:found};
      }
      const rect=el.getBoundingClientRect();
      if(rect.width<35||rect.height<14)continue;
      const content=norm(el.innerText||el.textContent||'');
      if(content.length<10||content.length>18000)continue;
      const hits=[];
      for(const msg of messages){
        const body=norm(msg.text);
        if(body.length<10)continue;
        const a=body.slice(0,Math.min(45,body.length));
        const b=content.slice(0,Math.min(45,content.length));
        // When the site hides Markdown, the normalized excerpt still matches.
        if(content.includes(a)||(content.length>=15&&body.includes(b)))hits.push(msg);
        if(hits.length>12)break;
      }
      if(!hits.length)continue;
      const groups=new Set(hits.map(m=>m.messageId||m.id));
      if(groups.size!==1)continue; // A parent containing multiple bubbles isn't selectable.
      const found=hits[0];
      const items=found.messageId?messages.filter(m=>m.messageId===found.messageId):[found];
      return {element:visualRoot,items};
    }
    return null;
  }
  function updatePageHighlights(){
    for(const [el,ids] of pageMarked){
      if(!el.isConnected){pageMarked.delete(el);continue;}
      el.classList.toggle('zce-site-selected',ids.some(id=>chosen.has(id)));
    }
  }
  function setSelectionMode(on){
    selectionMode=!!on;
    document.documentElement.classList.toggle('zce-select-mode',selectionMode);
    if(!selectionMode){
      for(const el of pageMarked.keys())el.classList.remove('zce-site-selected');
      pageMarked.clear();
    }
    update();
  }
  function onPageClick(e){
    if(!selectionMode||!messages.length)return;
    const target=e.target instanceof Element?e.target:e.target?.parentElement;
    if(!target||target.closest('#zce-panel,#zce-launch,#zce-tip'))return;
    if(target.closest('a,button,input,textarea,select,[contenteditable="true"]'))return;
    const match=matchBubbles(target);
    if(!match){flashTip('이 말풍선을 연결할 수 없습니다. 창의 대화 카드에서 선택할 수 있어요.');return;}
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation?.();
    const ids=match.items.map(m=>m.id);
    const shouldAdd=ids.some(id=>!chosen.has(id));
    ids.forEach(id=>shouldAdd?chosen.add(id):chosen.delete(id));
    pageMarked.set(match.element,ids);
    updatePageHighlights();update();
    flashTip(shouldAdd?`선택 완료 · 현재 총 ${chosen.size}개`:`선택 해제 · 현재 총 ${chosen.size}개`);
  }
  document.addEventListener('click',onPageClick,true);
  function update(){
    if(!panel)return;
    status.textContent=info;
    summary.querySelector('#zce-collected-count').textContent=String(messages.length);
    summary.querySelector('#zce-selected-count').textContent=String(chosen.size);
    panel.querySelector('#zce-load').textContent=running?'수집 중...':'과거 대화 불러오기';
    panel.querySelector('#zce-load').disabled=running;
    panel.querySelector('#zce-stop').disabled=!running;
    const modeButton=panel.querySelector('#zce-select-mode-btn');
    modeButton.textContent=selectionMode?'화면 말풍선 선택 종료':'화면 말풍선 직접 선택';
    modeButton.dataset.on=selectionMode?'true':'false';
    launch.classList.toggle('zce-mode-on',selectionMode);
    launchLabel.textContent=selectionMode?'대화 저장 · 선택 중':'대화 저장';
    launchCount.textContent=`선택 ${chosen.size}개`;
    launchCount.hidden=!selectionMode;
    launch.setAttribute('aria-label',selectionMode?`대화 저장, 현재 ${chosen.size}개 선택됨`:'대화 저장');
    if(!list.hidden)renderList();
    updatePageHighlights();
  }
  function renderList(){
    if(!list)return;
    list.textContent='';
    const count=messages.length, start=Math.max(0,count-previewLimit);
    const fragment=document.createDocumentFragment();
    for(let i=start;i<count;i++){
      const m=messages[i], selected=chosen.has(m.id);
      const card=document.createElement('div');
      card.className='zce-msg-card';card.tabIndex=0;card.setAttribute('role','checkbox');
      card.setAttribute('aria-checked',String(selected));
      if(selected)card.classList.add('zce-is-chosen');
      const head=document.createElement('div');head.className='zce-card-head';
      const who=document.createElement('span');who.textContent=`${i+1}. ${m.speaker}${m.kind==='info_box'?' · 상태창':''}`;
      const check=document.createElement('span');check.textContent=selected?'✓ 선택됨':'＋ 선택';
      head.append(who,check);card.appendChild(head);
      const body=document.createElement('div');body.className='zce-card-text';
      const open=expanded.has(m.id);
      body.textContent=(!open&&m.text.length>290)?m.text.slice(0,290)+'…':m.text;
      card.appendChild(body);
      const actions=document.createElement('div');actions.className='zce-card-actions';
      const reasons=[];
      if(/ooc\s*:/i.test(m.text))reasons.push('OOC');
      if(m.text.includes('요약'))reasons.push('요약');
      if(reasons.length){
        const label=document.createElement('span');label.className='zce-skip-tag';
        label.textContent=`감지: ${reasons.join('·')}`;actions.appendChild(label);
      }
      if(m.text.length>290){
        const more=document.createElement('button');more.type='button';more.className='zce-more';
        more.textContent=open?'접기':'전체 보기';
        more.addEventListener('click',e=>{e.stopPropagation();open?expanded.delete(m.id):expanded.add(m.id);renderList();});
        actions.appendChild(more);
      }
      card.appendChild(actions);
      const toggle=()=>{selected?chosen.delete(m.id):chosen.add(m.id);update();};
      card.addEventListener('click',toggle);
      card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle();}});
      fragment.appendChild(card);
    }
    list.appendChild(fragment);
    listNote.textContent=count
      ?`최근 ${count-start}개 표시 / 총 ${count}개 · 카드를 누르면 선택 · 긴 대화는 전체 보기`
      :'수집된 대화가 없습니다.';
    const older=panel.querySelector('#zce-more-older');
    older.hidden=!count||start===0;
  }
  function chooseRange(){
    const a=Number(startInput.value),b=Number(endInput.value);
    if(!Number.isInteger(a)||!Number.isInteger(b)||a<1||b<1||a>messages.length||b>messages.length){
      setInfo(`범위는 1~${messages.length} 사이의 번호로 입력하세요.`);return;
    }
    for(let i=Math.min(a,b)-1;i<Math.max(a,b);i++)chosen.add(messages[i].id);
    update();
  }
  function mount(){
    if(!document.body||panel)return;
    const style=document.createElement('style');
    style.textContent=`
      #zce-launch{position:fixed;right:12px;bottom:calc(94px + env(safe-area-inset-bottom,0px));z-index:2147483645;background:#25252d;color:white;border:1px solid #666;border-radius:22px;padding:10px 13px;font:600 13px system-ui;cursor:pointer;user-select:none;-webkit-user-select:none}
      #zce-launch.zce-mode-on{border-color:#44c384;box-shadow:0 0 0 2px #44c38455}
      #zce-launch .zce-selection-count{position:absolute;right:-6px;top:-12px;min-width:48px;padding:3px 7px;border-radius:16px;background:#246443;color:#fff;border:1px solid #90eac1;font:700 11px/1.25 system-ui;white-space:nowrap;pointer-events:none;box-sizing:border-box}
      #zce-launch .zce-selection-count[hidden]{display:none!important}
      #zce-panel{position:fixed;z-index:2147483646;right:10px;bottom:calc(145px + env(safe-area-inset-bottom,0px));width:min(360px,calc(100vw - 20px));max-height:74vh;overflow:auto;background:#202029;color:white;border:1px solid #555;border-radius:14px;padding:13px;font:13px/1.45 system-ui;box-sizing:border-box;box-shadow:0 7px 28px #0008;overscroll-behavior:contain}
      #zce-panel[hidden],#zce-panel [hidden],#zce-tip[hidden]{display:none!important}
      #zce-panel *{box-sizing:border-box}
      #zce-panel button{background:#3b3b49;color:white;border:1px solid #696978;border-radius:7px;padding:8px 7px;font:600 12px system-ui;cursor:pointer;flex:1}
      #zce-panel button:disabled{opacity:.5}
      #zce-panel button.zce-primary-action{background:#2e5c49;border-color:#679b82;color:#fff}
      #zce-panel button.zce-primary-action:active{background:#274d3e}
      #zce-panel button[data-on="true"]{background:#246443;border-color:#69d1a0}
      #zce-panel .zce-head{display:flex;align-items:center;gap:7px;cursor:grab;user-select:none;-webkit-user-select:none;min-height:30px}
      #zce-panel .zce-head button{flex:none}
      #zce-panel .zce-drag-label{color:#bdbdc9;font-size:11px;white-space:nowrap}
      #zce-panel .zce-row{display:flex;gap:5px;margin:7px 0;flex-wrap:wrap}
      #zce-panel .zce-row input:not([type="range"]){flex:1;min-width:50px;width:40px}
      #zce-panel input:not([type="checkbox"]){background:#30303a;border:1px solid #777;border-radius:6px;color:white;padding:7px;font-size:13px}
      #zce-panel .zce-status{white-space:pre-wrap;background:#30303a;border-radius:7px;padding:8px;margin:6px 0}
      #zce-panel .zce-summary-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin:9px 0 10px}
      #zce-panel .zce-summary-card{min-width:0;background:#30303a;border-radius:9px;padding:9px 6px;text-align:center}
      #zce-panel .zce-summary-label{display:block;color:#bdbdc9;font-size:11px;font-weight:600}
      #zce-panel .zce-summary-number{display:block;color:#fff;font-size:24px;font-weight:750;line-height:1.35;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
      #zce-panel .zce-summary-card.zce-summary-selected .zce-summary-label,#zce-panel .zce-summary-card.zce-summary-selected .zce-summary-number{color:#8ce7b3}
      #zce-panel #zce-user-name.zce-name-empty,#zce-panel #zce-name{border:1px solid #52c58b;box-shadow:none}
      #zce-panel .zce-exclude-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0 4px;color:#bdbdc9;font-size:11px}
      #zce-panel .zce-exclude-heading strong{flex:none;font-weight:700}
      #zce-panel .zce-filter{display:flex;align-items:center;gap:8px;padding:7px 2px;font-size:12px}
      #zce-panel .zce-filter input{width:17px;height:17px;flex:none;accent-color:#42b878}
      #zce-panel .zce-preview{max-height:290px;overflow:auto;border:1px solid #454550;border-radius:10px;padding:4px}
      #zce-panel .zce-msg-card{border:1px solid #53535e;border-radius:9px;background:#2b2b35;padding:9px;margin:6px 0;cursor:pointer;outline:none;overflow-wrap:anywhere}
      #zce-panel .zce-msg-card.zce-is-chosen{border:2px solid #50cf8b;background:#273b32;padding:8px}
      #zce-panel .zce-msg-card:focus-visible{outline:2px solid #8fdab5}
      #zce-panel .zce-card-head{display:flex;justify-content:space-between;gap:8px;font-size:12px;font-weight:700;margin-bottom:6px;color:#e8f2e9}
      #zce-panel .zce-card-text{white-space:pre-wrap;font:12px/1.55 system-ui;color:#e0dfea}
      #zce-panel .zce-card-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;min-height:2px}
      #zce-panel .zce-card-actions .zce-more{flex:none;padding:3px 6px;font-size:11px}
      #zce-panel .zce-skip-tag{margin-right:auto;font-size:10px;color:#f6c680}
      #zce-panel .zce-note{color:#bdbdc9;font-size:11px;margin:6px 0}
      #zce-panel .zce-user-label{display:block;font-size:12px;font-weight:600;margin-top:16px}
      #zce-panel details{border-top:1px solid #54545b;border-bottom:1px solid #54545b;margin-top:18px;padding:7px 0}
      #zce-panel summary{cursor:pointer;font-weight:700}
      #zce-panel .zce-size-control{margin:9px 0}
      #zce-panel .zce-size-control input[type="range"]{display:block;width:100%;margin-top:6px;accent-color:#52c58b}
      html.zce-select-mode .zce-site-selected{outline:3px solid #49ce88!important;outline-offset:2px!important;border-radius:8px!important}
      #zce-tip{position:fixed;z-index:2147483647;left:50%;top:calc(18px + env(safe-area-inset-top,0px));transform:translateX(-50%);background:#263a30;color:white;border:1px solid #6ad39b;border-radius:10px;padding:8px 12px;max-width:min(340px,calc(100vw - 20px));font:12px/1.4 system-ui;text-align:center;pointer-events:none}
    `;
    (document.head||document.documentElement).appendChild(style);
    launch=document.createElement('button');launch.id='zce-launch';launch.type='button';
    launchLabel=document.createElement('span');launchLabel.textContent='대화 저장';
    launchCount=document.createElement('span');launchCount.className='zce-selection-count';launchCount.hidden=true;
    launch.append(launchLabel,launchCount);
    panel=document.createElement('section');panel.id='zce-panel';panel.hidden=true;
    panel.innerHTML=`
      <div class="zce-head" id="zce-drag-head"><strong style="flex:1;font-size:15px">제타 대화 내보내기</strong><span class="zce-drag-label">↕ 이동</span><button data-act="close" type="button">닫기</button></div>
      <div class="zce-status" id="zce-info"></div>
      <div class="zce-summary-cards" id="zce-summary" aria-live="polite">
        <div class="zce-summary-card"><span class="zce-summary-label">수집한 대화</span><strong class="zce-summary-number" id="zce-collected-count">0</strong></div>
        <div class="zce-summary-card zce-summary-selected"><span class="zce-summary-label">선택한 대화</span><strong class="zce-summary-number" id="zce-selected-count">0</strong></div>
      </div>
      <div class="zce-row"><button id="zce-load" class="zce-primary-action" data-act="load">과거 대화 불러오기</button><button id="zce-stop" data-act="stop">중지</button></div>
      <div class="zce-note">제타 채팅방에서 과거 대화와 상태창을 함께 불러옵니다. 상태창이 없는 방에서도 그대로 작동합니다. 번호는 오래된 순서부터 매겨집니다.</div>
      <div class="zce-row"><button data-act="recent" data-n="5">최근 5</button><button data-act="recent" data-n="10">최근 10</button><button data-act="recent" data-n="50">최근 50</button><button data-act="recent" data-n="100">최근 100</button></div>
      <div class="zce-row"><button data-act="all">전체 선택</button><button data-act="clear">선택 해제</button></div>
      <div class="zce-row"><input id="zce-start" type="number" min="1" placeholder="시작 번호"><input id="zce-end" type="number" min="1" placeholder="끝 번호"><button data-act="range">범위 추가</button></div>
      <div class="zce-row"><button data-act="select-mode" id="zce-select-mode-btn">화면 말풍선 직접 선택</button><button data-act="preview">대화 카드 선택 열기/닫기</button></div>
      <div class="zce-note">화면 선택 모드에서는 제타 말풍선을 누르면 선택/해제됩니다. 화면에 없는 과거 대화는 아래 카드 목록에서 선택하세요. 말풍선이 연결되지 않을 경우에도 카드 선택은 가능합니다.</div>
      <div class="zce-note" id="zce-list-note"></div>
      <div class="zce-preview" id="zce-list" hidden></div>
      <div class="zce-row"><button data-act="more-older" id="zce-more-older" hidden>이전 대화 40개 더 표시</button></div>
      <div class="zce-exclude-heading"><strong>저장 시 제외할 내용</strong></div>
      <label class="zce-filter"><input type="checkbox" id="zce-remove-ooc" checked> <b>OOC: 포함 메시지 전체 제외</b></label>
      <label class="zce-filter"><input type="checkbox" id="zce-remove-summary" checked> <b>「요약」 포함 메시지 전체 제외</b></label>
      <label class="zce-filter"><input type="checkbox" id="zce-remove-info"> 상태창 제외</label>
      <label class="zce-filter"><input type="checkbox" id="zce-remove-code"> 일반 코드블록 제외</label>
      <label class="zce-filter"><input type="checkbox" id="zce-remove-time" checked> 날짜/시간 제거 (TXT)</label>
      <label class="zce-user-label" for="zce-user-name">사용자 이름 <span class="zce-note">(비워두면 사용자)</span></label>
      <input id="zce-user-name" class="zce-name-empty" type="text" placeholder="사용자" maxlength="60" autocomplete="off" style="width:100%;margin:5px 0 8px">
      <div style="margin-top:10px">파일명 <input id="zce-name" value="제타_대화" style="width:100%"></div>
      <div class="zce-row"><button class="zce-primary-action" data-act="txt">TXT 저장</button><button class="zce-primary-action" data-act="json">JSON 저장</button></div>
      <details id="zce-ui-settings"><summary>창·버튼 위치 및 크기 설정</summary>
        <div class="zce-note">버튼은 직접 드래그해 옮길 수 있고, 이 창은 상단 제목 영역을 드래그하면 이동합니다. 설정은 브라우저에 저장됩니다.</div>
        <div class="zce-size-control"><label for="zce-button-size">버튼 크기: <span id="zce-button-size-label">100%</span></label><input id="zce-button-size" type="range" min="60" max="160" step="10" value="100"></div>
        <div class="zce-size-control"><label for="zce-panel-size">창 크기: <span id="zce-panel-size-label">100%</span></label><input id="zce-panel-size" type="range" min="70" max="130" step="10" value="100"></div>
        <div class="zce-row"><button data-act="reset-ui">위치·크기 기본값 복원</button></div>
      </details>`;
    document.body.append(launch,panel);
    status=panel.querySelector('#zce-info');summary=panel.querySelector('#zce-summary');
    list=panel.querySelector('#zce-list');listNote=panel.querySelector('#zce-list-note');
    startInput=panel.querySelector('#zce-start');endInput=panel.querySelector('#zce-end');
    addDrag(launch,launch,'button');
    addDrag(panel.querySelector('#zce-drag-head'),panel,'panel');
    launch.addEventListener('click',e=>{
      if(draggedLaunch){e.preventDefault();draggedLaunch=false;return;}
      panel.hidden=!panel.hidden;
      if(!panel.hidden)applyUi();
      update();
    });
    const userNameInput=panel.querySelector('#zce-user-name');
    const updateNameOutline=()=>userNameInput.classList.toggle('zce-name-empty',!userNameInput.value.trim());
    userNameInput.addEventListener('input',updateNameOutline);
    userNameInput.addEventListener('change',updateNameOutline);
    updateNameOutline();
    panel.addEventListener('input',e=>{
      if(e.target.id==='zce-button-size'){ui.buttonSize=Number(e.target.value);saveUi();applyUi();}
      if(e.target.id==='zce-panel-size'){ui.panelSize=Number(e.target.value);saveUi();applyUi();}
    });
    panel.addEventListener('click',e=>{
      const b=e.target.closest('button[data-act]');if(!b)return;
      const act=b.dataset.act;
      if(act==='close')panel.hidden=true;
      else if(act==='load')load();
      else if(act==='stop'){stopped=true;aborter?.abort();}
      else if(act==='recent')pickRecent(Number(b.dataset.n));
      else if(act==='all'){messages.forEach(m=>chosen.add(m.id));update();}
      else if(act==='clear'){chosen.clear();update();}
      else if(act==='range')chooseRange();
      else if(act==='preview'){list.hidden=!list.hidden;update();}
      else if(act==='more-older'){previewLimit+=40;update();}
      else if(act==='select-mode'){
        if(!selectionMode&&!messages.length){setInfo('말풍선을 선택하려면 먼저 과거 대화를 불러오세요.');return;}
        setSelectionMode(!selectionMode);
        if(selectionMode){panel.hidden=true;flashTip('말풍선을 눌러 선택하세요. 대화 저장 버튼을 눌러 창으로 돌아갈 수 있습니다.');}
      }
      else if(act==='reset-ui'){ui=defaultUi();saveUi();applyUi();setInfo('모바일 Safari 기본 위치·크기로 복원했습니다.');}
      else if(act==='txt'||act==='json')download(act);
    });
    applyUi();update();
  }
  let previous=location.pathname+location.search;
  setInterval(()=>{
    if(!panel&&document.body)mount();
    const current=location.pathname+location.search;
    if(previous!==current){
      previous=current;loadEpoch++;stopped=true;aborter?.abort();
      setSelectionMode(false);
      messages=[];chosen.clear();expanded.clear();pageMarked.clear();
      previewLimit=40;pages=0;totalRaw=0;complete=false;
      setInfo('채팅방이 바뀌었습니다. 다시 대화를 불러오세요.');
    }
  },800);
  window.addEventListener('resize',()=>{if(panel){applyUi();}});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();