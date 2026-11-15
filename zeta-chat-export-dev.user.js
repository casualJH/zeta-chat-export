// ==UserScript==
// @name         제타 대화 내보내기 (DEV)
// @namespace    zeta-chat-export-dev
// @version      1.2.0-beta.4
// @updateURL    https://raw.githubusercontent.com/casualJH/zeta-chat-export/dev/zeta-chat-export-dev.user.js
// @downloadURL  https://raw.githubusercontent.com/casualJH/zeta-chat-export/dev/zeta-chat-export-dev.user.js
// @homepageURL  https://github.com/casualJH/zeta-chat-export
// @description  제타 대화·상태창 불러오기, 선택 및 TXT/JSON 내보내기
// @match        https://zeta-ai.io/*
// @match        https://*.zeta-ai.io/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==
(function () {
  'use strict';
  if (window.__zetaChatExportDev0118) return;
  window.__zetaChatExportDev0118 = true;
  const VERSION = '1.2.0-beta.4';
  const apiOrigin = 'https://api.zeta-ai.io';
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const headerNames = ['authorization','x-client-native-version','x-client-type','x-client-version','x-device-type','x-user-language'];
  let captured = null, roomFromRequest = null, roomPath = null;
  let messages = [], turns = [], chosen = new Set(), running = false, aborter = null, stopped = false;
  let groupMode='turn'; // Default: whole turns; message mode uses original API messages.
  const savedChoices={turn:new Set(),message:new Set()};
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
    running=true;stopped=false;complete=false;pages=0;totalRaw=0;messages=[];turns=[];chosen.clear();savedChoices.turn.clear();savedChoices.message.clear();expanded.clear();pageMarked.clear();previewLimit=40;
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
        pages=p;totalRaw=seen.size;messages=normalize(collected);turns=buildTurns(messages);update();
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
  // The opening scene (all CHARACTER responses before the first USER) is
  // always exactly one introductory turn. Once the first USER appears, each
  // independent CHARACTER message completes a new turn; consecutive USER
  // messages belong to the next CHARACTER. Trailing USER input is incomplete.
  // A message's multiple contents, including narrator/character speech,
  // remain one response because they share messageId.
  function buildTurns(parts){
    const result=[], pendingUsers=[];
    const firstUserIndex=parts.findIndex(p=>p.role==='user');
    const introEnd=firstUserIndex<0?parts.length:firstUserIndex;
    if(introEnd>0){
      const opening=parts.slice(0,introEnd);
      const first=opening[0];
      result.push({
        id:'opening-'+String(first.messageId||first.id),
        unpaired:true,incomplete:false,isIntro:true,
        parts:opening,user:[],character:opening.slice()
      });
    }
    let current=null,lastId=null;
    for(const part of parts.slice(introEnd)){
      const id=String(part.messageId||part.id);
      if(part.role==='user'){
        pendingUsers.push(part);
        current=null;
      }else{
        if(id!==lastId||!current){
          current={
            id:'turn-'+id,unpaired:!pendingUsers.length,
            incomplete:false,isIntro:false,
            parts:pendingUsers.splice(0),user:[],character:[]
          };
          current.user=current.parts.slice();
          result.push(current);
        }
        current.character.push(part);
        current.parts.push(part);
      }
      lastId=id;
    }
    if(pendingUsers.length){
      const first=pendingUsers[0];
      result.push({
        id:'incomplete-'+String(first.messageId||first.id),
        unpaired:false,incomplete:true,isIntro:false,
        parts:pendingUsers.slice(),user:pendingUsers.slice(),character:[]
      });
    }
    return result;
  }
  function displayGroups(){
    if(groupMode==='turn')return turns.map(t=>({id:t.id,parts:t.parts,label:(t.incomplete?'미완성 턴':t.isIntro?'인트로':'턴')}));
    const groups=[],byId=new Map();
    for(const part of messages){
      const id=String(part.messageId||part.id);
      if(!byId.has(id)){const g={id,parts:[],label:'메시지'};groups.push(g);byId.set(id,g);}
      byId.get(id).parts.push(part);
    }
    return groups;
  }
  function addGroup(group){group.parts.forEach(p=>chosen.add(p.id));}
  function removeGroup(group){group.parts.forEach(p=>chosen.delete(p.id));}
  function groupSelected(group){return group.parts.length>0&&group.parts.every(p=>chosen.has(p.id));}
  function selectedGroupCount(){return displayGroups().filter(groupSelected).length;}
  function switchGroupMode(next){
    if(next===groupMode||!['turn','message'].includes(next))return;
    if(selectionMode)setSelectionMode(false);
    savedChoices[groupMode]=chosen;
    groupMode=next;
    chosen=savedChoices[next];
    expanded.clear();previewLimit=40;
    update();
    setInfo(groupMode==='turn'?'턴 단위로 선택합니다. 말풍선 하나를 누르면 해당 턴 전체가 선택됩니다.':'원본 메시지 단위로 선택합니다.');
  }
  function setInfo(s){info=s;update();}
  function selectedRows(){return messages.filter(m=>chosen.has(m.id));}
  function pickRecent(n){
    let count=0;const groups=displayGroups();
    for(let i=groups.length-1;i>=0&&count<n;i--){
      if(!groupSelected(groups[i])){addGroup(groups[i]);count++;}
    }
    update();
  }
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
  // Copy the same filtered, formatted content used for TXT export.
  // The click handler invokes this without a prior await to preserve user activation
  // on mobile Safari. If the modern API fails, try the legacy text selection route.
  let copyFeedbackTimer=null;
  let copyBusy=false;
  function showCopyFeedback(state){
    const button=panel?.querySelector('#zce-copy-txt');
    if(!button)return;
    if(copyFeedbackTimer!==null){clearTimeout(copyFeedbackTimer);copyFeedbackTimer=null;}
    button.dataset.copyState=state;
    button.textContent=state==='pending'?'복사 중…':state==='success'?'✓ 복사 완료':state==='error'?'복사 실패':'클립보드 복사';
    button.disabled=state==='pending';
    if(state==='success'||state==='error'){
      copyFeedbackTimer=setTimeout(()=>{
        copyFeedbackTimer=null;
        button.dataset.copyState='';
        button.textContent='클립보드 복사';
        button.disabled=false;
      },1000);
    }
  }
  async function copyToClipboard(){
    if(copyBusy)return;
    copyBusy=true;
    showCopyFeedback('pending');
    try {
      await performClipboardCopy();
    } finally { copyBusy=false; }
  }
  async function performClipboardCopy(){
    const rows=exportRows();
    if(!rows.length){showCopyFeedback('error');setInfo('복사할 본문이 없습니다. 선택 또는 제외 옵션을 확인하세요.');return;}
    const removeTime=!!panel.querySelector('#zce-remove-time')?.checked;
    const userName=customUserName();
    const content=rows.map(m=>formatLine(m,removeTime,userName)).join('\n\n');
    let copied=false;
    try {
      if(navigator.clipboard?.writeText){
        await navigator.clipboard.writeText(content);
        copied=true;
      }
    } catch (_) {}
    if(!copied){
      const area=document.createElement('textarea');
      area.value=content;
      area.setAttribute('readonly','');
      area.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;z-index:-1';
      document.body.appendChild(area);
      try {
        area.focus();area.select();area.setSelectionRange(0,area.value.length);
        copied=!!document.execCommand('copy');
      } catch (_) {} finally {area.remove();}
    }
    showCopyFeedback(copied?'success':'error');
    setInfo(copied
      ? `선택 ${chosen.size}개 중 제외 조건 적용 후 ${rows.length}개 대화를 클립보드에 복사했습니다.`
      : '클립보드 복사에 실패했습니다. Safari 클립보드 권한을 확인하거나 TXT 저장을 이용하세요.');
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
  const defaultUi=()=>({buttonSize:100,buttonPos:null,panelPos:null,panelWidth:null,panelHeight:null});
  function readUi() {
    try {
      const data=JSON.parse(localStorage.getItem(UI_KEY)||'{}');
      return {
        buttonSize:Number.isFinite(data.buttonSize)?Math.max(60,Math.min(160,data.buttonSize)):100,
        buttonPos:data.buttonPos&&Number.isFinite(data.buttonPos.x)&&Number.isFinite(data.buttonPos.y)?data.buttonPos:null,
        panelPos:data.panelPos&&Number.isFinite(data.panelPos.x)&&Number.isFinite(data.panelPos.y)?data.panelPos:null,
        panelWidth:Number.isFinite(data.panelWidth)&&data.panelWidth>0?data.panelWidth:null,
        panelHeight:Number.isFinite(data.panelHeight)&&data.panelHeight>0?data.panelHeight:null
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
    panel.style.width='';
    panel.style.maxHeight='';
    // A manually resized panel uses exact pixel dimensions. Keep the previous
    // Safari default dimensions until the triangular handle is actually dragged.
    if(Number.isFinite(ui.panelWidth)&&Number.isFinite(ui.panelHeight)){
      const maxW=Math.max(1,window.innerWidth-8);
      const maxH=Math.max(1,window.innerHeight-8);
      panel.style.width=Math.round(clamp(ui.panelWidth,Math.min(260,maxW),maxW))+'px';
      panel.style.height=Math.round(clamp(ui.panelHeight,Math.min(240,maxH),maxH))+'px';
      panel.style.maxHeight='none';
    }else panel.style.height='';
    // Preserve original mobile Safari right/bottom + safe-area defaults until moved.
    setAbsPosition(launch,ui.buttonPos);
    if(!panel.hidden){
      setAbsPosition(panel,ui.panelPos);
      // If viewport dimensions shrink, keep both edges of the window visible.
      if(ui.panelPos){ui.panelPos={x:parseFloat(panel.style.left),y:parseFloat(panel.style.top)};}
    }
    const bRange=panel.querySelector('#zce-button-size');
    if(bRange)bRange.value=ui.buttonSize;
    const bLabel=panel.querySelector('#zce-button-size-label');
    if(bLabel)bLabel.textContent=ui.buttonSize+'%';
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
  // Same lower-right ◢ resize handle as zeta-text-library.
  // Pointer Events support mouse, touch and mobile Safari. Save pixel size in
  // the existing UI key so refreshing or changing rooms retains the geometry.
  function addResizeGrip(grip){
    grip.addEventListener('pointerdown',down=>{
      if(down.button!==undefined&&down.button!==0)return;
      down.preventDefault();
      down.stopPropagation();
      const rect=panel.getBoundingClientRect();
      const pointerId=down.pointerId,startX=down.clientX,startY=down.clientY;
      const minW=Math.min(260,Math.max(1,window.innerWidth-8));
      const minH=Math.min(240,Math.max(1,window.innerHeight-8));
      // Fix the current top-left corner before changing dimensions; without
      // this a right/bottom positioned panel grows towards the wrong corner.
      const left=clamp(rect.left,4,Math.max(4,window.innerWidth-minW-4));
      const top=clamp(rect.top,4,Math.max(4,window.innerHeight-minH-4));
      const maxW=Math.max(minW,window.innerWidth-left-4);
      const maxH=Math.max(minH,window.innerHeight-top-4);
      panel.style.left=left+'px';panel.style.top=top+'px';
      panel.style.right='auto';panel.style.bottom='auto';
      panel.style.width=rect.width+'px';panel.style.height=rect.height+'px';
      panel.style.maxHeight='none';
      let moved=false;
      function move(e){
        if(e.pointerId!==pointerId)return;
        const dx=e.clientX-startX,dy=e.clientY-startY;
        if(!moved&&Math.hypot(dx,dy)<5)return;
        moved=true;e.preventDefault();
        ui.panelWidth=clamp(rect.width+dx,minW,maxW);
        ui.panelHeight=clamp(rect.height+dy,minH,maxH);
        panel.style.width=ui.panelWidth+'px';
        panel.style.height=ui.panelHeight+'px';
      }
      function end(e){
        if(e.pointerId!==pointerId)return;
        window.removeEventListener('pointermove',move);
        window.removeEventListener('pointerup',end);
        window.removeEventListener('pointercancel',end);
        if(moved){ui.panelPos={x:left,y:top};saveUi();}
        else applyUi();
      }
      window.addEventListener('pointermove',move,{passive:false});
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
  // Prefer Zeta's complete response wrapper. A response may contain several
  // formatted speaker blocks; BodyView alone is too narrow for the desired box.
  // Keep visual marks indexed by response key, not by a descendant DOM element.
  const responseMarks=new Map();
  function responseKey(parts){
    const first=parts[0];
    return first?String(first.messageId||first.id):'';
  }
  function responseContainer(start,matched){
    // A turn may span several blocks, but a message highlight must never use
    // a broad virtualized wrapper containing multiple independent responses.
    if(groupMode==='message'){
      const body=start.closest('[data-sentry-component="BodyView"]') ||
        matched.closest('[data-sentry-component="BodyView"]');
      if(body)return body;
      const wrapper=start.closest('[data-index]');
      if(wrapper&&!wrapper.querySelector('[data-index]')){
        const text=norm(wrapper.innerText||wrapper.textContent||'');
        const candidates=messages.filter(m=>{
          const v=norm(m.text);
          return v.length>=10&&text.includes(v.slice(0,Math.min(45,v.length)));
        });
        if(new Set(candidates.map(m=>String(m.messageId||m.id))).size<=1)return wrapper;
      }
      return matched;
    }
    const wrapper=start.closest('[data-index]');
    if(wrapper&&!wrapper.closest('#zce-panel,#zce-launch'))return wrapper;
    const body=start.closest('[data-sentry-component="BodyView"]') ||
      matched.closest('[data-sentry-component="BodyView"]');
    if(body)return body;
    return matched;
  }
  function matchBubbles(node){
    let el=node instanceof Element?node:node?.parentElement;
    if(!el)return null;
    const initial=el;
    const possible=[];
    for(let depth=0;el&&el!==document.body&&depth<16;el=el.parentElement,depth++){
      if(el===panel||el===launch)return null;
      const attr=[el.getAttribute('data-message-id'),el.getAttribute('data-id'),el.id]
        .find(v=>v&&/MESSAGE-/i.test(v));
      let found=[];
      if(attr)found=messages.filter(m=>m.messageId&&attr.includes(m.messageId));
      if(!found.length){
        const rect=el.getBoundingClientRect();
        if(rect.width<20||rect.height<12)continue;
        const content=norm(el.innerText||el.textContent||'');
        if(!content||content.length>18000)continue;
        const matched=[];
        for(const m of messages){
          const body=norm(m.text);if(!body)continue;
          const sample=body.slice(0,Math.min(55,body.length));
          // Short replies are common ('네', '응'); only match them if unique
          // within the candidate response. Do not mark an arbitrary same-text reply.
          if(content.includes(sample)||(content.length>=2&&body.includes(content)))
            matched.push(m);
          if(matched.length>24)break;
        }
        const ids=new Set(matched.map(m=>String(m.messageId||m.id)));
        if(ids.size===1&&matched.length)found=matched;

      }
      if(!found.length)continue;
      const id=found[0].messageId;
      const parts=id?messages.filter(m=>m.messageId===id):[found[0]];
      possible.push({element:responseContainer(initial,el),items:parts});
      // A narrow match is more trustworthy than a broad ancestor matching all
      // visible conversation. Once found, stop before ascending into the chat.
      break;
    }
    return possible[0]||null;
  }
  // Paint outlines in a separate, pointer-transparent viewport overlay.
  // This does not change Zeta's positioned/virtualized message DOM at all.
  // Visually adjoining selected responses are combined into one rounded outline.
  let highlightLayer=null,highlightFrame=0;
  function clearHighlightLayer(){
    if(highlightFrame){cancelAnimationFrame(highlightFrame);highlightFrame=0;}
    if(highlightLayer){highlightLayer.remove();highlightLayer=null;}
  }
  function scheduleHighlights(){
    if(!selectionMode||highlightFrame)return;
    highlightFrame=requestAnimationFrame(()=>{
      highlightFrame=0;
      drawResponseHighlights();
    });
  }
  // Compute the bottom of Zeta's fixed/sticky top navigation, while avoiding
  // the chat content itself. The overlay is clipped above this edge so its
  // outlines can never appear on top of the app header.
  function chatHeaderBottom(){
    let bottom=0;
    for(const el of document.querySelectorAll('header,[role="banner"],nav')){
      if(el.closest('#zce-panel,#zce-launch,#zce-highlight-layer'))continue;
      const rect=el.getBoundingClientRect();
      if(rect.top>12||rect.bottom<=0||rect.height>180)continue;
      const position=getComputedStyle(el).position;
      if(position==='fixed'||position==='sticky')bottom=Math.max(bottom,rect.bottom);
    }
    // Mobile layouts can use anonymous fixed divs rather than header tags.
    // The safe fallback keeps highlights clear of the browser's top controls.
    return Math.max(bottom,innerWidth<=768?56:0);
  }
  function drawResponseHighlights(){
    if(!selectionMode){clearHighlightLayer();return;}
    if(!highlightLayer){
      highlightLayer=document.createElement('div');
      highlightLayer.id='zce-highlight-layer';
      highlightLayer.setAttribute('aria-hidden','true');
      document.body.appendChild(highlightLayer);
    }
    const visibleTop=Math.min(innerHeight,Math.ceil(chatHeaderBottom()+5));
    highlightLayer.style.clipPath=`inset(${visibleTop}px 0px 0px 0px)`;
    // The full-row fallback is safe only for the merged TURN outline.
    // In MESSAGE mode, [data-index] also occurs on notices, controls and
    // other non-message rows. Its broad fallback falsely outlines those.
    // Always use the precise direct-match message renderer below instead.
    const fullySelectedGroups=displayGroups();
    if(groupMode==='turn'&&fullySelectedGroups.length&&fullySelectedGroups.every(groupSelected)){
      const fullRows=[...document.querySelectorAll('[data-index]')]
        .filter(el=>!el.closest('#zce-panel,#zce-highlight-layer,#zce-launch')&&!el.querySelector('[data-index]'))
        .map(el=>({el,rect:el.getBoundingClientRect()}))
        .filter(({el,rect})=>rect.width>=24&&rect.height>=12&&
          rect.bottom>visibleTop&&rect.top<innerHeight&&
          (norm(el.innerText||el.textContent||'').length>0||el.querySelector('img,video')));
      if(fullRows.length){
        const addOutline=(left,top,right,bottom)=>{
          const x=Math.max(0,left+2),y=Math.max(0,top+2);
          const toX=Math.min(innerWidth,right-2),toY=Math.min(innerHeight,bottom-2);
          if(toX<=x||toY<=y)return;
          const div=document.createElement('div');
          div.className='zce-highlight-outline';
          div.style.cssText=`left:${x}px;top:${y}px;width:${toX-x}px;height:${toY-y}px`;
          highlightLayer.appendChild(div);
        };
        highlightLayer.replaceChildren();
        if(groupMode==='turn'){
          // One continuous outline covering every visible selected turn.
          addOutline(
            Math.min(...fullRows.map(v=>v.rect.left)),
            Math.min(...fullRows.map(v=>v.rect.top)),
            Math.max(...fullRows.map(v=>v.rect.right)),
            Math.max(...fullRows.map(v=>v.rect.bottom))
          );
        }else{
          // Individual message rows remain independent in message mode.
          for(const {rect} of fullRows)
            addOutline(rect.left,rect.top,rect.right,rect.bottom);
        }
        return;
      }
    }
    if(groupMode==='message'){
      // Full selection can start without a single clicked response mark.
      // Discover ONLY identifiable actual message bodies; generic [data-index]
      // nodes can also be notices, headers, toolbars or editor controls.
      if(fullySelectedGroups.length&&fullySelectedGroups.every(groupSelected)){
        const textBodies=[...new Set(messages.filter(m=>m.kind==='text')
          .map(m=>norm(m.text)).filter(Boolean))];
        const matchingBodies=(element)=>{
          const content=norm(element.innerText||element.textContent||'');
          if(!content)return [];
          // Match text regardless of the body being a single markdown paragraph
          // or a formatted character response with multiple speaker blocks.
          // Short identical replies are matched on an EXACT leaf text, never
          // as a substring of a larger control or another reply.
          const shortLeaves=new Set();
          if(element.children.length===0)shortLeaves.add(content);
          for(const leaf of element.querySelectorAll('p,span,div')){
            if(leaf.children.length!==0)continue;
            const value=norm(leaf.innerText||leaf.textContent||'');
            if(value&&value.length<=8)shortLeaves.add(value);
          }
          return textBodies.filter(body=>body.length>=8
            ?content.includes(body.slice(0,Math.min(55,body.length)))
            :shortLeaves.has(body));
        };
        const rows=[...document.querySelectorAll('[data-index]')]
          .filter(el=>!el.closest('#zce-panel,#zce-launch,#zce-highlight-layer')&&
            !el.querySelector('[data-index]')&&
            !el.closest('header,nav,footer,[role="banner"]'));
        const rects=[];
        for(const row of rows){
          // A row containing form controls or site navigation is not an
          // exported chat message even if it happens to contain matching text.
          if(row.querySelector('input,textarea,[contenteditable="true"]'))continue;
          const r=row.getBoundingClientRect();
          if(r.width<24||r.height<12||r.bottom<=visibleTop||r.top>=innerHeight)continue;
          const bodyViews=[...row.querySelectorAll('[data-sentry-component="BodyView"]')];
          const candidates=bodyViews.length?bodyViews:[row];
          for(const element of candidates){
            const hits=matchingBodies(element);
            if(!hits.length)continue;
            // A broad wrapper containing multiple different replies is not a
            // valid message boundary. Use per-reply BodyView elements instead.
            if(!bodyViews.length&&hits.length>1)continue;
            const rect=element.getBoundingClientRect();
            if(rect.width<24||rect.height<12||rect.bottom<=visibleTop||rect.top>=innerHeight)continue;
            if(rect.height>innerHeight*.85)continue;
            if(rects.some(v=>Math.abs(v.top-rect.top)<3&&Math.abs(v.bottom-rect.bottom)<3))continue;
            rects.push({left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom});
          }
        }
        // Previously clicked messages are already mapped to an exact DOM
        // element and stay visible even if their text is very short.
        for(const mark of responseMarks.values()){
          if(!mark.element.isConnected||!mark.ids.some(id=>chosen.has(id)))continue;
          const r=mark.element.getBoundingClientRect();
          if(r.width<24||r.height<12||r.bottom<=visibleTop||r.top>=innerHeight)continue;
          if(r.height>innerHeight*.85)continue;
          if(!rects.some(v=>Math.abs(v.top-r.top)<3&&Math.abs(v.bottom-r.bottom)<3))
            rects.push({left:r.left,right:r.right,top:r.top,bottom:r.bottom});
        }
        rects.sort((a,b)=>a.top-b.top||a.left-b.left);
        const connected=[];
        for(const box of rects){
          const prev=connected[connected.length-1];
          if(prev&&box.top>=prev.bottom-6&&box.top-prev.bottom<=20&&
            Math.abs(box.left-prev.left)<=32&&Math.abs(box.right-prev.right)<=32){
            prev.left=Math.min(prev.left,box.left);
            prev.right=Math.max(prev.right,box.right);
            prev.bottom=Math.max(prev.bottom,box.bottom);
          }else connected.push({...box});
        }
        highlightLayer.replaceChildren();
        for(const r of connected){
          const x=Math.max(0,r.left+2),y=Math.max(0,r.top+2);
          const right=Math.min(innerWidth,r.right-2),bottom=Math.min(innerHeight,r.bottom-2);
          if(right<=x||bottom<=y)continue;
          const div=document.createElement('div');
          div.className='zce-highlight-outline';
          div.style.cssText=`left:${x}px;top:${y}px;width:${right-x}px;height:${bottom-y}px`;
          highlightLayer.appendChild(div);
        }
        return;
      }
      // Message mode is intentionally strict: do NOT infer a message's
      // rectangle by scanning ancestor text. Such guesses produced enormous
      // boxes crossing several replies. Only directly matched elements may
      // supply a rectangle, and each mark belongs to its exact messageId.
      const groupList=displayGroups();
      const keyToIndex=new Map(groupList.map((g,i)=>[String(g.id),i]));
      const rectangles=[];
      for(const [key,mark] of responseMarks){
        if(!mark.element.isConnected){responseMarks.delete(key);continue;}
        const index=keyToIndex.get(String(key));
        if(index===undefined||!groupList[index].parts.some(p=>chosen.has(p.id)))continue;
        const rect=mark.element.getBoundingClientRect();
        if(rect.width<24||rect.height<12||rect.bottom<=visibleTop||rect.top>=innerHeight)continue;
        // If a fallback selector reaches a chat-sized container, skip it
        // instead of marking unrelated content as selected.
        if(rect.height>innerHeight*0.85 && !mark.element.matches('[data-sentry-component="BodyView"]'))continue;
        rectangles.push({index,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom});
      }
      rectangles.sort((a,b)=>a.index-b.index);
      const outlines=[];
      for(const box of rectangles){
        const prev=outlines[outlines.length-1];
        const contiguous=prev&&box.index===prev.endIndex+1;
        const verticallyNear=prev&&box.top>=prev.bottom-8&&box.top-prev.bottom<=24;
        const horizontallyNear=prev&&Math.abs(box.left-prev.left)<=32&&Math.abs(box.right-prev.right)<=32;
        if(contiguous&&verticallyNear&&horizontallyNear){
          prev.left=Math.min(prev.left,box.left);
          prev.right=Math.max(prev.right,box.right);
          prev.bottom=Math.max(prev.bottom,box.bottom);
          prev.endIndex=box.index;
        }else outlines.push({...box,endIndex:box.index});
      }
      highlightLayer.replaceChildren();
      for(const r of outlines){
        const x=Math.max(0,r.left+2),y=Math.max(0,r.top+2);
        const right=Math.min(innerWidth,r.right-2),bottom=Math.min(innerHeight,r.bottom-2);
        if(right<=x||bottom<=y)continue;
        const div=document.createElement('div');
        div.className='zce-highlight-outline';
        div.style.cssText=`left:${x}px;top:${y}px;width:${right-x}px;height:${bottom-y}px`;
        highlightLayer.appendChild(div);
      }
      return;
    }
    // Turn mode: retain its already-working full-turn highlight behaviour.
    // Inspect only actual Zeta message rows, not the virtualized chat's
    // container. This gives every visible part of a selected turn a box on
    // the FIRST tap, even when the tap occurred in only one of its replies.
    const wrappers=[...document.querySelectorAll('[data-index]')].filter(el=>
      !el.closest('#zce-panel,#zce-highlight-layer') &&
      !el.querySelector('[data-index]'));
    const visible=wrappers.map(el=>{
      const rect=el.getBoundingClientRect();
      if(rect.width<24||rect.height<12||rect.bottom<=visibleTop||rect.top>=innerHeight)return null;
      return {el,rect,text:norm(el.innerText||el.textContent||'')};
    }).filter(Boolean);
    // Preserve every group's original index: visual proximity alone cannot
    // decide adjacency. An unselected turn must always split the outline.
    const allGroups=displayGroups();
    const selectedIndices=[];
    for(let i=0;i<allGroups.length;i++){
      const group=allGroups[i];
      if(group.parts.length&&group.parts.some(p=>chosen.has(p.id)))selectedIndices.push(i);
    }
    const rectangles=[];
    const usedElements=new Set();
    for(const groupIndex of selectedIndices){
      const group=allGroups[groupIndex];
      const chosenParts=group.parts.filter(p=>chosen.has(p.id));
      const groupRects=[];
      for(const entry of visible){
        if(!entry.text||usedElements.has(entry.el))continue;
        // Prefer a distinctive excerpt, so identical short greetings in
        // different turns are not accidentally outlined as the same reply.
        const matched=chosenParts.some(p=>{
          const body=norm(p.text);
          if(!body||body.length<7)return false;
          const excerpt=body.slice(0,Math.min(60,body.length));
          return entry.text.includes(excerpt);
        });
        if(matched){groupRects.push(entry.rect);usedElements.add(entry.el);}
      }
      // Preserve the clicked row even if its content is too short to match
      // unambiguously (e.g. 네, 응, ㅇㅇ).
      for(const mark of responseMarks.values()){
        if(!mark.element.isConnected||usedElements.has(mark.element))continue;
        if(mark.ids.some(id=>chosenParts.some(p=>p.id===id))){
          groupRects.push(mark.element.getBoundingClientRect());
          usedElements.add(mark.element);
        }
      }
      if(!groupRects.length)continue;
      rectangles.push({
        index:groupIndex,
        top:Math.min(...groupRects.map(r=>r.top)),
        bottom:Math.max(...groupRects.map(r=>r.bottom)),
        left:Math.min(...groupRects.map(r=>r.left)),
        right:Math.max(...groupRects.map(r=>r.right))
      });
    }
    // Turn mode: merge all consecutive selected turns into ONE outline.
    // Break a run at every unselected turn, regardless of the pixel distance
    // between boxes. In message mode each selected message remains separate.
    const merged=[];
    const selectedIndexSet=new Set(selectedIndices);
    for(const rect of rectangles){
      const prev=merged[merged.length-1];
      const uninterrupted=groupMode==='turn'&&prev&&
        rect.index>prev.endIndex&&
        Array.from({length:rect.index-prev.endIndex-1},
          (_,offset)=>prev.endIndex+offset+1).every(i=>selectedIndexSet.has(i));
      if(uninterrupted){
        prev.left=Math.min(prev.left,rect.left);
        prev.right=Math.max(prev.right,rect.right);
        prev.top=Math.min(prev.top,rect.top);
        prev.bottom=Math.max(prev.bottom,rect.bottom);
        prev.endIndex=rect.index;
      }else{
        merged.push({...rect,endIndex:rect.index});
      }
    }
    highlightLayer.replaceChildren();
    for(const r of merged){
      const div=document.createElement('div');
      div.className='zce-highlight-outline';
      const x=Math.max(0,r.left+2),y=Math.max(0,r.top+2);
      const right=Math.min(innerWidth,r.right-2),bottom=Math.min(innerHeight,r.bottom-2);
      if(right<=x||bottom<=y)continue;
      div.style.cssText=`left:${x}px;top:${y}px;width:${right-x}px;height:${bottom-y}px`;
      highlightLayer.appendChild(div);
    }
  }
  function updatePageHighlights(){
    // Undo older beta marks without manipulating the layout of reply wrappers.
    for(const [key,mark] of responseMarks){
      if(!mark.element.isConnected){responseMarks.delete(key);continue;}
      mark.element.classList.remove('zce-site-selected');
    }
    scheduleHighlights();
  }
  window.addEventListener('scroll',scheduleHighlights,true);
  window.addEventListener('resize',scheduleHighlights);
  function selectedDirectCount(){
    return displayGroups().filter(g=>g.parts.some(p=>chosen.has(p.id))).length;
  }
  function directSelectionLabel(){
    return groupMode==='turn'?'턴':'메시지';
  }
  function setSelectionMode(on){
    selectionMode=!!on;
    document.documentElement.classList.toggle('zce-select-mode',selectionMode);
    if(!selectionMode){
      for(const {element} of responseMarks.values())element.classList.remove('zce-site-selected');
      clearHighlightLayer();
      responseMarks.clear();
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
    const group=groupMode==='turn'
      ?turns.find(t=>t.parts.some(p=>match.items.some(x=>x.id===p.id)))
      :displayGroups().find(g=>g.parts.some(p=>match.items.some(x=>x.id===p.id)));
    if(!group){flashTip('이 말풍선의 선택 단위를 찾을 수 없습니다.');return;}
    const ids=group.parts.map(m=>m.id);
    const shouldAdd=ids.some(id=>!chosen.has(id));
    ids.forEach(id=>shouldAdd?chosen.add(id):chosen.delete(id));
    const key=responseKey(match.items);
    responseMarks.set(key,{element:match.element,ids});
    updatePageHighlights();update();
    flashTip(`${shouldAdd?'선택 완료':'선택 해제'} · 선택 ${directSelectionLabel()} ${selectedDirectCount()}개`);
  }
  document.addEventListener('click',onPageClick,true);
  function update(){
    if(!panel)return;
    status.textContent=info;
    const groups=displayGroups();
    summary.querySelector('#zce-collected-count').textContent=String(groups.length);
    summary.querySelector('#zce-selected-count').textContent=String(groups.filter(g=>g.parts.some(p=>chosen.has(p.id))).length);
    summary.querySelector('#zce-collected-label').textContent=groupMode==='turn'?'수집한 턴':'수집한 메시지';
    summary.querySelector('#zce-selected-label').textContent=groupMode==='turn'?'선택한 턴':'선택한 메시지';
    panel.querySelectorAll('[data-group-mode]').forEach(b=>{const on=b.dataset.groupMode===groupMode;b.dataset.on=String(on);b.setAttribute('aria-pressed',String(on));});
    panel.querySelector('#zce-load').textContent=running?'수집 중...':'과거 대화 불러오기';
    panel.querySelector('#zce-load').disabled=running;
    panel.querySelector('#zce-stop').disabled=!running;
    const modeButton=panel.querySelector('#zce-select-mode-btn');
    modeButton.textContent=selectionMode?'말풍선 선택 종료':'말풍선 직접 선택';
    modeButton.dataset.on=selectionMode?'true':'false';
    launch.classList.toggle('zce-mode-on',selectionMode);
    launchLabel.textContent=selectionMode?'대화 저장 · 선택 중':'대화 저장';
    launchCount.textContent=`선택 ${directSelectionLabel()} ${selectedDirectCount()}개`;
    launchCount.hidden=!selectionMode;
    launch.setAttribute('aria-label',selectionMode?`대화 저장, 현재 선택 ${directSelectionLabel()} ${selectedDirectCount()}개`:'대화 저장');
    if(!list.hidden)renderList();
    updatePageHighlights();
  }
  function renderList(){
    if(!list)return;
    list.textContent='';
    const groups=displayGroups(),count=groups.length,start=Math.max(0,count-previewLimit);
    const fragment=document.createDocumentFragment();
    for(let i=start;i<count;i++){
      const group=groups[i], selected=groupSelected(group);
      const partially=group.parts.some(p=>chosen.has(p.id));
      const card=document.createElement('div');
      card.className='zce-msg-card';card.tabIndex=0;card.setAttribute('role','checkbox');
      card.setAttribute('aria-checked',selected?'true':partially?'mixed':'false');
      if(partially)card.classList.add('zce-is-chosen');
      const head=document.createElement('div');head.className='zce-card-head';
      const who=document.createElement('span');who.textContent=`${i+1}${groupMode==='turn'?'턴':'.'}${groupMode==='turn'?' · ': ' '}${groupMode==='turn'?(turns[i]?.isIntro?'인트로':turns[i]?.incomplete?'미완성 · 사용자':turns[i]?.user.length?'사용자 + 캐릭터':'캐릭터 응답'):(group.parts[0]?.speaker||'메시지')}`;
      const check=document.createElement('span');check.textContent=selected?'✓ 선택됨':partially?'◐ 일부 선택':'＋ 선택';
      head.append(who,check);card.appendChild(head);
      const body=document.createElement('div');body.className='zce-card-text';
      const full=group.parts.map(p=>`${p.speaker}${p.kind==='info_box'?' · 상태창':''}: ${p.text}`).join('\n\n');
      const open=expanded.has(group.id);
      body.textContent=(!open&&full.length>290)?full.slice(0,290)+'…':full;
      card.appendChild(body);
      const actions=document.createElement('div');actions.className='zce-card-actions';
      const reasons=[];
      if(group.parts.some(p=>/ooc\s*:/i.test(p.text)))reasons.push('OOC');
      if(group.parts.some(p=>p.text.includes('요약')))reasons.push('요약');
      if(reasons.length){const label=document.createElement('span');label.className='zce-skip-tag';label.textContent=`감지: ${reasons.join('·')}`;actions.appendChild(label);}
      if(full.length>290){
        const more=document.createElement('button');more.type='button';more.className='zce-more';more.textContent=open?'접기':'전체 보기';
        more.addEventListener('click',e=>{e.stopPropagation();open?expanded.delete(group.id):expanded.add(group.id);renderList();});actions.appendChild(more);
      }
      card.appendChild(actions);
      const toggle=()=>{groupSelected(group)?removeGroup(group):addGroup(group);update();};
      card.addEventListener('click',toggle);
      card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle();}});
      fragment.appendChild(card);
    }
    list.appendChild(fragment);
    listNote.textContent=count
      ?`최근 ${count-start}개 표시 / 총 ${count}${groupMode==='turn'?'턴':'개 메시지'} · 카드를 누르면 선택 · 긴 대화는 전체 보기`
      :'수집된 대화가 없습니다.';
    const older=panel.querySelector('#zce-more-older');older.hidden=!count||start===0;
  }
  function chooseRange(){
    const groups=displayGroups();
    const a=Number(startInput.value),b=Number(endInput.value);
    if(!Number.isInteger(a)||!Number.isInteger(b)||a<1||b<1||a>groups.length||b>groups.length){
      setInfo(`범위는 1~${groups.length} 사이의 ${groupMode==='turn'?'턴':'메시지'} 번호로 입력하세요.`);return;
    }
    for(let i=Math.min(a,b)-1;i<Math.max(a,b);i++)addGroup(groups[i]);
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
      #zce-panel{position:fixed;z-index:2147483646;right:10px;bottom:calc(145px + env(safe-area-inset-bottom,0px));width:min(360px,calc(100vw - 20px));max-height:74vh;overflow:hidden;display:flex;flex-direction:column;background:#202029;color:white;border:1px solid #555;border-radius:14px;padding:13px;font:13px/1.45 system-ui;box-sizing:border-box;box-shadow:0 7px 28px #0008;overscroll-behavior:contain}
      #zce-panel[hidden],#zce-panel [hidden],#zce-tip[hidden]{display:none!important}
      #zce-panel .zce-scroll{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}
      #zce-panel .zce-resize-grip{position:absolute;right:0;bottom:0;width:30px;height:30px;z-index:4;display:flex;align-items:flex-end;justify-content:flex-end;padding:5px;color:#adb4cf;font:19px/1 system-ui;cursor:nwse-resize;touch-action:none;user-select:none;-webkit-user-select:none;background:transparent;border:0;border-radius:0}
      #zce-panel *{box-sizing:border-box}
      #zce-panel button{background:#3b3b49;color:white;border:1px solid #696978;border-radius:7px;padding:8px 7px;font:600 12px system-ui;cursor:pointer;flex:1}
      #zce-panel button:disabled{opacity:.5}
      #zce-panel button.zce-primary-action{background:#2e5c49;border-color:#679b82;color:#fff}
      #zce-panel button.zce-primary-action:active{background:#274d3e}
      #zce-panel button[data-on="true"]{background:#246443;border-color:#69d1a0}
      #zce-panel button.zce-select-all{background:#578a72;border-color:#71a087;color:#fff}
      #zce-panel button.zce-select-all:active{background:#387559}
      #zce-panel #zce-copy-txt[data-copy-state="success"]{background:#394c43;border-color:#6c8e7c;color:#e6f5ea}
      #zce-panel #zce-copy-txt[data-copy-state="error"]{background:#594044;border-color:#ad7c83;color:#ffe7e9}
      #zce-panel #zce-copy-txt[data-copy-state="pending"]{opacity:.85;cursor:wait}
      #zce-panel .zce-head{display:flex;align-items:center;gap:7px;cursor:grab;user-select:none;-webkit-user-select:none;min-height:30px}
      #zce-panel .zce-head button{flex:none}
      #zce-panel .zce-drag-label{color:#bdbdc9;font-size:11px;white-space:nowrap}
      #zce-panel .zce-row{display:flex;gap:5px;margin:7px 0;flex-wrap:wrap}
      #zce-panel .zce-group-heading{font-size:12px;font-weight:700;margin:10px 0 5px}
      #zce-panel .zce-group-toggle{display:flex;gap:4px;border:1px solid #555b62;border-radius:9px;background:#30303a;padding:4px}
      #zce-panel .zce-group-toggle button{border:0;background:transparent;color:#c9ccd1;border-radius:6px;min-height:32px}
      #zce-panel .zce-group-toggle button[data-on="true"]{background:#578a72;color:#fff;border:0}
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
      #zce-highlight-layer{position:fixed;inset:0;z-index:2147483643;pointer-events:none;overflow:hidden;contain:layout style paint}
      #zce-highlight-layer .zce-highlight-outline{position:absolute;pointer-events:none;border:3px solid #49ce88;border-radius:19px;box-sizing:border-box;background:rgba(73,206,136,.025)}
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
      <div class="zce-scroll">
      <div class="zce-status" id="zce-info"></div>
      <div class="zce-summary-cards" id="zce-summary" aria-live="polite">
        <div class="zce-summary-card"><span class="zce-summary-label" id="zce-collected-label">수집한 턴</span><strong class="zce-summary-number" id="zce-collected-count">0</strong></div>
        <div class="zce-summary-card zce-summary-selected"><span class="zce-summary-label" id="zce-selected-label">선택한 턴</span><strong class="zce-summary-number" id="zce-selected-count">0</strong></div>
      </div>
      <div class="zce-group-heading">대화 불러오기 방식</div>
      <div class="zce-group-toggle" role="group" aria-label="대화 불러오기 방식"><button type="button" data-act="group-mode" data-group-mode="turn" data-on="true" aria-pressed="true">턴</button><button type="button" data-act="group-mode" data-group-mode="message" data-on="false" aria-pressed="false">메시지</button></div>
      <div class="zce-row"><button id="zce-load" class="zce-primary-action" data-act="load">과거 대화 불러오기</button><button id="zce-stop" data-act="stop">중지</button></div>
      <div class="zce-note">제타 채팅방에서 과거 대화와 상태창을 함께 불러옵니다. 상태창이 없는 방에서도 그대로 작동합니다. 번호는 오래된 순서부터 매겨집니다.</div>
      <div class="zce-row"><button data-act="recent" data-n="5">최근 5</button><button data-act="recent" data-n="10">최근 10</button><button data-act="recent" data-n="50">최근 50</button><button data-act="recent" data-n="100">최근 100</button></div>
      <div class="zce-row"><button class="zce-select-all" data-act="all">전체 선택</button><button data-act="clear">선택 해제</button></div>
      <div class="zce-row"><input id="zce-start" type="number" min="1" placeholder="시작 번호"><input id="zce-end" type="number" min="1" placeholder="끝 번호"><button data-act="range">범위 추가</button></div>
      <div class="zce-row"><button data-act="select-mode" id="zce-select-mode-btn">말풍선 직접 선택</button><button data-act="preview">대화 카드 선택 열기/닫기</button></div>
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
      <div class="zce-row"><button id="zce-copy-txt" data-act="copy-txt" type="button" aria-live="polite">클립보드 복사</button></div>
      <details id="zce-ui-settings"><summary>창·버튼 위치 및 크기 설정</summary>
        <div class="zce-note">버튼은 직접 드래그해 옮길 수 있고, 창 상단을 드래그하면 위치를 이동합니다. 오른쪽 아래 ◢ 모서리를 드래그하면 창 크기를 조절할 수 있습니다. 설정은 브라우저에 저장됩니다.</div>
        <div class="zce-size-control"><label for="zce-button-size">버튼 크기: <span id="zce-button-size-label">100%</span></label><input id="zce-button-size" type="range" min="60" max="160" step="10" value="100"></div>
        <div class="zce-row"><button data-act="reset-ui">위치·크기 기본값 복원</button></div>
      </details>
      </div><div class="zce-resize-grip" id="zce-resize-grip" title="끌어서 창 크기 조절" aria-label="창 크기 조절">◢</div>`;
    document.body.append(launch,panel);
    status=panel.querySelector('#zce-info');summary=panel.querySelector('#zce-summary');
    list=panel.querySelector('#zce-list');listNote=panel.querySelector('#zce-list-note');
    startInput=panel.querySelector('#zce-start');endInput=panel.querySelector('#zce-end');
    addDrag(launch,launch,'button');
    addDrag(panel.querySelector('#zce-drag-head'),panel,'panel');
    addResizeGrip(panel.querySelector('#zce-resize-grip'));
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
    });
    panel.addEventListener('click',e=>{
      const b=e.target.closest('button[data-act]');if(!b)return;
      const act=b.dataset.act;
      if(act==='close')panel.hidden=true;
      else if(act==='group-mode')switchGroupMode(b.dataset.groupMode);
      else if(act==='load')load();
      else if(act==='stop'){stopped=true;aborter?.abort();}
      else if(act==='recent')pickRecent(Number(b.dataset.n));
      else if(act==='all'){displayGroups().forEach(addGroup);update();}
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
      else if(act==='copy-txt')void copyToClipboard();
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
      messages=[];turns=[];chosen.clear();savedChoices.turn.clear();savedChoices.message.clear();expanded.clear();pageMarked.clear();
      previewLimit=40;pages=0;totalRaw=0;complete=false;
      setInfo('채팅방이 바뀌었습니다. 다시 대화를 불러오세요.');
    }
  },800);
  window.addEventListener('resize',()=>{if(panel){applyUi();}});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();