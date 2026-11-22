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
// Canh bao pin yeu: ping 1 lan khi pin <= LOW_BATTERY va khong sac (can DISCORD_USER_ID)
const USER_ID = (process.env.DISCORD_USER_ID || '').trim();
const LOW_BATTERY = parseInt(process.env.LOW_BATTERY, 10) || 20;
const ALERT_FILE = path.join(__dirname, '.low_battery_alert');
const HISTORY_FILE = path.join(__dirname, '.battery_history.json');
const LAST_FILE = path.join(__dirname, '.last_battery.json');
// =====================

const GREEN = 0x2ecc71;
const ORANGE = 0xe67e22;
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

const BATTERY_STATUS_MAP = {
  CHARGING: 'Đang sạc',
  DISCHARGING: 'Dùng pin',
  FULL: 'Đã đầy',
  NOT_CHARGING: 'Không sạc',
};

const BATTERY_HEALTH_MAP = {
  GOOD: 'Tốt',
  OVERHEAT: 'Quá nhiệt',
  DEAD: 'Hỏng',
  OVER_VOLTAGE: 'Quá áp',
  COLD: 'Quá lạnh',
  UNSPECIFIED_FAILURE: 'Lỗi',
  UNKNOWN: 'Không rõ',
};

// Cach 1: termux-api (neu co cai)
async function getBatteryFromApi() {
  const out = await run('termux-battery-status', []);
  if (!out) return null;
  try {
    const j = JSON.parse(out);
    return {
      percent: j.percentage,
      status: BATTERY_STATUS_MAP[j.status] || j.status,
      charging: j.status === 'CHARGING',
      health: BATTERY_HEALTH_MAP[j.health] || j.health || null,
      temp: typeof j.temperature === 'number' ? j.temperature.toFixed(1) : null,
    };
  } catch {
    return null;
  }
}

// Cach 2: doc truc tiep tu /sys (khong can termux-api, nhung co may bi Android chan)
function getBatteryFromSysfs() {
  const bases = ['/sys/class/power_supply/battery', '/sys/class/power_supply/Battery'];
  for (const base of bases) {
    try {
      const percent = parseInt(fs.readFileSync(`${base}/capacity`, 'utf8').trim(), 10);
      if (Number.isNaN(percent)) continue;
      let status = null;
      let temp = null;
      let charging = false;
      let health = null;
      try {
        const s = fs.readFileSync(`${base}/status`, 'utf8').trim().toUpperCase().replace(/[\s-]/g, '_');
        status = BATTERY_STATUS_MAP[s] || s;
        charging = s === 'CHARGING';
      } catch {}
      try {
        const hs = fs.readFileSync(`${base}/health`, 'utf8').trim().toUpperCase().replace(/[\s-]/g, '_');
        health = BATTERY_HEALTH_MAP[hs] || hs;
      } catch {}
      try {
        // nhiet do tinh theo 0.1 do C
        const t = parseInt(fs.readFileSync(`${base}/temp`, 'utf8').trim(), 10);
        if (!Number.isNaN(t)) temp = (t / 10).toFixed(1);
      } catch {}
      return { percent, status: status || 'Không rõ', charging, health, temp };
    } catch {}
  }
  return null;
}

async function getBattery() {
  return (await getBatteryFromApi()) || getBatteryFromSysfs();
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
    const proc = list.find((p) => String(p.name).toLowerCase() === b.pm2Name.toLowerCase());
    const online = !!proc && proc.pm2_env && proc.pm2_env.status === 'online';
    const startedAt = online && proc.pm2_env.pm_uptime ? proc.pm2_env.pm_uptime : null;
    return {
      label: b.label,
      online,
      uptimeSec: startedAt ? Math.max(0, (Date.now() - startedAt) / 1000) : null,
      restarts: proc && proc.pm2_env ? proc.pm2_env.restart_time || 0 : null,
    };
  });
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

function formatShort(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`;
}

// Doc lan bao cao truoc (de so sanh) roi luu lan hien tai
function getPrevBattery(battery) {
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8'));
  } catch {}
  if (battery) {
    try {
      fs.writeFileSync(LAST_FILE, JSON.stringify({ p: battery.percent, t: Date.now() }));
    } catch {}
  }
  return prev;
}

function fmtHours(h) {
  if (!isFinite(h) || h < 0) return '?';
  if (h >= 48) return `${(h / 24).toFixed(1)} ngày`;
  const total = Math.round(h * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
}

// Android khong cho san "thoi gian con lai", nen uoc luong theo toc do tut/tang pin gan day
function estimateEta(battery) {
  if (!battery) return null;
  const now = Date.now();
  let hist = [];
  try {
    hist = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {}
  // chi giu mau cung trang thai (sac / khong sac) trong 3 gio gan nhat
  hist = hist.filter((s) => now - s.t <= 3 * 3600 * 1000 && s.c === !!battery.charging);
  hist.push({ t: now, p: battery.percent, c: !!battery.charging });
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(hist));
  } catch {}

  const first = hist[0];
  const hours = (now - first.t) / 3600000;
  const delta = battery.percent - first.p;
  if (hours < 0.6 || delta === 0) return null; // can du du lieu moi uoc luong duoc
  const rate = delta / hours; // % moi gio

  if (battery.charging && rate > 0 && battery.percent < 100) {
    return { charging: true, hours: (100 - battery.percent) / rate };
  }
  if (!battery.charging && rate < 0) {
    return { charging: false, hours: battery.percent / -rate };
  }
  return null;
}

async function buildEmbed() {
  const [battery, storage, bots] = await Promise.all([getBattery(), getStorage(), getBots()]);
  const ram = getRam();
  const now = new Date();
  const allOnline = bots.every((b) => b.online);
  const lowBattery = !!battery && battery.percent <= LOW_BATTERY && !battery.charging;
  const eta = estimateEta(battery);
  const etaField = eta
    ? {
        name: eta.charging ? 'Sạc đầy sau' : 'Hết pin sau',
        value: `**${fmtHours(eta.hours)}**\n(dự đoán)`,
        inline: true,
      }
    : { name: 'Dự đoán', value: 'Chưa đủ dữ liệu', inline: true };
  const prev = getPrevBattery(battery);
  let prevLine = null;
  if (prev && battery) {
    const d = battery.percent - prev.p;
    prevLine = `Trước: ${prev.p}% (${d > 0 ? '+' : ''}${d}%)`;
  }

  const ramPct = Math.round((ram.used / ram.total) * 100);
  const fields = [
    {
      name: 'Pin',
      value: battery
        ? `**${battery.percent}%**  \`${bar(battery.percent, 8)}\`\n${battery.status}${battery.temp ? ` · ${battery.temp}°C` : ''}${prevLine ? `\n${prevLine}` : ''}`
        : 'Không đọc được',
      inline: true,
    },
    {
      name: 'RAM',
      value: `**${gb(ram.used)} GB** / ${gb(ram.total, 0)} GB\n\`${bar(ramPct)}\` ${ramPct}%`,
      inline: true,
    },
    etaField,
  ];

  const sp = storage ? Math.round((storage.used / storage.total) * 100) : 0;
  fields.push(
    {
      name: 'Storage',
      value: storage
        ? `**${gb(storage.used, 0)} GB** / ${gb(storage.total, 0)} GB\n\`${bar(sp)}\` ${sp}%`
        : 'Không đọc được',
      inline: true,
    },
    { name: 'Uptime máy', value: `**${formatUptime(os.uptime())}**`, inline: true },
    { name: 'Sức khỏe pin', value: battery && battery.health ? `**${battery.health}**` : 'Không rõ', inline: true }
  );

  const width = Math.max(...bots.map((b) => b.label.length));
  const botText = bots
    .map((b) => {
      const up = b.online && b.uptimeSec != null ? formatShort(b.uptimeSec) : '-';
      const rs = b.restarts != null ? `${b.restarts} restart` : '-';
      return `${b.label.padEnd(width)}  ${(b.online ? 'ONLINE' : 'OFFLINE').padEnd(7)}  ${up.padEnd(7)}  ${rs}`;
    })
    .join('\n');
  fields.push({ name: 'Bot status', value: '```\n' + botText + '\n```', inline: false });

  const embed = {
    title: TITLE,
    description:
      `Trạng thái: **${allOnline ? 'ONLINE' : 'CÓ BOT OFFLINE'}**` +
      ` · cập nhật <t:${Math.floor(now.getTime() / 1000)}:R>` +
      (lowBattery ? '\nPin yếu, cần cắm sạc' : ''),
    color: !allOnline ? RED : lowBattery ? ORANGE : GREEN,
    fields,
    footer: { text: 'Tự động cập nhật mỗi 10 phút' },
    timestamp: now.toISOString(),
  };
  return { embed, battery };
}

function loadMessageId() {
  try {
    return fs.readFileSync(STATE_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

async function sendOrEdit(embed) {
  const body = JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } });
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

// Ping 1 lan khi pin yeu; tu xoa tin canh bao khi dang sac hoac pin hoi phuc
async function handleLowBattery(battery) {
  if (!USER_ID || !battery) return;
  let alertId = null;
  try {
    alertId = fs.readFileSync(ALERT_FILE, 'utf8').trim() || null;
  } catch {}

  const low = battery.percent <= LOW_BATTERY && !battery.charging;
  const recovered = battery.charging || battery.percent >= LOW_BATTERY + 10;

  if (low && !alertId) {
    const res = await fetch(`${BASE_URL}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `<@${USER_ID}> Pin còn ${battery.percent}%, cần cắm sạc.`,
        allowed_mentions: { users: [USER_ID] },
      }),
    });
    if (!res.ok) throw new Error(`Gui canh bao that bai: ${res.status} ${await res.text()}`);
    const data = await res.json();
    fs.writeFileSync(ALERT_FILE, data.id);
    console.log(new Date().toISOString(), 'Da ping canh bao pin yeu', data.id);
  } else if (alertId && recovered) {
    await fetch(`${BASE_URL}/messages/${alertId}`, { method: 'DELETE' }).catch(() => {});
    try {
      fs.unlinkSync(ALERT_FILE);
    } catch {}
    console.log(new Date().toISOString(), 'Da xoa tin canh bao pin yeu');
  }
}

async function tick() {
  let battery = null;
  try {
    const built = await buildEmbed();
    battery = built.battery;
    await sendOrEdit(built.embed);
  } catch (e) {
    console.error(new Date().toISOString(), e.message);
  }
  try {
    await handleLowBattery(battery);
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