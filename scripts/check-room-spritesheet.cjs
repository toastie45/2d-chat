// Optional browser integration check: node scripts/check-room-spritesheet.cjs
// Uses Chrome on Windows, or the executable supplied in CHROME_PATH. No app credentials needed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const extract = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const code = extract('function normalizeClothingAnimation(', 'function getClothingSpriteFrame(')
    + extract('async function uploadAdminRoomBackground(', 'async function uploadAdminRoomOverlay(')
    + extract('function renderAdminPublicRooms(', 'function drawWardrobeAvatarPreview(');
const fixture = `<!doctype html><meta charset="utf-8"><style>${html.match(/<style>([\s\S]*?)<\/style>/)[1]}</style>
<div id="rooms"></div><p id="status"></p><script src="/room-spritesheet.js"></script><script>
const adminPublicRooms=document.getElementById('rooms'), adminRoomsStatus=document.getElementById('status');
const activeRoom='none', sent=[], socket={connected:true,emit:(event,payload)=>sent.push({event,payload})};${code}</script>`;
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
            presets.value='disco-lights-v2';presets.dispatchEvent(new Event('change'));
            for(let i=0;i<200&&!document.querySelector('.admin-room-sprite-preview img');i++)await new Promise(r=>setTimeout(r,25));
            const preview=document.querySelector('.admin-room-sprite-preview');
            check(preview&&!preview.hidden,'preview visible');
            const image=preview.querySelector('img');
            check(image.naturalWidth===3072&&image.naturalHeight===2048,'original sheet preserved');
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
            check(JSON.stringify(upload.animation)===JSON.stringify(settings),'metadata valid');
            const url=URL.createObjectURL(new Blob([upload.image],{type:'image/webp'}));
            check(RoomSpritesheet.hasDistinctFrames(await load(url),settings),'compressed frames still animate');
            URL.revokeObjectURL(url);
            const frames=document.querySelector('.admin-room-animation input');
            frames.value='3';frames.dispatchEvent(new Event('input'));
            check(activate.disabled&&presets.value==='','manual edits clear preset activation');
            return {result:'PASS: catalog, preview, one-click activation, duplicate protection and upload compression',bytes:upload.image.length,positions};
        })()` });
        if (result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
        console.log(JSON.stringify(result.result.result.value, null, 2));
    } finally {
        if (ws) ws.close();
        browser.kill();
        server.close();
    }
})().catch((error) => { console.error(error); process.exitCode = 1; server.close(); });
