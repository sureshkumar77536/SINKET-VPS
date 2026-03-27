require('dotenv').config();
const express = require('express');
const os = require('os');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ngrok = require('ngrok');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const DB_FILE = path.join(__dirname, 'sinket_db.json');
let db = { vps: [], hosting: [] };
if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
const saveDB = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

let runningSessions = {};

// --- INITIAL SETUP CHECK ---
if (!fs.existsSync('.env')) {
    // Default fallback if no env exists during first boot
    fs.writeFileSync('.env', 'ADMIN_USER=admin\nADMIN_PASS=sinket123\n');
}

// --- AUTHENTICATION ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
        res.json({ success: true, db });
    } else {
        res.status(401).json({ success: false, message: "Invalid Credentials!" });
    }
});

// --- SYSTEM STATS (NATIVE) ---
app.get('/api/stats', (req, res) => {
    const totalMem = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2);
    const freeMem = (os.freemem() / (1024 * 1024 * 1024)).toFixed(2);
    res.json({ totalMem, freeMem, os: 'Ubuntu (CodeSandbox Native)' });
});

// --- LIVE TERMINAL (NATIVE) ---
app.post('/api/terminal-live', (req, res) => {
    const { command } = req.body;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');

    // Running directly in bash (no proot needed)
    const child = spawn('bash', ['-c', command]);

    child.stdout.on('data', (data) => res.write(data.toString()));
    child.stderr.on('data', (data) => res.write(data.toString()));
    child.on('close', () => res.end());
    child.on('error', (err) => { res.write(`\nError: ${err.message}`); res.end(); });
});

// --- CREATE VPS (NATIVE UBUNTU USER) ---
app.post('/api/create-vps', (req, res) => {
    const { vpsName, username, ram, storage } = req.body;
    const sessionId = Date.now(); 
    const safeUser = username.replace(/[^a-z0-9]/g, '').toLowerCase() || 'vpsuser';

    const setupScript = `
        sudo useradd -m -s /bin/bash ${safeUser} 2>/dev/null
        sudo pkill -u ${safeUser} sshx 2>/dev/null
        rm -f /tmp/sshx_${safeUser}.log
        sudo su - ${safeUser} -c "nohup sshx > /tmp/sshx_${safeUser}.log 2>&1 &"
        sleep 4
        cat /tmp/sshx_${safeUser}.log
    `;
    
    const child = spawn('bash', ['-c', setupScript]);
    runningSessions[sessionId] = child;
    let linkGenerated = false;

    const handleData = (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/sshx\.io\/s\/[a-zA-Z0-9_-]+/);
        if(match && !linkGenerated) {
            linkGenerated = true;
            const link = match[0].replace(/\x1B\[[0-9;]*m/g, ''); 
            const newVps = { id: sessionId, vpsName, username: safeUser, ram, storage, link, status: 'Running', date: new Date().toLocaleString() };
            db.vps.push(newVps); saveDB();
            res.json({ success: true, vps: newVps });
        }
    };
    
    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);

    setTimeout(() => {
        if(!linkGenerated) {
            child.kill('SIGKILL'); delete runningSessions[sessionId];
            res.json({ success: false, message: "Timeout: SSHX link not generated." });
        }
    }, 15000); 
});

app.post('/api/kill-vps', (req, res) => {
    const { id, username } = req.body;
    if(runningSessions[id]) { runningSessions[id].kill('SIGKILL'); delete runningSessions[id]; }
    
    // Hard kill user processes
    exec(`sudo pkill -u ${username} sshx`);

    const vpsIndex = db.vps.findIndex(v => v.id === parseInt(id));
    if(vpsIndex !== -1) { db.vps[vpsIndex].status = 'Terminated'; saveDB(); }
    res.json({ success: true, message: "Session terminated!" });
});

// --- WEB HOSTING (WITH STATIC OPTIONS) ---
app.post('/api/host', async (req, res) => {
    const { projectName, htmlCode, provider, ngrokToken, staticDomain, cfToken } = req.body;
    const hostDir = path.join(__dirname, 'hosting', projectName.replace(/\s+/g, '-'));
    
    try {
        if (!fs.existsSync(hostDir)) fs.mkdirSync(hostDir, { recursive: true });
        fs.writeFileSync(path.join(hostDir, 'index.html'), htmlCode);

        const port = 8000 + Math.floor(Math.random() * 1000);
        exec(`cd ${hostDir} && python3 -m http.server ${port} &`);

        if (provider === 'ngrok') {
            if(ngrokToken) await ngrok.authtoken(ngrokToken);
            let opts = { addr: port };
            if(staticDomain) opts.domain = staticDomain; // Existing Tunnel logic
            const url = await ngrok.connect(opts);
            const newSite = { projectName, url, port, provider: 'Ngrok', date: new Date().toLocaleString() };
            db.hosting.push(newSite); saveDB();
            res.json({ success: true, site: newSite });
        } 
        else if (provider === 'cloudflare') {
            let cmdArgs = ['tunnel', '--url', `http://localhost:${port}`];
            if(cfToken) cmdArgs = ['tunnel', 'run', '--token', cfToken]; // Run existing tunnel

            const tunnelChild = spawn('cloudflared', cmdArgs);
            let tunnelUrl = cfToken ? "Linked to Cloudflare Dashboard" : '';
            let linkGenerated = cfToken ? true : false;

            if(!cfToken) {
                tunnelChild.stderr.on('data', (data) => {
                    const output = data.toString();
                    const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
                    if(match && !linkGenerated) {
                        linkGenerated = true;
                        tunnelUrl = match[0];
                        const newSite = { projectName, url: tunnelUrl, port, provider: 'Cloudflare', date: new Date().toLocaleString() };
                        db.hosting.push(newSite); saveDB();
                        res.json({ success: true, site: newSite });
                    }
                });
            } else {
                const newSite = { projectName, url: tunnelUrl, port, provider: 'Cloudflare (Permanent)', date: new Date().toLocaleString() };
                db.hosting.push(newSite); saveDB();
                res.json({ success: true, site: newSite });
            }

            setTimeout(() => {
                if(!linkGenerated) {
                    tunnelChild.kill('SIGKILL');
                    res.json({ success: false, message: "Cloudflare tunnel timeout." });
                }
            }, 10000);
        }
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// --- BACKUP & RESTORE ENGINE ---
app.get('/api/backup', (req, res) => {
    try {
        const dbContent = fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE, 'utf8') : "{}";
        const envContent = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : "";
        const backupObj = { db: JSON.parse(dbContent), env: envContent };
        
        // Encode to Base64 (The Sinket Key)
        const backupKey = Buffer.from(JSON.stringify(backupObj)).toString('base64');
        res.json({ success: true, key: backupKey });
    } catch(e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/api/restore', (req, res) => {
    try {
        const { key } = req.body;
        // Decode Base64
        const decodedStr = Buffer.from(key, 'base64').toString('utf8');
        const backupObj = JSON.parse(decodedStr);

        // Overwrite files
        db = backupObj.db;
        saveDB();
        fs.writeFileSync('.env', backupObj.env);
        
        res.json({ success: true, message: "Migration Successful! Please Restart the Server." });
        
        // Force restart after 2 seconds to apply .env
        setTimeout(() => process.exit(0), 2000);
    } catch(e) {
        res.json({ success: false, message: "Invalid Backup Key!" });
    }
});

// Start Server
app.listen(3000, () => console.log('Sinket VPS Backend Running on Port 3000'));
