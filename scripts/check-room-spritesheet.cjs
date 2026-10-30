// Optional browser integration check: node scripts/check-room-spritesheet.cjs
// Uses Chrome on Windows, or the executable supplied in CHROME_PATH. No app credentials needed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const djPresetId = process.env.ROOM_BACKGROUND_PRESET || 'disco-dj-grid-v3';
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const extract = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const code = extract('function normalizeClothingAnimation(', 'function getClothingSpriteFrame(')
    + extract('function getClothingSpriteFrame(', 'function getAdminClothingAnimation(')
    + extract('const roomOverlayImage = new Image();', 'const avatarImage = new Image();')
    + extract('function getBoardFramePlan(', 'function gameLoop(')
    + extract('async function uploadAdminRoomBackground(', 'async function uploadAdminRoomOverlay(')
    + extract('function renderAdminPublicRooms(', 'function drawWardrobeAvatarPreview(');
const fixture = `<!doctype html><meta charset="utf-8"><style>${html.match(/<style>([\s\S]*?)<\/style>/)[1]}</style>
<div id="rooms"></div><p id="status"></p><script src="/room-spritesheet.js"></script><script>
const adminPublicRooms=document.getElementById('rooms'), adminRoomsStatus=document.getElementById('status');
const activeRoom='none', sent=[], socket={connected:true,emit:(event,payload)=>sent.push({event,payload})};
const requestBoardRender=()=>{}, roomBackgroundImageLoaded=false, roomBackgroundAnimation={frames:1},
    isAdminInvisible=false, players={}, whisperBubbles=new Map(), activeSidePanel='none',
    wardrobePanel={hidden:true}, adminClothingView={hidden:true};${code}</script>`;
const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fixture); }
    const file = path.resolve(__dirname, '../public', '.' + req.url.split('?')[0]);
    if (!file.startsWith(path.resolve(__dirname, '../public') + path.sep) || !fs.existsSync(file)) {
        res.statusCode = 404; return res.end();
    }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'image/png');
    fs.createReadStream(file).pipe(res);
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-spritesheet-check-'));
    const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
    ], { windowsHide: true, stdio: 'ignore' });
    browser.on('error', (error) => console.error(error.message));
    let ws;
    try {
        const portFile = path.join(profile, 'DevToolsActivePort');
        for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await delay(50);
        const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
        const page = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}/`)}`, { method: 'PUT' })).json();
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
        let id = 0;
        const pending = new Map();
        ws.addEventListener('message', (event) => {
            const value = JSON.parse(event.data);
            if (pending.has(value.id)) { pending.get(value.id)(value); pending.delete(value.id); }
        });
        const call = (method, params = {}) => new Promise((resolve) => {
            pending.set(++id, resolve); ws.send(JSON.stringify({ id, method, params }));
        });
        await call('Runtime.enable');
        let loaded;
        for (let i = 0; i < 100; i++) {
            loaded = await call('Runtime.evaluate', { expression: 'typeof RoomSpritesheet === "object" && typeof renderAdminPublicRooms === "function"', returnByValue: true });
            if (loaded.result?.result?.value) break;
            await delay(50);
        }
        assert.equal(loaded.result.result.value, true);
        const result = await call('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async()=>{
            const check=(condition,message)=>{if(!condition)throw Error(message)};
            const settings={columns:2,rows:2,frames:4,fps:3};
            const load=async(url)=>{const image=new Image();image.src=url;await image.decode();return image};
            const fixed=await load('/images/disco-background-spritesheet.png');
            check(RoomSpritesheet.hasDistinctFrames(fixed,settings),'new asset should animate');
            const duplicate=document.createElement('canvas'); duplicate.width=3072;duplicate.height=2048;
            const base=await load('/images/disco-background.png');
            for(let f=0;f<4;f++)duplicate.getContext('2d').drawImage(base,f%2*1536,Math.floor(f/2)*1024);
            const duplicateFile=new File([await new Promise(r=>duplicate.toBlob(r))],'duplicate.png',{type:'image/png'});
            const status=document.createElement('span');
            check(!await uploadAdminRoomBackground('disco',duplicateFile,status,settings,'spritesheet'),'duplicates rejected');
            check(status.textContent.startsWith('Alle valgte frames er ens.'),'duplicate explanation');
            check(sent.length===0,'duplicates never uploaded');
            renderAdminPublicRooms([{id:'disco',roomNumber:2,name:'Disco',floorNumber:1,count:0,isSystem:true,
                backgroundAnimation:{columns:1,rows:1,frames:1,fps:8},spritesheetBackgroundAnimation:settings}]);
            check(document.querySelector('.admin-room-animation input').value==='4','saved sprite settings survive static mode');
            const presets=document.querySelector('.admin-room-background-library select');
            for(let i=0;i<200&&presets.options.length<2;i++)await new Promise(r=>setTimeout(r,25));
            check(presets.options.length>=2,'catalog loaded');
            presets.value=${JSON.stringify(djPresetId)};presets.dispatchEvent(new Event('change'));
            for(let i=0;i<200&&!document.querySelector('.admin-room-sprite-preview img');i++)await new Promise(r=>setTimeout(r,25));
            const preview=document.querySelector('.admin-room-sprite-preview');
            check(preview&&!preview.hidden,'preview visible');
            const image=preview.querySelector('img');
            check(image.naturalWidth===3072&&image.naturalHeight===1024,'original sheet preserved');
            const animation=image.getAnimations()[0];check(animation,'preview animates');animation.pause();
            const positions=[];
            for(const time of [10,400,750,1100]){animation.currentTime=time;positions.push(getComputedStyle(image).transform);}
            check(new Set(positions).size===4,'preview visits all four cells');
            check(sent.length===0,'preview does not publish');
            const activate=document.querySelector('.admin-room-background-library button');
            check(!activate.disabled,'preset ready to activate');activate.click();activate.click();
            for(let i=0;i<200&&sent.length===0;i++)await new Promise(r=>setTimeout(r,25));
            check(sent.length===1&&sent[0].event==='admin-public-room-background-upload','one upload emitted');
            const upload=sent[0].payload;
            check(upload.image.length<=950000&&upload.type==='spritesheet','size and type valid');
            check(upload.id==='disco','chosen room receives preset');
            check(upload.clearOverlay===false&&upload.overlay,'preset includes its foreground');
            check(upload.animation.frames===8&&upload.animation.columns===4&&upload.animation.rows===2&&upload.animation.fps===6,'metadata valid');
            const url=URL.createObjectURL(new Blob([upload.image],{type:'image/webp'}));
            check(RoomSpritesheet.hasDistinctFrames(await load(url),upload.animation),'compressed frames still animate');
            URL.revokeObjectURL(url);
            const frames=document.querySelector('.admin-room-animation input');
            frames.value='3';frames.dispatchEvent(new Event('input'));
            check(activate.disabled&&presets.value==='','manual edits clear preset activation');
            sent.length=0;
            presets.value=${JSON.stringify(djPresetId)};presets.dispatchEvent(new Event('change'));
            for(let i=0;i<200&&(activate.disabled||preview.querySelectorAll('img').length!==2);i++)await new Promise(r=>setTimeout(r,25));
            check(!activate.disabled&&preview.querySelectorAll('img').length===2,'DJ background and foreground preview together');
            const overlay=preview.querySelectorAll('img')[1];
            check(overlay.getAnimations()[0],'foreground animates');
            activate.click();
            for(let i=0;i<200&&sent.length===0;i++)await new Promise(r=>setTimeout(r,25));
            check(sent.length===1,'DJ activates atomically');
            const dj=sent[0].payload;
            check(dj.animation.frames===8&&dj.animation.fps===6,'DJ frames correct');
            check(dj.overlay.image.length<=850000&&dj.overlay.animation.frames===8,'foreground metadata and image uploaded');
            check(dj.openCells.includes('-1:1')&&dj.clearOverlay===false,'DJ standing cell opened');
            check(dj.closedCells.includes('-1:2'),'desk tile stays blocked');
            check(dj.image.length<=950000,'DJ sheet fits upload limit');
            const preset=(await RoomSpritesheet.loadCatalog()).find(entry=>entry.id===${JSON.stringify(djPresetId)});
            setRoomOverlay(preset.overlay.url,{x:0,y:0,rotation:0,scale:1,animation:dj.overlay.animation});
            for(let i=0;i<100&&!roomOverlayImageLoaded;i++)await new Promise(r=>setTimeout(r,20));
            check(roomOverlayImageLoaded,'live foreground loads');
            const now=Date.now(), plan=getBoardFramePlan(now);
            check(Number.isFinite(plan.nextAt)&&plan.nextAt-now<170,'live renderer schedules foreground animation');
            const first=getClothingSpriteFrame(roomOverlayImage,roomOverlayAnimation,0);
            const second=getClothingSpriteFrame(roomOverlayImage,roomOverlayAnimation,170);
            check(first.sx===0&&second.sx===768&&first.sw===768,'live renderer crops individual foreground frames');
            const samples=document.createElement('canvas');samples.width=768;samples.height=512;
            const sampleContext=samples.getContext('2d',{willReadFrequently:true});
            sampleContext.drawImage(roomOverlayImage,0,0,768,512,0,0,768,512);
            const firstPixels=new Uint8ClampedArray(sampleContext.getImageData(80,65,145,50).data);
            sampleContext.clearRect(0,0,768,512);
            sampleContext.drawImage(roomOverlayImage,768,0,768,512,0,0,768,512);
            const secondPixels=sampleContext.getImageData(80,65,145,50).data;
            check(secondPixels.some((v,i)=>Math.abs(v-firstPixels[i])>10),'record markings rotate between adjacent frames');
            const alpha=sampleContext.getImageData(0,0,768,512).data;
            check(alpha[3]===0&&alpha[(300*768+400)*4+3]===0,'foreground whitespace stays transparent');
            setRoomOverlay('/images/disco-background.png',{});
            for(let i=0;i<100&&!roomOverlayImageLoaded;i++)await new Promise(r=>setTimeout(r,20));
            check(!Number.isFinite(getBoardFramePlan(Date.now()).nextAt),'static foreground stops animation timers');
            return {result:'PASS: catalog, preview, one-click DJ bundle, overlay, standing cell and compression',bytes:upload.image.length,djBytes:dj.image.length,overlayBytes:dj.overlay.image.length,positions};
        })()` });
        if (result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
        console.log(JSON.stringify(result.result.result.value, null, 2));
    } finally {
        if (ws) ws.close();
        browser.kill();
        server.close();
    }
})().catch((error) => { console.error(error); process.exitCode = 1; server.close(); });
