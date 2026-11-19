// Redmi 7 Server Monitor -> Discord webhook (1 tin nhan duy nhat, tu dong sua moi 10 phut)
// Yeu cau: Termux + nodejs, termux-api (pkg + app Termux:API), pm2 (da co)

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Doc file .env (khong can cai them thu vien)
function loadEnv(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const raw of txt.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 0) continue;
      const key = line.slice(0, i).trim();
      let val = line.slice(i + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {}
}
loadEnv(path.join(__dirname, '.env'));

// ===== CAU HINH =====
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK || 'DAN_WEBHOOK_URL_VAO_DAY';
const INTERVAL_MS = (parseInt(process.env.INTERVAL_MINUTES, 10) || 10) * 60 * 1000;
const TITLE = process.env.MONITOR_TITLE || 'Redmi 7 Server Monitor';
const TZ = process.env.TZ_NAME || 'Asia/Ho_Chi_Minh';
// BOTS trong .env co dang: Haru:haru,Miyu:miyu  (Ten hien thi:ten process pm2)
const BOTS = (process.env.BOTS || 'Haru:haru,Miyu:miyu')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [label, pm2Name] = s.split(':').map((x) => x.trim());
    return { label, pm2Name: pm2Name || label.toLowerCase() };
  });
const STATE_FILE = path.join(__dirname, '.monitor_message_id');
// =====================

const GREEN = 0x2ecc71;
const RED = 0xe74c3c;
const BASE_URL = WEBHOOK_URL.split('?')[0];

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

const gb = (bytes, d = 1) => (bytes / 1024 ** 3).toFixed(d);

function bar(percent, size = 12) {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * size);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(size - filled);
}

async function getBattery() {
  const out = await run('termux-battery-status', []);
  if (!out) return null;
  try {
    const j = JSON.parse(out);
    const map = { CHARGING: 'Đang sạc', DISCHARGING: 'Đang dùng pin', FULL: 'Đã đầy', NOT_CHARGING: 'Không sạc' };
    return {
      percent: j.percentage,
      status: map[j.status] || j.status,
      temp: typeof j.temperature === 'number' ? j.temperature.toFixed(1) : null,
    };
  } catch {
    return null;
  }
}

function getRam() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = parseInt(txt.match(/MemTotal:\s+(\d+)/)[1], 10) * 1024;
    const availMatch = txt.match(/MemAvailable:\s+(\d+)/);
    const avail = availMatch
      ? parseInt(availMatch[1], 10) * 1024
      : (parseInt(txt.match(/MemFree:\s+(\d+)/)[1], 10) + parseInt(txt.match(/Cached:\s+(\d+)/)[1], 10)) * 1024;
    return { used: total - avail, total };
  } catch {
    return { used: os.totalmem() - os.freemem(), total: os.totalmem() };
  }
}

function readCpu() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = n[3] + (n[4] || 0);
  const total = n.reduce((a, b) => a + b, 0);
  return { idle, total };
}

async function getCpu() {
  try {
    const a = readCpu();
    await new Promise((r) => setTimeout(r, 1000));
    const b = readCpu();
    const dt = b.total - a.total;
    if (dt <= 0) throw new Error('no data');
    return Math.round((1 - (b.idle - a.idle) / dt) * 100);
  } catch {
    // Fallback neu Android chan /proc/stat: xap xi theo load average
    const load = os.loadavg()[0];
    return Math.min(100, Math.round((load / os.cpus().length) * 100));
  }
}

async function getStorage() {
  for (const target of ['/data', process.env.HOME || '.']) {
    const out = await run('df', ['-k', target]);
    if (!out) continue;
    const lines = out.trim().split('\n').slice(1).join(' ').split(/\s+/);
    const total = parseInt(lines[1], 10) * 1024;
    const used = parseInt(lines[2], 10) * 1024;
    if (total > 0) return { used, total };
  }
  return null;
}

async function getBots() {
  const out = await run('pm2', ['jlist'], 15000);
  let list = [];
  if (out) {
    try {
      // pm2 doi khi in rac truoc JSON, cat tu dau '['
      list = JSON.parse(out.slice(out.indexOf('[')));
    } catch {}
  }
  return BOTS.map((b) => {
    const proc = list.find((p) => p.name === b.pm2Name);
    const online = !!proc && proc.pm2_env && proc.pm2_env.status === 'online';
    return { label: b.label, online };
  });
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

async function buildEmbed() {
  const [battery, cpu, storage, bots] = await Promise.all([getBattery(), getCpu(), getStorage(), getBots()]);
  const ram = getRam();
  const now = new Date();
  const timeStr = now.toLocaleTimeString('vi-VN', { timeZone: TZ, hour12: false });
  const dateStr = now.toLocaleDateString('vi-VN', { timeZone: TZ });
  const allOnline = bots.every((b) => b.online);

  const ramPct = Math.round((ram.used / ram.total) * 100);
  const fields = [
    {
      name: 'Pin',
      value: battery
        ? `**${battery.percent}%**\n${battery.status}${battery.temp ? ` · ${battery.temp}°C` : ''}`
        : 'Không đọc được\n(cài termux-api)',
      inline: true,
    },
    {
      name: 'RAM',
      value: `**${gb(ram.used)} GB** / ${gb(ram.total, 0)} GB\n\`${bar(ramPct)}\` ${ramPct}%`,
      inline: true,
    },
    {
      name: 'CPU',
      value: `**${cpu}%**\n\`${bar(cpu)}\``,
      inline: true,
    },
  ];

  if (storage) {
    const sp = Math.round((storage.used / storage.total) * 100);
    fields.push({
      name: 'Storage',
      value: `**${gb(storage.used, 0)} GB** / ${gb(storage.total, 0)} GB\n\`${bar(sp)}\` ${sp}%`,
      inline: true,
    });
  }
  fields.push(
    { name: 'Thời gian', value: `**${timeStr}**\n${dateStr}`, inline: true },
    { name: 'Uptime', value: `**${formatUptime(os.uptime())}**`, inline: true }
  );

  const width = Math.max(...bots.map((b) => b.label.length));
  const botText = bots
    .map((b) => `${b.label.padEnd(width)}  :  ${b.online ? 'ONLINE' : 'OFFLINE'}`)
    .join('\n');
  fields.push({ name: 'Bot status', value: '```\n' + botText + '\n```', inline: false });

  return {
    title: TITLE,
    description: `Trạng thái: **${allOnline ? 'ONLINE' : 'CÓ BOT OFFLINE'}**\nCập nhật lúc ${timeStr}`,
    color: allOnline ? GREEN : RED,
    fields,
    footer: { text: 'Tự động cập nhật mỗi 10 phút' },
    timestamp: now.toISOString(),
  };
}

function loadMessageId() {
  try {
    return fs.readFileSync(STATE_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

async function sendOrEdit() {
  const embed = await buildEmbed();
  const body = JSON.stringify({ embeds: [embed] });
  const headers = { 'Content-Type': 'application/json' };
  let id = loadMessageId();

  if (id) {
    const res = await fetch(`${BASE_URL}/messages/${id}`, { method: 'PATCH', headers, body });
    if (res.ok) {
      console.log(new Date().toISOString(), 'Da cap nhat tin nhan', id);
      return;
    }
    if (res.status === 404) {
      console.log('Tin nhan cu khong con, gui tin moi');
      id = null;
    } else {
      throw new Error(`PATCH that bai: ${res.status} ${await res.text()}`);
    }
  }

  const res = await fetch(`${BASE_URL}?wait=true`, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`POST that bai: ${res.status} ${await res.text()}`);
  const data = await res.json();
  fs.writeFileSync(STATE_FILE, data.id);
  console.log(new Date().toISOString(), 'Da gui tin nhan moi', data.id);
}

async function tick() {
  try {
    await sendOrEdit();
  } catch (e) {
    console.error(new Date().toISOString(), e.message);
  }
}

if (WEBHOOK_URL.includes('DAN_WEBHOOK')) {
  console.error('Chua cau hinh WEBHOOK_URL');
  process.exit(1);
}

tick();
setInterval(tick, INTERVAL_MS);