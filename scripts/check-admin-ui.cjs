// Local browser smoke check; uses fixtures, never touches a live account or database.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const bridge = `window.testUI = {
    setup() {
        currentUser = { id:'1', username:'Tommy' }; myId='self';
        isAdminUser=true; isFullAdminUser=true; canManageClothing=true; canManagePublicRooms=true;
        players={self:{id:'self',name:'Tommy',col:2,row:2,clothing:[]}};
        loginSection.classList.add('hidden'); gameSection.classList.remove('hidden');
        document.getElementById('bottom-toolbar').classList.remove('hidden');
        document.documentElement.classList.remove('auth-checking');
    },
    panel:selectSidePanel,
    admin(value) { selectSidePanel('admin'); adminSectionSelect.value=value; selectAdminSection(); },
    rooms:renderAdminPublicRooms, users:renderAdminOnlineUsers,
    profile(profile) { selectSidePanel('profile-view'); viewingProfilePlayerId=profile.playerId; window.testSocket.receive('profile-info',profile); },
    drawProfileAvatar
};`;
const bridgeAt = html.lastIndexOf("            authFetch('/api/auth/me')\n");
const fixture = html.slice(0, bridgeAt) + bridge + '\n' + html.slice(bridgeAt);
const socketMock = `window.uiErrors=[];window.addEventListener('error',e=>uiErrors.push(e.message));
window.addEventListener('unhandledrejection',e=>uiErrors.push(String(e.reason)));
window.io=()=>window.testSocket={connected:true,id:'self',handlers:{},sent:[],on(e,f){this.handlers[e]=f;return this},emit(e,p){this.sent.push({event:e,payload:p});return this},connect(){},disconnect(){},receive(e,p){return this.handlers[e]?.(p)}};`;
const root = path.resolve(__dirname, '../public');
const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fixture); }
    if (req.url.startsWith('/api/auth/me')) { res.statusCode = 401; res.setHeader('Content-Type', 'application/json'); return res.end('{}'); }
    if (req.url === '/socket.io/socket.io.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(socketMock); }
    const file = path.resolve(root, '.' + req.url.split('?')[0]);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'image/png');
    fs.createReadStream(file).pipe(res);
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-admin-ui-'));
    const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
    ], { windowsHide: true, stdio: 'ignore' });
    let ws;
    try {
        const portFile = path.join(profile, 'DevToolsActivePort');
        for (let i = 0; i < 160 && !fs.existsSync(portFile); i++) await delay(50);
        const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
        const page = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}/`)}`, { method: 'PUT' })).json();
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
        let id = 0; const pending = new Map();
        ws.addEventListener('message', (event) => {
            const value = JSON.parse(event.data);
            if (pending.has(value.id)) { pending.get(value.id)(value); pending.delete(value.id); }
        });
        const call = (method, params = {}) => new Promise((resolve) => { pending.set(++id, resolve); ws.send(JSON.stringify({ id, method, params })); });
        await call('Runtime.enable');
        await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
        for (let i = 0; i < 160; i++) {
            const ready = await call('Runtime.evaluate', { expression: '!!window.testUI', returnByValue: true });
            if (ready.result?.result?.value) break;
            await delay(50);
        }
        const result = await call('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async()=>{
            const check=(condition,message)=>{if(!condition)throw Error(message)};
            const $=id=>document.getElementById(id), visible=id=>!$(id).hidden;
            check(window.testUI,'app initializes: '+JSON.stringify(window.uiErrors)); testUI.setup();
            testUI.panel('welcome'); testUI.panel('chat');
            const back=$('side-back-button').getBoundingClientRect(), detach=$('chat-detach-button').getBoundingClientRect();
            check(detach.right<=back.left-4,'back and detach controls do not overlap');
            testUI.admin('catalog');
            check(visible('admin-catalog-view')&&!visible('admin-clothing-view'),'catalog has its own section');
            testUI.admin('clothing');
            check(visible('admin-clothing-view')&&!visible('admin-catalog-view'),'upload editor is separate');
            check(!$('admin-clothing-level'),'upload no longer sets levels');
            check($('admin-clothing-price').parentElement.textContent.includes('Bobs'),'price uses Bobs');
            testUI.admin('users');testUI.users([{socketId:'guest',userId:'2',username:'Jeppe',isConnected:true,hasKnownIp:true,roomName:'Fællesrum'}]);
            const buttons=[...$('admin-online-users').querySelectorAll('button')];
            check(buttons.map(b=>b.textContent).join(',')==='Hent,Kick,Fængsel,Ban','warning action is between kick and ban');
            buttons[2].click();check($('admin-prison-dialog').open,'warning destination dialog opens');
            $('admin-prison-room').value='/tr 99';$('admin-prison-form').requestSubmit();
            check(testSocket.sent.some(e=>e.event==='admin-user-prison'&&e.payload.destination==='/tr 99'),'warning destination submitted');
            testUI.admin('rooms');testUI.rooms([{id:'common',roomNumber:1,floorNumber:1,count:0,isSystem:true,name:'Fællesrum',requiredLevel:6}]);
            const name=$('admin-public-rooms').querySelector('input[type=text]');check(!name.disabled,'system-room name editable');
            const level=[...$('admin-public-rooms').querySelectorAll('input[type=number]')].find(e=>e.getAttribute('aria-label')?.startsWith('Levelkrav'));
            check(level.value==='6'&&!level.disabled,'saved room level restored');
            name.value='Mødestedet';name.form.requestSubmit();
            check(testSocket.sent.some(e=>e.event==='admin-public-room-update'&&e.payload.name==='Mødestedet'&&e.payload.requiredLevel===6),'system name and level saved');
            testUI.profile({playerId:'user:2',userId:'2',avatarName:'Jeppe',avatarType:'boy',online:false,isOwnProfile:false,level:6,totalOnlineMs:90000000,acceptedChatMessages:500,clothing:[]});
            await new Promise(r=>setTimeout(r,250));testUI.drawProfileAvatar();
            const image=$('profile-outfit-preview');
            check(image.getContext('2d').getImageData(0,0,image.width,image.height).data.some((v,i)=>i%4===3&&v>0),'profile avatar rendered');
            const before=image.toDataURL();
            // A local colored overlay checks saved clothing updates without needing an account.
            const c=document.createElement('canvas');c.width=100;c.height=100;c.getContext('2d').fillStyle='#db3322';c.getContext('2d').fillRect(0,0,100,100);
            testSocket.receive('profile-outfit-updated',{userId:'2',clothing:[{id:'fixture',name:'Test',category:'clothing',imageUrl:c.toDataURL(),x:0,y:0,scale:1}]});
            await new Promise(r=>setTimeout(r,150));testUI.drawProfileAvatar();
            check(before!==image.toDataURL(),'saved outfit changes redraw profile');
            testSocket.receive('profile-outfit-updated',{userId:'2',clothing:[]});
            testUI.drawProfileAvatar();
            check(uiErrors.length===0,'runtime errors: '+uiErrors.join('; '));
            return {result:'PASS: navigation, separate catalog, Bobs, warning transfer, room level, profile rendering and outfit updates'};
        })()` });
        if (result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
        console.log(JSON.stringify(result.result.result.value));
        if (process.env.ADMIN_UI_PREVIEW_PATH) {
            const shot = await call('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(process.env.ADMIN_UI_PREVIEW_PATH, Buffer.from(shot.result.data, 'base64'));
        }
        await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        const mobile = await call('Runtime.evaluate', { returnByValue: true, expression: `(()=>{
            testUI.panel('welcome');testUI.panel('chat');
            const back=document.getElementById('side-back-button').getBoundingClientRect();
            const detach=document.getElementById('chat-detach-button').getBoundingClientRect();
            if(detach.right>back.left-4) throw Error('mobile chat controls overlap');
            testUI.admin('catalog');
            if(document.documentElement.scrollWidth>window.innerWidth+1) throw Error('horizontal mobile overflow');
            return 'PASS: mobile chat controls and panel width';
        })()` });
        if (mobile.result.exceptionDetails) throw new Error(JSON.stringify(mobile.result.exceptionDetails));
        console.log(mobile.result.result.value);
    } finally { ws?.close(); browser.kill(); server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; server.close(); });
