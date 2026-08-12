/* ===========================
   CONFIG
   =========================== */

const PLAYLIST_API_PATH = "/api/playlist";
const EPG_API_PATH = "/api/epg";

// [Free-TV playlist slug, ISO country code, EPGShare feed suffix]
// A null EPG suffix means that Free-TV does not currently publish a matching
// country guide in its epglist.txt file.
const COUNTRY_DATA = [
  ["albania", "AL", "AL1"], ["andorra", "AD", null],
  ["argentina", "AR", "AR1"], ["armenia", "AM", null],
  ["australia", "AU", "AU1"], ["austria", "AT", "AT1"],
  ["azerbaijan", "AZ", null], ["belarus", "BY", null],
  ["belgium", "BE", "BE2"], ["bosnia_and_herzegovina", "BA", "BA1"],
  ["brazil", "BR", "BR1"], ["bulgaria", "BG", "BG1"],
  ["canada", "CA", "CA1"], ["chad", "TD", null],
  ["chile", "CL", "CL1"], ["china", "CN", null],
  ["costa_rica", "CR", "CR1"], ["croatia", "HR", "HR1"],
  ["cyprus", "CY", "CY1"], ["czech_republic", "CZ", "CZ1"],
  ["denmark", "DK", "DK1"], ["dominican_republic", "DO", "DO1"],
  ["egypt", "EG", "EG1"], ["estonia", "EE", null],
  ["faroe_islands", "FO", null], ["finland", "FI", "FI1"],
  ["france", "FR", "FR1"], ["georgia", "GE", null],
  ["germany", "DE", "DE1"], ["greece", "GR", "GR1"],
  ["greenland", "GL", null], ["hong_kong", "HK", "HK1"],
  ["hungary", "HU", "HU1"], ["iceland", "IS", null],
  ["india", "IN", "IN1"], ["indonesia", "ID", "ID1"],
  ["iran", "IR", null], ["iraq", "IQ", null],
  ["ireland", "IE", "IE1"], ["israel", "IL", "IL1"],
  ["italy", "IT", "IT1"], ["japan", "JP", "JP1"],
  ["kenya", "KE", "KE1"], ["korea", "KR", "KR1"],
  ["kosovo", "XK", null], ["latvia", "LV", "LV1"],
  ["lithuania", "LT", "LT1"], ["luxembourg", "LU", null],
  ["macau", "MO", null], ["malta", "MT", "MT1"],
  ["mexico", "MX", "MX1"], ["moldova", "MD", null],
  ["monaco", "MC", null], ["montenegro", "ME", null],
  ["netherlands", "NL", "NL1"], ["north_korea", "KP", null],
  ["north_macedonia", "MK", null], ["norway", "NO", "NO1"],
  ["paraguay", "PY", null], ["peru", "PE", "PE1"],
  ["poland", "PL", "PL1"], ["portugal", "PT", "PT1"],
  ["qatar", "QA", null], ["romania", "RO", "RO1"],
  ["russia", "RU", null], ["san_marino", "SM", null],
  ["saudi_arabia", "SA", "SA1"], ["serbia", "RS", "RS1"],
  ["slovakia", "SK", "SK1"], ["slovenia", "SI", null],
  ["somalia", "SO", null], ["spain", "ES", "ES1"],
  ["sweden", "SE", "SE1"], ["switzerland", "CH", "CH1"],
  ["taiwan", "TW", null], ["trinidad", "TT", null],
  ["turkey", "TR", "TR1"], ["uk", "GB", "UK1"],
  ["ukraine", "UA", null], ["united_arab_emirates", "AE", null],
  ["usa", "US", "US1"], ["venezuela", "VE", null]
].map(([slug, iso, epg]) => ({ slug, iso, epg }));

/* ===== TAB TITLE ===== */
const DEFAULT_TITLE = "DVB";

/* ✅ scaling reference (TENUTO, ma ora fisso) */
const UI_BASE_W = 1920;
const UI_BASE_H = 1080;

let allChannels = [];
let epgData = new Map();
let epgMatchCache = new Map();
let hlsInst = null;
let dashInst = null;

let hideUiTimer = null;
let epgTimer = null;
let activeChannelName = null;
let activeChannelId = null;
let countryLoadToken = 0;

/* ✅ autoplay solo all’avvio */
let initialAutoplayDone = false;

const el = {
  video: document.getElementById('videoPlayer'),
  ui: document.getElementById('uiOverlay'),
  cats: document.getElementById('categoryContainer'),
  chans: document.getElementById('channelContainer'),
  epgNow: document.getElementById('epgNowText'),
  epgFill: document.getElementById('epgNowFill'),
  epgNextList: document.getElementById('epgNextList'),
  playerStatus: document.getElementById('playerStatus'),
  qBadge: document.getElementById('qualityBadge'),
  visitors: document.getElementById('visitors'),
  clock: document.getElementById('sidebarClock'),
  country: document.getElementById('countrySelect'),
  dataStatus: document.getElementById('dataStatus')
};

/* ===========================
   TIME / CLOCK
   =========================== */

const userTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const timeFmt = new Intl.DateTimeFormat("it-IT", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: userTZ
});

function fmtTime(d) {
  return d ? timeFmt.format(d) : "--:--";
}

/* ===========================
   ✅ UI SCALE (FISSO)
   =========================== */

function applyUiScale() {
  document.documentElement.style.setProperty('--ui-scale', "1");
}
let _scaleRaf = null;
function requestUiScale() {
  if (_scaleRaf) cancelAnimationFrame(_scaleRaf);
  _scaleRaf = requestAnimationFrame(() => {
    applyUiScale();
    _scaleRaf = null;
  });
}
window.addEventListener('resize', requestUiScale);
window.addEventListener('orientationchange', requestUiScale);

/* ===========================
   TAB TITLE
   =========================== */

function updateTabTitle(channelName) {
  if (!channelName) {
    document.title = DEFAULT_TITLE;
    return;
  }
  document.title = `${channelName} • ${DEFAULT_TITLE}`;
}

/* ===========================
   PLAY/PAUSE ICON
   =========================== */

function setPlayPauseIcon(isPlaying) {
  const btn = document.getElementById('playPauseBtn');
  if (!btn) return;
  const icon = btn.querySelector('i');
  if (!icon) return;

  icon.classList.remove('fa-play', 'fa-pause');
  icon.classList.add(isPlaying ? 'fa-pause' : 'fa-play');
}

/* ✅ Punto 5: icona sempre sync con lo stato reale del video */
function initPlayPauseSync() {
  if (!el.video) return;
  el.video.addEventListener("play", () => setPlayPauseIcon(true));
  el.video.addEventListener("pause", () => {
    setPlayPauseIcon(false);
    showUI();
  });
  el.video.addEventListener("ended", () => {
    setPlayPauseIcon(false);
    showUI();
  });
  el.video.addEventListener("playing", () => {
    setPlayerStatus("");
    showUI();
  });
  el.video.addEventListener("error", () => {
    const code = el.video.error?.code;
    if (code && code !== MediaError.MEDIA_ERR_ABORTED) {
      setPlayerStatus("Il flusso non può essere riprodotto o non è raggiungibile.", "error");
    }
  });
}

/* ===========================
   SIDEBAR CLOCK
   =========================== */

function formatSidebarClock(dateObj) {
  const fmt = new Intl.DateTimeFormat("it-IT", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: userTZ
  });

  const parts = fmt.formatToParts(dateObj);
  const get = (type) => parts.find(p => p.type === type)?.value || "";

  let weekday = get("weekday");
  let day = get("day");
  let month = get("month");
  const hour = get("hour");
  const minute = get("minute");

  weekday = weekday.replace('.', '');
  month = month.replace('.', '');

  const cap = (s) => s ? (s.charAt(0).toUpperCase() + s.slice(1)) : s;
  return `${cap(weekday)} ${day} ${cap(month)} ${hour}:${minute}`;
}

function initSidebarClock() {
  if (!el.clock) return;

  const tick = () => {
    el.clock.textContent = formatSidebarClock(new Date());
  };

  tick();
  setInterval(tick, 30000);
}

/* ===========================
   QUALITY BADGE (UNICA)
   =========================== */

function showQualityBadge(label, opts = {}) {
  if (!el.qBadge) return;

  if (!label) {
    el.qBadge.style.display = "none";
    el.qBadge.textContent = "";
    el.qBadge.removeAttribute("data-q");
    return;
  }

  const qKey = opts.key || "custom";
  const iconClass = opts.iconClass || "";

  el.qBadge.style.display = "inline-flex";
  el.qBadge.setAttribute("data-q", qKey);
  el.qBadge.textContent = "";

  if (iconClass) {
    const icon = document.createElement("i");
    icon.className = iconClass;
    icon.setAttribute("aria-hidden", "true");
    el.qBadge.appendChild(icon);
  }

  const text = document.createElement("span");
  text.className = "q-text";
  text.textContent = String(label);
  el.qBadge.appendChild(text);
}

function qualityIconForKey(key) {
  switch (key) {
    case "4k":
      return "fa-duotone fa-solid fa-rectangle-4k";
    case "hdr":
      return "fa-duotone fa-solid fa-rectangle-high-dynamic-range";
    case "sd":
      return "fa-duotone fa-solid fa-standard-definition";
    case "hd":
      return "fa-duotone fa-solid fa-high-definition";
    default:
      return "";
  }
}


function labelFromHeight(h) {
  h = Number(h) || 0;

  if (h >= 8640) return "16K";
  if (h >= 4320) return "8K";
  if (h >= 2880) return "5K";
  if (h >= 2160) return "4K";
  if (h >= 1600) return "1600p";
  if (h >= 1440) return "2K";
  if (h >= 1280) return "1280p";
  if (h >= 1080) return "1080p";
  if (h >= 1024) return "1024p";
  if (h >= 720)  return "720p";
  if (h >= 576)  return "576p";
  if (h >= 480)  return "480p";
  if (h >= 360)  return "360p";
  if (h >= 240)  return "240p";
  if (h >= 144)  return "144p";
  if (h >= 120)  return "120p";
  if (h >= 96)   return "96p";
  return "undefined";
}

function keyFromHeight(h) {
  h = Number(h) || 0;
  if (h >= 2160) return "4k";
  if (h > 0 && h <= 576) return "sd";
  return "hd";
}





function detectQualityFromName(name) {
  const n = (name || "").toUpperCase();
  let key = "";
  let text = "";

  if (n.includes("4K") || n.includes("UHD")) { key = "4k"; text = "4K"; }
  else if (n.includes("HDR")) { key = "hdr"; text = "HDR"; }
  else if (n.includes("FHD") || n.includes("1080")) { key = "hd"; text = "1080p"; }
  else if (n.includes("HD") || n.includes("720")) { key = "hd"; text = "720p"; }
  else if (n.includes("SD")) { key = "sd"; text = "SD"; }

  if (key) showQualityBadge(text, { key, iconClass: qualityIconForKey(key) });
  else showQualityBadge("");
}

function updateQualityFromHlsLevel(levelObj) {
  if (!levelObj) return;

  const h = levelObj.height || 0;
  const br = levelObj.bitrate || 0;

  const label = labelFromHeight(h);
  const kbps = br ? `${Math.round(br / 1000)}kbps` : "";
  const text = kbps ? `${label} • ${kbps}` : label;

  const key = keyFromHeight(h);
  showQualityBadge(text, { key, iconClass: qualityIconForKey(key) });
}

function attachHlsQualityListeners(nameForFallback) {
  if (!hlsInst) return;

  hlsInst.on(Hls.Events.MANIFEST_PARSED, () => {
  if (hlsInst.levels && hlsInst.levels.length) {
    const best = hlsInst.levels.reduce(
      (a, b) => ((b.height || 0) > (a.height || 0) ? b : a),
      hlsInst.levels[0]
    );
    updateQualityFromHlsLevel(best);
  } else {
    // fallback: non nascondere, mostra almeno nome/guess
    detectQualityFromName(nameForFallback);
  }
});

  hlsInst.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
    const lvl = hlsInst.levels?.[data.level];
    updateQualityFromHlsLevel(lvl);
  });

  hlsInst.on(Hls.Events.ERROR, (_, data) => {
    detectQualityFromName(nameForFallback);
    if (data?.fatal) {
      const message = data.type === Hls.ErrorTypes.NETWORK_ERROR
        ? "Errore di rete durante il caricamento del flusso HLS."
        : "Il flusso HLS non può essere decodificato.";
      setPlayerStatus(message, "error");
    }
  });
}

function attachDashQualityListeners(nameForFallback) {
  if (!dashInst) return;

  const ev = dashjs.MediaPlayer.events;

  const update = () => {
    try {
      const q = dashInst.getQualityFor("video");
      const list = dashInst.getBitrateInfoListFor("video") || [];
      const info = list[q];

      if (!info) return detectQualityFromName(nameForFallback);

      const h = info.height || 0;
      const br = info.bitrate || 0;

      let label = "";
      if (h) label = `${h}p`;
      else if (br) label = `${Math.round(br / 1000)}kbps`;
      if (!label) return detectQualityFromName(nameForFallback);

      let key = "hd";
      if (h >= 2160) key = "4k";
      else if (h > 0 && h <= 576) key = "sd";
      else key = "hd";

      const kbps = br ? `${Math.round(br / 1000)}kbps` : "";
      const text = h && kbps ? `${label} • ${kbps}` : label;
      showQualityBadge(text, { key, iconClass: qualityIconForKey(key) });
    } catch {
      detectQualityFromName(nameForFallback);
    }
  };

  dashInst.on(ev.STREAM_INITIALIZED, update);
  dashInst.on(ev.QUALITY_CHANGE_RENDERED, update);
  dashInst.on(ev.PLAYBACK_STARTED, update);
  dashInst.on(ev.ERROR, () => {
    detectQualityFromName(nameForFallback);
    setPlayerStatus("Errore durante il caricamento del flusso DASH.", "error");
  });
}

/* ===========================
   EPG
   =========================== */

function normalizeEPGId(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function normalizeEPGName(str) {
  if (!str) return "";
  return str
    .replace(/[.\s_-](uk|it)$/i, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, '')
    .replace(/\[.*?\]|\(.*?\)/g, '')
    .replace(/\bbbc\s*one(\s*(london|north|south))?\b/g, 'bbc1')
    .replace(/\bbbc\s*two\b/g, 'bbc2')
    .replace(/\bbbc\s*three\b/g, 'bbc3')
    .replace(/\bbbc\s*four\b/g, 'bbc4')
    .replace(/\bbbc\s*news\b/g, 'bbcnews')
    .replace(/\bbbc\s*world\s*news\b/g, 'bbcworldnews')
    .replace(/\bitv\s*one\b/g, 'itv1')
    .replace(/\bitv\s*([2-4])\b/g, 'itv$1')
    .replace(/\bchannel\s*four\b/g, 'channel4')
    .replace(/\b(e4|film4|more4|4seven)\b/g, m => m.replace('4', ' 4'))
    .replace(/\b(hd|fhd|sd|uhd|plus|extra|direct|premium|now|live|east|west|north|south|central)\b/g, '')
    .replace(/(rete\s*4|retequattro)/g, 'rete4')
    .replace(/canale\s*5/g, 'canale5')
    .replace(/italia\s*1/g, 'italia1')
    .replace(/tv\s*8/g, 'tv8')
    .replace(/\bnove\b/g, '9')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function parseXmlDate(s) {
  if (!s) return null;

  const m = s.trim().match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+\-])(\d{2})(\d{2}))?$/
  );
  if (!m) return null;

  const [_, Y, Mo, D, H, Mi, S, sign, tzh, tzm] = m;
  let offset = "Z";
  if (sign && tzh && tzm) offset = `${sign}${tzh}:${tzm}`;

  return new Date(`${Y}-${Mo}-${D}T${H}:${Mi}:${S}${offset}`);
}

async function responseAsText(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;

  if (!isGzip) return new TextDecoder("utf-8").decode(bytes);
  if (typeof DecompressionStream !== "function") {
    throw new Error("Questo browser non supporta la decompressione gzip dell'EPG.");
  }

  const decompressed = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(decompressed).text();
}

async function fetchTextWithTimeout(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return await responseAsText(response);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Timeout di rete");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchEpg(epgUrl) {
  if (!epgUrl) return new Map();

  const text = await fetchTextWithTimeout(epgUrl, 45000);
  const xml = new DOMParser().parseFromString(text, "application/xml");

  if (xml.querySelector("parsererror")) throw new Error("EPG XML non valido.");

  const result = new Map();
  const programs = Array.from(xml.getElementsByTagName("programme"));

  programs.forEach(p => {
    const channelId = normalizeEPGId(p.getAttribute("channel"));
    if (!channelId) return;
    const channelKey = `id:${channelId}`;

    const start = parseXmlDate(p.getAttribute("start"));
    const stop = parseXmlDate(p.getAttribute("stop"));
    if (!start || !stop) return;

    const title = p.getElementsByTagName("title")[0]?.textContent || "Nessun titolo";
    if (!result.has(channelKey)) result.set(channelKey, []);
    result.get(channelKey).push({ start, stop, title });
  });

  for (const arr of result.values()) arr.sort((a, b) => a.start - b.start);

  // tvg-id is preferred; display names are indexed as a fallback.
  Array.from(xml.getElementsByTagName("channel")).forEach(channel => {
    const id = normalizeEPGId(channel.getAttribute("id"));
    const programsForChannel = result.get(`id:${id}`);
    if (!programsForChannel) return;

    Array.from(channel.getElementsByTagName("display-name")).forEach(node => {
      const alias = normalizeEPGName(node.textContent);
      const aliasKey = `name:${alias}`;
      if (alias && !result.has(aliasKey)) result.set(aliasKey, programsForChannel);
    });
  });

  return result;
}

function bigrams(value) {
  const result = new Set();
  for (let i = 0; i < value.length - 1; i++) result.add(value.slice(i, i + 2));
  return result;
}

function epgNameSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length < 4 || b.length < 4) return 0;

  const left = bigrams(a);
  const right = bigrams(b);
  let intersection = 0;
  left.forEach(pair => { if (right.has(pair)) intersection++; });
  const dice = (2 * intersection) / (left.size + right.size || 1);
  const containment = a.includes(b) || b.includes(a)
    ? Math.min(a.length, b.length) / Math.max(a.length, b.length)
    : 0;
  return Math.max(dice, containment);
}

function findEpgPrograms(channelName, channelId = "") {
  const idKey = normalizeEPGId(channelId);
  const nameKey = normalizeEPGName(channelName);
  const cacheKey = `${idKey}|${nameKey}`;
  if (epgMatchCache.has(cacheKey)) return epgMatchCache.get(cacheKey);

  const exact = epgData.get(`id:${idKey}`) || epgData.get(`name:${nameKey}`);
  if (exact) {
    epgMatchCache.set(cacheKey, exact);
    return exact;
  }

  let best = null;
  let bestScore = 0;
  let secondScore = 0;

  if (nameKey.length >= 4) {
    for (const [storedKey, programs] of epgData.entries()) {
      if (!storedKey.startsWith("name:")) continue;
      const epgKey = storedKey.slice(5);
      const score = epgNameSimilarity(nameKey, epgKey);
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        best = programs;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
  }

  // Accept only strong, unambiguous fuzzy matches to avoid showing the wrong guide.
  const result = bestScore >= 0.9 && bestScore - secondScore >= 0.04 ? best : [];
  epgMatchCache.set(cacheKey, result);
  return result;
}

function updateEPGUI(channelName, channelId = "") {
  if (!el.epgNow || !el.epgFill || !el.epgNextList) return;

  const list = findEpgPrograms(channelName, channelId);
  const now = new Date();

  const current = list.find(p => now >= p.start && now < p.stop);

  if (current) {
    el.epgNow.textContent = current.title;

    const total = current.stop - current.start;
    const done = now - current.start;
    const pct = total > 0 ? (done / total) * 100 : 0;
    el.epgFill.style.width = Math.max(0, Math.min(100, pct)) + "%";
  } else {
    el.epgNow.textContent = channelName;
    el.epgFill.style.width = "0%";
  }

  const nextPrograms = list.filter(p => p.start >= now).slice(0, 3);

  el.epgNextList.innerHTML = "";
  if (nextPrograms.length > 0) {
    nextPrograms.forEach(p => {
      const item = document.createElement('p');
      item.className = "epg-next-item";

      /* ✅ FIX: niente innerHTML con titoli */
      const span = document.createElement('span');
      span.textContent = fmtTime(p.start);

      item.appendChild(span);
      item.appendChild(document.createTextNode(" " + p.title));

      el.epgNextList.appendChild(item);
    });
  } else {
    el.epgNextList.innerHTML =
      "<p class='epg-next-item'><i class='fa-duotone fa-solid fa-circle-info'></i> Nessuna guida disponibile per questo canale.</p>";
  }
}

/* ===========================
   PLAYER
   =========================== */

function classifyStreamType(url, hint = "") {
  const hintValue = String(hint).toLowerCase();
  if (hintValue.includes("dash") || hintValue.includes("mpd")) return "dash";
  if (hintValue.includes("hls") || hintValue.includes("m3u8")) return "hls";

  const value = String(url || "").toLowerCase();
  if (/\.mpd(?:$|[?#])/.test(value) || /[?&](?:format|type)=dash(?:&|$)/.test(value)) {
    return "dash";
  }
  if (/\.m3u8(?:$|[?#])/.test(value) ||
      /[?&](?:format|type)=(?:hls|m3u8)(?:&|$)/.test(value) ||
      /[?&]output=7(?:&|$)/.test(value) || /\/hls(?:\/|$)/.test(value)) {
    return "hls";
  }
  return "native";
}

function requestVideoPlayback() {
  return el.video.play().catch(error => {
    if (error?.name === "NotAllowedError") {
      setPlayerStatus("Premi Play per avviare la riproduzione.");
    } else if (error?.name !== "AbortError") {
      setPlayerStatus("Impossibile avviare la riproduzione.", "error");
    }
  });
}

function play(url, name, tvgId = "", streamHint = "") {
  url = String(url || ""); /* ✅ FIX: evita crash su includes */

  showQualityBadge("");
  setPlayerStatus("");
  updateTabTitle(name);

  if (hlsInst) {
    try { hlsInst.destroy(); } catch {}
    hlsInst = null;
  }
  if (dashInst) {
    try { dashInst.reset(); } catch {}
    dashInst = null;
  }

  el.video.pause();
  el.video.removeAttribute("src");
  el.video.load();

  activeChannelName = name;
  activeChannelId = tvgId;
  updateEPGUI(name, tvgId);

  clearInterval(epgTimer);
  epgTimer = setInterval(() => {
    if (activeChannelName) updateEPGUI(activeChannelName, activeChannelId);
  }, 15000);

  if (!/^https?:\/\//i.test(url)) {
    setPlayerStatus("URL del flusso non valido.", "error");
    return;
  }

  const streamType = classifyStreamType(url, streamHint);
  const isLocalStreamProxy = (() => {
    try {
      const parsed = new URL(url, location.href);
      return parsed.origin === location.origin && parsed.pathname === "/api/stream";
    } catch {
      return false;
    }
  })();
  const playbackUrl = streamType === "hls" && !isLocalStreamProxy
    ? `/api/stream?url=${encodeURIComponent(url)}`
    : url;

  if (streamType === "dash") {
    if (typeof dashjs === "undefined") {
      setPlayerStatus("Il modulo DASH locale non è disponibile.", "error");
      return;
    }
    dashInst = dashjs.MediaPlayer().create();
    dashInst.initialize(el.video, playbackUrl, true);
    attachDashQualityListeners(name);
  } else if (streamType === "hls") {
    if (typeof Hls !== "undefined" && Hls.isSupported()) {
      hlsInst = new Hls();
      hlsInst.loadSource(playbackUrl);
      hlsInst.attachMedia(el.video);
      attachHlsQualityListeners(name);

      hlsInst.on(Hls.Events.MANIFEST_PARSED, () => {
        requestVideoPlayback();
      });
    } else {
      el.video.src = playbackUrl;
      detectQualityFromName(name);
      requestVideoPlayback();
    }
  } else {
    el.video.src = playbackUrl;
    detectQualityFromName(name);
    requestVideoPlayback();
  }
}

function togglePlay() {
  if (el.video.paused) requestVideoPlayback();
  else el.video.pause();
}

/* ✅ FIX: rewind/forward safe */
function rewind() {
  el.video.currentTime = Math.max(0, el.video.currentTime - 10);
}
function forward() {
  const d = el.video.duration;
  if (isFinite(d)) el.video.currentTime = Math.min(d, el.video.currentTime + 10);
  else el.video.currentTime = el.video.currentTime + 10;
}

function changeVolume(val) {
  el.video.volume = val;
  const v = document.getElementById('volLevel');
  if (v) v.textContent = Math.round(val * 100) + "%";
}

function toggleFullScreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  else if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
}

/* ===========================
   ICONA TIPO CANALE (📻 / 📺)
   =========================== */

function updateChannelTypeIcon(groupName) {
  const icon = document.getElementById("channelTypeIcon");
  if (!icon) return;

  const isRadio = String(groupName).toLowerCase() === "web radio";
  icon.className = isRadio ? "fa-solid fa-radio" : "fa-solid fa-tv";
}

/* ===========================
   CONTATORE (Web Radio = solo web radio; altri = totale TV)
   =========================== */

function updateGroupCount(groupName) {
  const g = String(groupName).toLowerCase();

  let count = 0;
  if (g === "web radio") {
    count = allChannels.filter(ch => String(ch.group).toLowerCase() === "web radio").length;
  } else {
    count = allChannels.filter(ch => String(ch.group).toLowerCase() !== "web radio").length;
  }

  const elCount = document.getElementById("groupCount");
  if (!elCount) return;
  elCount.textContent = count;
}

/* ===========================
   UI + LISTE
   =========================== */

function countryFlag(iso) {
  return Array.from(iso.toUpperCase())
    .map(char => String.fromCodePoint(127397 + char.charCodeAt(0)))
    .join("");
}

function countryLabel(country) {
  try {
    const displayNames = new Intl.DisplayNames(["it"], { type: "region" });
    return displayNames.of(country.iso) || country.slug.replaceAll("_", " ");
  } catch {
    return country.slug.replaceAll("_", " ");
  }
}

function setDataStatus(message, state = "") {
  if (!el.dataStatus) return;
  el.dataStatus.textContent = message;
  if (state) el.dataStatus.dataset.state = state;
  else el.dataStatus.removeAttribute("data-state");
}

function setPlayerStatus(message, state = "") {
  if (!el.playerStatus) return;
  el.playerStatus.textContent = message;
  if (state) el.playerStatus.dataset.state = state;
  else el.playerStatus.removeAttribute("data-state");
}

function findExtInfSeparator(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"' && line[i - 1] !== "\\") quoted = !quoted;
    else if (line[i] === "," && !quoted) return i;
  }
  return -1;
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ""), location.href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function parsePlaylist(text) {
  const channels = [];
  let current = null;

  String(text || "").split(/\r?\n/).forEach(rawLine => {
    const line = rawLine.trim();

    if (line.startsWith("#EXTINF:")) {
      const commaIndex = findExtInfSeparator(line);
      const name = commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : "Canale senza nome";
      const metadata = commaIndex >= 0 ? line.slice(0, commaIndex) : line;
      const attr = key => (metadata.match(new RegExp(`${key}="([^"]*)"`, "i")) || [])[1] || "";

      current = {
        name,
        logo: attr("tvg-logo"),
        group: attr("group-title") || "Generale",
        tvgId: attr("tvg-id"),
        country: attr("tvg-country"),
        streamType: attr("tvg-type") || attr("type")
      };
    } else if (/^https?:\/\//i.test(line) && current) {
      channels.push({ ...current, url: line });
      current = null;
    }
  });

  return channels.filter((channel, index, list) =>
    list.findIndex(item => item.url === channel.url) === index
  );
}

async function loadCountry(countrySlug) {
  const country = COUNTRY_DATA.find(item => item.slug === countrySlug) ||
    COUNTRY_DATA.find(item => item.slug === "italy");
  const token = ++countryLoadToken;
  const playlistUrl = `${PLAYLIST_API_PATH}?country=${encodeURIComponent(country.slug)}`;
  const epgUrl = country.epg
    ? `${EPG_API_PATH}?feed=${encodeURIComponent(country.epg)}`
    : "";

  try { localStorage.setItem("dvb-country", country.slug); } catch {}
  setDataStatus("Caricamento canali…");

  if (hlsInst) {
    try { hlsInst.destroy(); } catch {}
    hlsInst = null;
  }
  if (dashInst) {
    try { dashInst.reset(); } catch {}
    dashInst = null;
  }
  el.video.pause();
  el.video.removeAttribute("src");
  el.video.load();
  clearInterval(epgTimer);
  activeChannelName = null;
  activeChannelId = null;
  updateTabTitle(null);
  if (el.epgNow) el.epgNow.textContent = "Seleziona un canale";
  if (el.epgFill) el.epgFill.style.width = "0%";
  if (el.epgNextList) el.epgNextList.textContent = "";

  allChannels = [];
  epgData = new Map();
  epgMatchCache.clear();
  el.cats.innerHTML = "";
  el.chans.innerHTML = "";

  const epgRequest = epgUrl
    ? fetchEpg(epgUrl).then(map => ({ map })).catch(error => ({ error }))
    : Promise.resolve({ map: new Map() });

  try {
    const playlistText = await fetchTextWithTimeout(playlistUrl, 20000);
    if (token !== countryLoadToken) return;

    allChannels = parsePlaylist(playlistText);
    if (!allChannels.length) throw new Error("La playlist non contiene canali.");

    const search = document.getElementById("channelSearch");
    if (search) search.value = "";
    renderCats();
    setDataStatus(`${allChannels.length} canali · caricamento EPG…`);
  } catch (error) {
    if (token !== countryLoadToken) return;
    console.error("Errore playlist:", error);
    setDataStatus("Playlist non disponibile", "error");
    return;
  }

  const epgResult = await epgRequest;
  if (token !== countryLoadToken) return;

  if (epgResult.error) {
    console.error("Errore EPG:", epgResult.error);
    setDataStatus(`${allChannels.length} canali · EPG non raggiungibile`, "error");
  } else if (!country.epg) {
    setDataStatus(`${allChannels.length} canali · EPG non disponibile`);
  } else {
    epgData = epgResult.map;
    epgMatchCache.clear();
    setDataStatus(`${allChannels.length} canali · EPG attivo`);
    if (activeChannelName) updateEPGUI(activeChannelName, activeChannelId);
  }
}

function initCountrySelector() {
  if (!el.country) return "italy";

  const countries = [...COUNTRY_DATA].sort((a, b) =>
    countryLabel(a).localeCompare(countryLabel(b), "it")
  );

  countries.forEach(country => {
    const option = document.createElement("option");
    option.value = country.slug;
    option.textContent = `${countryFlag(country.iso)} ${countryLabel(country)}`;
    el.country.appendChild(option);
  });

  let savedCountry = "italy";
  try { savedCountry = localStorage.getItem("dvb-country") || "italy"; } catch {}
  if (!COUNTRY_DATA.some(country => country.slug === savedCountry)) savedCountry = "italy";

  el.country.value = savedCountry;
  el.country.addEventListener("change", () => loadCountry(el.country.value));
  return savedCountry;
}

async function init() {
  applyUiScale();
  updateTabTitle(null);
  initPlayPauseSync();
  initSidebarClock();
  
  const initialCountry = initCountrySelector();
  await loadCountry(initialCountry);
}

/* ✅ helper: seleziona categoria senza autoplay */
function selectCategory(cat, opts = {}) {
  const { autoplayFirst = false } = opts;

  document.querySelectorAll('#categoryContainer .item').forEach(e => e.classList.remove('active'));

  // trova l'elemento categoria
  const catEl = Array.from(document.querySelectorAll('#categoryContainer .item'))
    .find(x => x.textContent.trim() === String(cat).trim());

  if (catEl) catEl.classList.add('active');

  const term = (document.getElementById("channelSearch")?.value || "").trim().toLowerCase();

  if (term) renderChansFiltered(cat, term);
  else renderChans(cat);

  updateGroupCount(cat);

  /* ✅ autoplay solo se richiesto esplicitamente */
  if (autoplayFirst) {
    const firstChannel = el.chans?.querySelector('.item');
    if (firstChannel) firstChannel.click();
  }
}

function renderCats() {
  const cats = [...new Set(allChannels.map(c => c.group))];
  el.cats.innerHTML = "";

  cats.forEach((cat) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.textContent = cat;

    div.onclick = () => {
      /* ✅ al cambio categoria NON parte più il primo canale */
      selectCategory(cat, { autoplayFirst: false });
    };

    el.cats.appendChild(div);
  });

  /* ✅ all’avvio: prima categoria + autoplay primo canale (una sola volta) */
  if (cats.length) {
    if (!initialAutoplayDone) {
      initialAutoplayDone = true;
      selectCategory(cats[0], { autoplayFirst: true });
    } else {
      selectCategory(cats[0], { autoplayFirst: false });
    }
  }
}

function makeChannelItem(ch) {
  const div = document.createElement('div');
  div.className = 'item';
  const logoUrl = safeHttpUrl(ch.logo);

  const fallback = document.createElement("span");
  fallback.className = "item-icon";
  const fallbackIcon = document.createElement("i");
  fallbackIcon.className = "fa-duotone fa-solid fa-clapperboard-play";
  fallback.appendChild(fallbackIcon);

  if (logoUrl) {
    const image = document.createElement("img");
    image.className = "item-img";
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.src = logoUrl;
    fallback.style.display = "none";
    image.addEventListener("error", () => {
      image.style.display = "none";
      fallback.style.display = "inline-flex";
    });
    div.appendChild(image);
  }

  div.appendChild(fallback);
  const label = document.createElement("span");
  label.textContent = ch.name;
  div.appendChild(label);

  div.onclick = () => {
    document.querySelectorAll('#channelContainer .item').forEach(e => e.classList.remove('active'));
    div.classList.add('active');

    const n = document.getElementById('activeName');
    const l = document.getElementById('activeLogo');
    if (n) n.textContent = ch.name;
    if (l && logoUrl) { l.src = logoUrl; l.style.display = 'block'; }

    updateChannelTypeIcon(ch.group);
    play(ch.url, ch.name, ch.tvgId, ch.streamType);
  };

  return div;
}

function renderChans(cat) {
  el.chans.innerHTML = "";

  allChannels
    .filter(c => c.group === cat)
    .forEach(ch => el.chans.appendChild(makeChannelItem(ch)));
}

function renderChansFiltered(cat, term) {
  el.chans.innerHTML = "";

  allChannels
    .filter(c => c.group === cat)
    .filter(c => String(c.name).toLowerCase().includes(term))
    .forEach(ch => el.chans.appendChild(makeChannelItem(ch)));
}

/* ===========================
   SEARCH GLOBALE (tutte le categorie)
   =========================== */

function applyGlobalSearch(termRaw) {
  const term = (termRaw || "").trim().toLowerCase();

  if (!term) {
    document.querySelectorAll('#categoryContainer .item').forEach(catEl => {
      catEl.style.display = "";
    });

    const activeCatEl =
      document.querySelector('#categoryContainer .item.active') ||
      document.querySelector('#categoryContainer .item');

    if (activeCatEl) {
      /* ✅ niente autoplay quando resetti la ricerca */
      selectCategory(activeCatEl.textContent.trim(), { autoplayFirst: false });
    }
    return;
  }

  const catsWithMatch = new Set(
    allChannels
      .filter(ch => String(ch.name).toLowerCase().includes(term))
      .map(ch => ch.group)
  );

  document.querySelectorAll('#categoryContainer .item').forEach(catEl => {
    const catName = catEl.textContent.trim();
    catEl.style.display = catsWithMatch.has(catName) ? "" : "none";
  });

  const activeCatEl = document.querySelector('#categoryContainer .item.active');
  const activeName = activeCatEl?.textContent.trim();

  if (!activeName || !catsWithMatch.has(activeName)) {
    const firstVisible = Array.from(document.querySelectorAll('#categoryContainer .item'))
      .find(el => el.style.display !== "none");
    if (firstVisible) {
      selectCategory(firstVisible.textContent.trim(), { autoplayFirst: false });
    }
  }

  const currentCat = document.querySelector('#categoryContainer .item.active')?.textContent.trim();
  if (currentCat) renderChansFiltered(currentCat, term);
}

const searchInput = document.getElementById("channelSearch");
if (searchInput) {
  searchInput.addEventListener("input", function () {
    applyGlobalSearch(this.value);
  });
}

/* ===========================
   UI AUTO HIDE
   =========================== */

function scheduleUiHide(delay) {
  clearTimeout(hideUiTimer);
  if (!el.video || el.video.paused || el.video.ended) return;

  hideUiTimer = setTimeout(() => {
    if (el.video.paused || el.video.ended) return;
    const focused = document.activeElement;
    if (focused && el.ui?.contains(focused) && /^(INPUT|SELECT|BUTTON)$/.test(focused.tagName)) {
      scheduleUiHide(3000);
      return;
    }
    el.ui?.classList.remove('visible');
  }, delay);
}

function showUI(event) {
  if (!el.ui) return;
  el.ui.classList.add('visible');
  const isTouch = event?.pointerType === "touch" || event?.type === "touchstart";
  scheduleUiHide(isTouch ? 7000 : 4000);
}

function hideUI() {
  clearTimeout(hideUiTimer);
  el.ui?.classList.remove('visible');
}

function toggleUI() {
  if (!el.ui) return;
  if (el.ui.classList.contains('visible')) hideUI();
  else showUI();
}

el.video?.addEventListener('click', toggleUI);
el.ui?.addEventListener('click', event => {
  if (event.target.closest('button, input, select, .sidebar, .epg-card, .video-controls-hint')) return;
  toggleUI();
});

document.addEventListener('mousemove', showUI);
document.addEventListener('keydown', showUI);
document.addEventListener('pointerdown', event => {
  if (event.target !== el.video) showUI(event);
});
document.addEventListener('touchstart', event => {
  if (event.target !== el.video) showUI(event);
}, { passive: true });
document.addEventListener('focusin', showUI);

init();
showUI();
