const fs = require('fs');
const https = require('https');
const path = require('path');

const EVENTS_URL = 'https://www.parkrunnertourist.com/events1.json';

const COURSE_MAPS_URL = process.env.COURSE_MAPS_URL;
if (!COURSE_MAPS_URL) {
  throw new Error("COURSE_MAPS_URL secret not set");
}

const OUTPUT_DIR = path.join(__dirname, '../explore');
const MAX_EVENTS = 9999999;
const MAX_FILES_PER_FOLDER = 999;
const EVENT_LIMIT = parseInt(process.env.EVENT_LIMIT || '0', 10);
const BASE_URL = 'https://www.parkrunnertourist.com/explore';

const COUNTRIES = {
  "0": {"url": null},
  "3": {"url": "www.parkrun.com.au"},
  "4": {"url": "www.parkrun.co.at"},
  "14": {"url": "www.parkrun.ca"},
  "23": {"url": "www.parkrun.dk"},
  "30": {"url": "www.parkrun.fi"},
  "32": {"url": "www.parkrun.com.de"},
  "42": {"url": "www.parkrun.ie"},
  "44": {"url": "www.parkrun.it"},
  "46": {"url": "www.parkrun.jp"},
  "54": {"url": "www.parkrun.lt"},
  "57": {"url": "www.parkrun.my"},
  "64": {"url": "www.parkrun.co.nl"},
  "65": {"url": "www.parkrun.co.nz"},
  "67": {"url": "www.parkrun.no"},
  "74": {"url": "www.parkrun.pl"},
  "82": {"url": "www.parkrun.sg"},
  "85": {"url": "www.parkrun.co.za"},
  "88": {"url": "www.parkrun.se"},
  "97": {"url": "www.parkrun.org.uk"},
  "98": {"url": "www.parkrun.us"}
};

const COUNTRY_NAMES = {
  "0":  "unknown",
  "3":  "australia",
  "4":  "austria",
  "14": "canada",
  "23": "denmark",
  "30": "finland",
  "32": "germany",
  "42": "ireland",
  "44": "italy",
  "46": "japan",
  "54": "lithuania",
  "57": "malaysia",
  "64": "netherlands",
  "65": "new-zealand",
  "67": "norway",
  "74": "poland",
  "82": "singapore",
  "85": "south-africa",
  "88": "sweden",
  "97": "united-kingdom",
  "98": "united-states"
};

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function slugify(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function getParkrunDomain(code) {
  return COUNTRIES[code]?.url || "www.parkrun.org.uk";
}

function getSubfolder(slug) {
  const firstChar = slug.charAt(0).toLowerCase();
  if (firstChar >= 'a' && firstChar <= 'z') return firstChar.toUpperCase();
  return '0-9';
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ============================================================
// COORDINATE ENCRYPTION
// ============================================================
function eventSeed(name) {
  let h = 0x12345678;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 0x9e3779b9);
    h ^= h >>> 16;
  }
  return Math.abs(h) % 0xFFFFFF;
}

function encryptCoords(coords, seed) {
  const flat = [];
  let s = seed & 0xFFFFFFFF;
  for (const [lng, lat] of coords) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    flat.push(Math.round(lng * 1e6) ^ (s & 0xFFFFFF));
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    flat.push(Math.round(lat * 1e6) ^ (s & 0xFFFFFF));
  }
  return Buffer.from(JSON.stringify(flat)).toString('base64');
}

function decryptFnJs() {
  return `function _d(b,s){const f=JSON.parse(atob(b));const r=[];let v=s>>>0;for(let i=0;i<f.length;i+=2){v=(Math.imul(v,1664525)+1013904223)>>>0;const lng=(f[i]^(v&0xFFFFFF))/1e6;v=(Math.imul(v,1664525)+1013904223)>>>0;const lat=(f[i+1]^(v&0xFFFFFF))/1e6;r.push([lng,lat]);}return r;}`;
}

// ============================================================
// SITEMAP HELPERS
// ============================================================
function locationSlug(eventLocation) {
  if (!eventLocation || !eventLocation.trim()) return 'unknown';
  const primary = eventLocation.split(',')[0].trim();
  return slugify(primary) || slugify(eventLocation) || 'unknown';
}

function buildLocationPath(event) {
  const countryCode = String(event.properties.countrycode);
  const country = COUNTRY_NAMES[countryCode] || 'unknown';
  const loc = locationSlug(event.properties.EventLocation || '');
  return `https://www.parkrunnertourist.com/locations/${country}/${loc}/`;
}

// ============================================================
// GENERATE HTML
// ============================================================
async function generateHtml(event, relativePath, allEventsInfo, slugToSubfolder, courseMaps = {}) {
  const name = event.properties.eventname || 'Unknown event';
  const longName = event.properties.EventLongName || name;
  const isCurrentJunior = longName.toLowerCase().includes('junior');
  const location = event.properties.EventLocation || '';
  const coords = event.geometry.coordinates || [];
  const latitude = coords[1] || 0;
  const longitude = coords[0] || 0;
  const encodedName = encodeURIComponent(`${longName}`);
  const countryCode = event.properties.countrycode;
  const parkrunDomain = getParkrunDomain(countryCode);
  const eventSlug = slugify(name);

  let description = event.properties.EventDescription || '';
  const hasDescription = description && description.trim() !== '' && description.trim() !== 'No description available.';
  if (hasDescription) {
    description = `<p>${description.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>`;
  }

  const currentSlug = slugify(name);
  const nearby = allEventsInfo
    .filter(e => {
      const eIsJunior = e.longName.toLowerCase().includes('junior');
      return e.slug !== currentSlug && e.country === countryCode && eIsJunior === isCurrentJunior;
    })
    .map(e => ({ ...e, dist: calculateDistance(latitude, longitude, e.lat, e.lon) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 4);

  const nearbyHtml = nearby.length > 0 ? `
<div id="nearby-section" class="iframe-container">
  <h2 class="section-title">Nearby ${isCurrentJunior ? 'Junior Events' : 'Events'}</h2>
  <ul class="nearby-list">
    ${nearby.map(n => `<li class="nearby-item"><a href="${BASE_URL}/${slugToSubfolder[n.slug] || getSubfolder(n.slug)}/${n.slug}" target="_blank">${n.longName}</a> <span class="distance">(${n.dist.toFixed(1)} km)</span></li>`).join('')}
  </ul>
</div>` : '';

  const stay22BaseUrl = `https://www.stay22.com/embed/gm?aid=parkrunnertourist&lat=${latitude}&lng=${longitude}&maincolor=${isCurrentJunior ? '40e0d0' : '7dd856'}&venue=${encodedName}`;
  const stay22ExpBaseUrl = `${stay22BaseUrl}&invmode=experience`;
  const siteName = isCurrentJunior ? 'junior parkrunner tourist' : 'parkrunner tourist';
  const pageTitle = `${longName} - Hotels & Visitor Guide`;
  const weatherIframeUrl = `https://parkrunnertourist.com/weather?lat=${latitude}&lon=${longitude}`;

  const accentColor = isCurrentJunior ? '#40e0d0' : '#4caf50';
  const darkColor   = isCurrentJunior ? '#008080' : '#2e7d32';

  const courseKey = Object.keys(courseMaps).find(k =>
    k === name ||
    k === name.toLowerCase() ||
    k === eventSlug ||
    k.replace(/-/g,'').toLowerCase() === name.replace(/\s+/g,'').toLowerCase()
  );
  const courseData = courseKey ? courseMaps[courseKey] : null;
  const hasRoute   = courseData && Array.isArray(courseData.route) && courseData.route.length > 1;
  const hasStart   = hasRoute && Array.isArray(courseData.start)  && courseData.start.length === 2;
  const hasFinish  = hasRoute && Array.isArray(courseData.finish) && courseData.finish.length === 2;
  const courseUrl  = (courseData && courseData.url) ? courseData.url : null;

  const seed = eventSeed(name);
  const encRoute  = hasRoute  ? `"${encryptCoords(courseData.route,           seed)}"` : 'null';
  const encStart  = hasStart  ? `"${encryptCoords([courseData.start],  seed +  7)}"` : 'null';
  const encFinish = hasFinish ? `"${encryptCoords([courseData.finish], seed + 13)}"` : 'null';

  const courseTileHtml = `
<div id="course-terrain-section" class="iframe-container">
  <h2 class="section-title">Course &amp; Terrain</h2>
  ${hasRoute ? `
  <div id="course-preview-wrap" style="position:relative;width:100%;height:260px;border-radius:0.75rem;overflow:hidden;background:#e8f5e9;">
    <div id="course-preview-map" style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:1;border-radius:0.75rem;"></div>
    <button onclick="openCourseChoice()" style="position:absolute;bottom:10px;right:10px;z-index:10;
      background:rgba(255,255,255,0.92);backdrop-filter:blur(10px);border:none;border-radius:16px;
      padding:7px 14px;font-size:13px;font-weight:600;color:${darkColor};cursor:pointer;
      box-shadow:0 4px 14px rgba(0,0,0,0.18);display:flex;align-items:center;gap:6px;transition:all 0.2s;"
      onmouseover="this.style.transform='scale(1.04)'" onmouseout="this.style.transform='scale(1)'">
      <i class="fas fa-expand-alt"></i> Expand &amp; Animate
    </button>
    <div style="position:absolute;bottom:10px;left:10px;z-index:10;display:flex;gap:6px;">
      <span style="background:#28a745;color:#fff;border-radius:8px;padding:2px 8px;font-size:11px;font-weight:700;">&#9679; Start</span>
      <span style="background:#dc3545;color:#fff;border-radius:8px;padding:2px 8px;font-size:11px;font-weight:700;">&#9679; Finish</span>
    </div>
  </div>` : `
  <div style="text-align:center;padding:2rem 0;">
    <p style="color:#64748b;margin-bottom:1rem;font-size:0.95rem;">Course route data not yet available for this event.</p>
    <a href="https://${parkrunDomain}/${eventSlug}/course/" target="_blank" class="action-btn" style="font-size:0.9rem;"><i class="fas fa-route"></i> View Course Page</a>
  </div>`}
</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${pageTitle}</title>
<meta name="description" content="Visiting ${longName}? Compare nearby hotels, explore the course map, learn about the terrain, find local experiences and attractions, check the latest weather forecast and plan your perfect parkrun weekend." />
<meta name="author" content="Jake Lofthouse" />
<meta name="geo.placename" content="${location}" />
<meta name="geo.position" content="${latitude};${longitude}" />
<meta property="og:title" content="${pageTitle}" />
<meta property="og:description" content="Planning a visit to ${longName}? Discover nearby hotels, explore the course map, learn about the terrain, find local experiences and attractions, check the latest weather forecast and find local cafes." />
<meta property="og:url" content="https://www.parkrunnertourist.com/explore/${relativePath}" />
<meta property="og:type" content="article" />
<meta property="og:image" content="https://www.parkrunnertourist.com/explore/images/${relativePath}.jpg" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="${longName} course map" />
<meta name="twitter:card" content="https://www.parkrunnertourist.com/explore/images/${relativePath}.jpg" />
<meta name="twitter:title" content="${pageTitle}" />
<meta name="twitter:description" content="Planning a visit to ${longName}? Discover nearby hotels, explore the course map, terrain, weather forecast and local cafes." />
<meta name="robots" content="index, follow" />
<meta name="language" content="en" />
<link rel="canonical" href="https://www.parkrunnertourist.com/explore/${relativePath}" />
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.2.1/css/all.min.css">
<meta name="apple-itunes-app" content="app-id=6743163993, app-argument=https://www.parkrunnertourist.com">
<link rel="icon" type="image/x-icon" href="https://parkrunnertourist.com/favicon.ico">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-REFFZSK4XK"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-REFFZSK4XK');
</script>
<style>
* { box-sizing: border-box; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  margin: 0; padding: 0;
  background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
  line-height: 1.6;
}
header {
  background: linear-gradient(135deg, ${isCurrentJunior ? '#40e0d0 0%, #008080 100%' : '#2e7d32 0%, #1b5e20 100%'});
  color: white; padding: 1.5rem 2rem; font-weight: 600; font-size: 1.75rem;
  display: flex; justify-content: space-between; align-items: center;
  box-shadow: 0 4px 20px rgba(${isCurrentJunior ? '0,128,128' : '46,125,50'}, 0.3);
  position: relative; overflow: hidden;
}
header::before {
  content: ''; position: absolute; top:0;left:0;right:0;bottom:0;
  background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="20" cy="20" r="2" fill="rgba(255,255,255,0.1)"/><circle cx="80" cy="40" r="1.5" fill="rgba(255,255,255,0.1)"/><circle cx="40" cy="80" r="1" fill="rgba(255,255,255,0.1)"/></svg>');
  pointer-events: none;
}
header a { color:white;text-decoration:none;cursor:pointer;position:relative;z-index:1;transition:transform 0.3s ease; }
header a:hover { transform: translateY(-2px); }
.header-map-btn {
  padding: 0.5rem 1.25rem; background: rgba(255,255,255,0.2);
  border: 2px solid white; border-radius: 0.5rem; color: white;
  font-weight: 600; font-size: 1rem; cursor: pointer; transition: all 0.3s ease;
  position: relative; z-index: 1; text-decoration: none; display: inline-block;
}
.header-map-btn:hover { background: white; color: ${darkColor}; transform: translateY(-2px); }
main { padding: 3rem 2rem; max-width: 1400px; margin: 0 auto; }
h1 {
  font-size: 7rem; font-weight: 800; margin-bottom: 0.5rem;
  background: linear-gradient(135deg, ${darkColor}, ${accentColor});
  -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  text-align: center; position: relative; padding: 2rem 0 1rem 0; line-height: 1.2;
}
.description {
  background: white; padding: 2rem; border-radius: 1rem;
  box-shadow: 0 4px 20px rgba(0,0,0,0.1); margin-bottom: 3rem;
  border: 1px solid rgba(${isCurrentJunior ? '64,224,208' : '76,175,80'}, 0.2);
}
.description p { margin: 0; color: #374151; font-size: 1.1rem; }
.section-title {
  font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem;
  color: #1f2937; display: flex; align-items: center; gap: 0.5rem;
}
.section-title::before {
  content: ''; width: 4px; height: 1.5rem;
  background: linear-gradient(135deg, ${accentColor}, ${darkColor}); border-radius: 2px;
}
.toggle-btn {
  padding: 0.75rem 1.5rem; border-radius: 0.75rem; margin-right: 1rem; margin-bottom: 1rem;
  cursor: pointer; font-weight: 600; border: 2px solid ${accentColor};
  transition: all 0.3s ease; background-color: white; color: ${accentColor};
  user-select: none; font-size: 1rem;
}
.toggle-btn:hover:not(.active) { background-color: #f1f8e9; }
.toggle-btn.active {
  background: linear-gradient(135deg, ${accentColor}, ${darkColor});
  color: white; transform: translateY(-2px);
}
.content-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; margin-bottom: 2rem; }
.iframe-container {
  background: white; border-radius: 1rem; padding: 1rem;
  box-shadow: 0 8px 30px rgba(0,0,0,0.12);
  border: 1px solid rgba(${isCurrentJunior ? '64,224,208' : '76,175,80'}, 0.2); overflow: hidden;
}
.map-container {
  width: 100%;
  height: 400px;
  border-radius: 0.75rem;
  overflow: hidden;
  position: relative;
}
.map-label {
  position: absolute;
  top: -45px;
  left: 50%;
  transform: translateX(-50%);
  background: white;
  padding: 6px 14px;
  border-radius: 9999px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  font-weight: 700;
  font-size: 1.05rem;
  color: #1f2937;
  white-space: nowrap;
  z-index: 1000;
  pointer-events: none;
}
.weather-iframe { height: 300px; width: 100%; }
.accommodation-iframe { height: 600px; overflow-x: hidden; }
.parkrun-actions { display: flex; gap: 1rem; margin-bottom: 3rem; flex-wrap: wrap; justify-content: center; }
.action-btn {
  padding: 0.75rem 1.5rem; border-radius: 0.75rem; cursor: pointer; font-weight: 600;
  border: 2px solid ${accentColor}; transition: all 0.3s ease;
  background: linear-gradient(135deg, ${accentColor}, ${darkColor});
  color: white; text-decoration: none; display: inline-block; font-size: 1rem;
  box-shadow: 0 4px 15px rgba(${isCurrentJunior ? '64,224,208' : '76,175,80'}, 0.3);
}
.action-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(${isCurrentJunior ? '64,224,208' : '76,175,80'}, 0.4); }
#course-map-modal {
  display: none; position: fixed; top:0;left:0;width:100%;height:100%;
  z-index: 9999; background: rgba(0,0,0,0.65); backdrop-filter: blur(8px);
  align-items: center; justify-content: center;
}
#course-map-modal.show { display: flex; }
.course-modal-inner {
  background: #fff; border-radius: 20px; max-width: 560px; width: 96%; max-height: 92vh;
  overflow: hidden; box-shadow: 0 32px 80px rgba(0,0,0,0.4);
  display: flex; flex-direction: column; position: relative;
}
.course-modal-header {
  padding: 13px 16px 11px; border-bottom: 1px solid rgba(0,0,0,0.08);
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0; background: #fff;
}
.course-modal-title { font-size: 15px; font-weight: 700; color: rgba(0,0,0,0.87); }
.course-modal-close {
  background: rgba(0,0,0,0.07); border: none; border-radius: 50%;
  width: 30px; height: 30px; cursor: pointer; font-size: 14px;
  display: flex; align-items: center; justify-content: center;
  color: rgba(0,0,0,0.5); transition: background 0.2s;
}
.course-modal-close:hover { background: rgba(0,0,0,0.14); }
.course-modal-body { overflow-y: auto; flex: 1; display: flex; flex-direction: column; background: #fff; }
#course-map-wrap {
  position: relative; width: 100%; height: 320px; flex-shrink: 0;
  touch-action: none; user-select: none; overflow: hidden;
}
#course-modal-map { position: absolute; top:0;left:0;width:100%;height:100%;z-index:1; }
#course-animation-canvas { position: absolute; top:0;left:0;pointer-events:none;z-index:650;display:block; }
.course-video-controls {
  background: #fff; padding: 0 14px 12px;
  display: flex; flex-direction: column; gap: 2px; flex-shrink: 0;
  border-top: 1px solid rgba(0,0,0,0.07);
}
.course-progress-bar-wrap {
  position: relative; height: 4px; background: rgba(0,0,0,0.12);
  border-radius: 2px; cursor: pointer; margin: 10px 0 4px;
  transition: height 0.15s, margin-top 0.15s; user-select: none;
}
.course-progress-bar-wrap:hover,
.course-progress-bar-wrap.dragging { height: 7px; margin-top: 7px; }
.course-progress-bar-fill {
  height: 100%; background: #28a745; border-radius: 2px;
  pointer-events: none; position: relative;
}
.course-progress-bar-fill::after {
  content: ''; position: absolute; right: -6px; top: 50%;
  transform: translateY(-50%) scale(0);
  width: 13px; height: 13px; background: #28a745; border-radius: 50%;
  transition: transform 0.15s; pointer-events: none;
}
.course-progress-bar-wrap:hover .course-progress-bar-fill::after,
.course-progress-bar-wrap.dragging .course-progress-bar-fill::after { transform: translateY(-50%) scale(1); }
.course-video-row { display: flex; align-items: center; gap: 6px; }
.course-ctrl-btn {
  background: none; color: rgba(0,0,0,0.75); border: none; border-radius: 6px;
  padding: 5px 8px; font-size: 16px; cursor: pointer;
  transition: background 0.15s; display: flex; align-items: center; gap: 5px;
  position: relative; overflow: hidden;
}
.course-ctrl-btn:hover { background: rgba(0,0,0,0.07); }
.course-time-label { font-size: 13px; color: rgba(0,0,0,0.5); font-variant-numeric: tabular-nums; }
#elevation-chart-container {
  background: #fff; padding: 12px 14px 14px; flex-shrink: 0;
  border-top: 1px solid rgba(0,0,0,0.07);
}
.elevation-label {
  font-size: 11px; font-weight: 700; color: rgba(0,0,0,0.35);
  text-transform: uppercase; letter-spacing: 0.7px; margin-bottom: 6px;
}
.leaflet-control-attribution { display: none !important; }
.nearby-list { list-style: none; padding: 0; margin: 0; }
.nearby-item {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 1rem; padding: 0.5rem; border-radius: 0.5rem;
  background: #f8fafc; transition: background 0.3s;
}
.nearby-item:hover { background: #e2e8f0; }
.nearby-list a { color: ${accentColor}; text-decoration: none; font-weight: 500; }
.nearby-list a:hover { color: ${darkColor}; }
.distance { font-size: 0.9rem; color: #64748b; }
.cancel-banner { background: #ef4444; color: white; text-align: center; padding: 1rem; font-weight: bold; margin-bottom: 2rem; display: none; }
.status-icon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; font-size: 16px; margin-right: 8px; }
.green { background: #22c55e; color: white; }
.yellow { background: #eab308; color: white; }
.red { background: #ef4444; color: white; }
.cancel-tile p, .further-tile li { display: flex; align-items: center; }
.further-tile li { margin-bottom: 0.5rem; }
.last-update { font-size: 0.8rem; color: #64748b; margin-top: 0.5rem; }
.left-column { grid-column: 1; display: flex; flex-direction: column; gap: 2rem; }
.right-column { grid-column: 2; display: flex; flex-direction: column; gap: 2rem; }
.download-footer {
  background: linear-gradient(135deg, ${accentColor} 0%, ${darkColor} 100%);
  padding: 3rem 2rem; display: flex; flex-direction: column; align-items: center; gap: 1.5rem;
  color: white; font-weight: 700; font-size: 1.3rem; text-transform: uppercase; letter-spacing: 1px;
}
.app-badges { display: flex; gap: 2rem; }
.download-footer img { height: 70px; width: auto; transition: transform 0.3s ease; cursor: pointer; border-radius: 0.5rem; }
.download-footer img:hover { transform: scale(1.1) translateY(-4px); }
footer { text-align: center; padding: 2rem; background: #f8fafc; color: #64748b; font-weight: 500; }
@media (max-width: 1024px) {
  .content-grid { display: flex; flex-direction: column; gap: 1.5rem; }
  .left-column, .right-column { display: contents; }
  #cancel-tile { order:1; } #further-tile { order:2; }
  #weather-section { order:4; } #location-section { order:5; }
  #hotels-section { order:6; } #experiences-section { order:7; }
  #course-terrain-section { order:3; } #nearby-section { order:8; }
  [data-name="BMC-Widget"] { display: none !important; }
}
@media (max-width: 768px) {
  main { padding: 2rem 1rem; }
  h1 { font-size: 4rem; }
  header { padding: 1rem; font-size: 1.3rem; }
  .toggle-btn { margin-bottom: 0.5rem; margin-right: 0.5rem; padding: 0.5rem 1rem; font-size: 0.9rem; }
  .app-badges { flex-direction: column; gap: 1rem; align-items: center; }
  .accommodation-iframe, .map-iframe { height: 400px; }
  .weather-iframe { height: 200px; }
}
body.modal-open { overflow: hidden; height: 100vh; }
.social-row {
  margin-bottom: 1rem; display: flex; justify-content: center;
  gap: 1.5rem; font-size: 1.4rem;
}
.social-icon { color: #64748b; transition: all 0.25s ease; }
.social-icon:hover .fa-facebook { color: #1877f2; }
.social-icon:hover .fa-youtube { color: #ff0000; }
.social-icon:hover .fa-tiktok { color: #000; }
.social-icon:hover .fa-envelope { color: #4caf50; }
</style>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[{"@type":"SportsEvent","name":"${longName}","description":"Visitor guide to ${longName}. Hotels, course map, weather forecast and travel information.","sport":"Running","eventAttendanceMode":"OfflineEventAttendanceMode","location":{"@type":"Place","name":"${location}","geo":{"@type":"GeoCoordinates","latitude":"${latitude}","longitude":"${longitude}"}},"url":"https://www.parkrunnertourist.com/explore/${relativePath}"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is the weather like at ${longName} this week?","acceptedAnswer":{"@type":"Answer","text":"Check the Weather This Week section for the forecast."}},{"@type":"Question","name":"Where is ${longName} held?","acceptedAnswer":{"@type":"Answer","text":"${longName} takes place at ${location}."}},{"@type":"Question","name":"Where can I find hotels near ${longName}?","acceptedAnswer":{"@type":"Answer","text":"The Hotels and Rentals section lists nearby accommodations."}}]}]}
</script>
</head>
<body>
<header>
  <a href="https://www.parkrunnertourist.com" target="_self">${siteName}</a>
  <a href="https://download.parkrunnertourist.com/DXFn/34irtvw6" target="_blank" class="header-map-btn">Show Full Map</a>
</header>
<div id="cancel-banner" class="cancel-banner"></div>
<main>
  <h1>${longName} - Hotels &amp; Visitor Guide</h1>
  <div class="parkrun-actions">
    ${(hasRoute || courseUrl)
      ? `<button onclick="openCourseChoice()" class="action-btn course-map-btn">Course Map</button>`
      : `<a href="https://${parkrunDomain}/${eventSlug}/course/" target="_blank" class="action-btn course-map-btn">Course Map</a>`}
    <a href="https://${parkrunDomain}/${eventSlug}/futureroster/" target="_blank" class="action-btn">Volunteer Roster</a>
    <a href="https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}" target="_blank" class="action-btn">Directions</a>
  </div>
  ${hasDescription ? `<div class="description">${description}</div>` : ''}
  <div class="content-grid">
    <div class="left-column">
      <div id="hotels-section" class="iframe-container">
        <h2 class="section-title">Hotels &amp; Rentals</h2>
        <div>
          <button class="toggle-btn active" onclick="switchView('hotels','listview')" id="btn-listview-hotels">List View</button>
          <button class="toggle-btn" onclick="switchView('hotels','map')" id="btn-map-hotels">Map View</button>
        </div>
        <iframe id="stay22Frame" class="accommodation-iframe" width="100%" scrolling="no"
          title="Stay22 accommodation listing"></iframe>
      </div>
      <div id="experiences-section" class="iframe-container">
        <h2 class="section-title">Experiences</h2>
        <div>
          <button class="toggle-btn active" onclick="switchView('experiences','listview')" id="btn-listview-exp">List View</button>
          <button class="toggle-btn" onclick="switchView('experiences','map')" id="btn-map-exp">Map View</button>
        </div>
        <iframe id="stay22ExpFrame" class="accommodation-iframe" width="100%" scrolling="no"
          title="Stay22 experiences listing"></iframe>
      </div>
    </div>
    <div class="right-column">
      <div id="location-section" class="iframe-container" style="position:relative;">
        <h2 class="section-title">parkrun Location</h2>
        <div id="event-map" class="map-container"></div>
      </div>
      <div id="weather-section" class="iframe-container">
        <h2 class="section-title">Weather This Week</h2>
        <iframe class="weather-iframe" data-src="${weatherIframeUrl}" title="Weather forecast for ${name}"></iframe>
      </div>
      ${courseTileHtml}
      ${nearbyHtml}
      <div id="cancel-tile" class="iframe-container cancel-tile" style="display:none;">
        <h2 class="section-title">Event Status</h2>
        <p id="cancel-message"></p>
        <div id="cancel-update" class="last-update"></div>
      </div>
      <div id="further-tile" class="iframe-container further-tile" style="display:none;">
        <h2 class="section-title">Future Cancellations</h2>
        <ul id="further-list"></ul>
        <div id="further-update" class="last-update"></div>
      </div>
    </div>
  </div>
</main>

<!-- Course Choice Modal -->
<div id="course-choice-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;
  z-index:10000;background:rgba(0,0,0,0.65);backdrop-filter:blur(8px);
  align-items:center;justify-content:center;">
  <div style="background:#fff;border-radius:20px;max-width:420px;width:92%;padding:2rem;
    box-shadow:0 32px 80px rgba(0,0,0,0.4);position:relative;">
    <button onclick="closeCourseChoice()" style="position:absolute;top:14px;right:14px;
      background:rgba(0,0,0,0.07);border:none;border-radius:50%;width:30px;height:30px;
      cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;
      color:rgba(0,0,0,0.5);">&times;</button>
    <h3 style="margin:0 0 0.5rem 0;font-size:1.1rem;font-weight:700;color:#1f2937;">Course Map</h3>
    <p style="margin:0 0 1.5rem 0;font-size:0.9rem;color:#64748b;">Choose how you want to view the course.</p>
    <div style="display:flex;flex-direction:row;gap:0.75rem;">
      ${courseUrl ? `
      <button onclick="closeCourseChoice();openStandardMap();"
        style="flex:1;padding:1.25rem 1rem;border-radius:0.75rem;border:2px solid ${accentColor};
          background:#fff;color:${darkColor};
          font-weight:600;font-size:1rem;cursor:pointer;text-align:center;
          display:flex;flex-direction:column;align-items:center;gap:0.5rem;transition:all 0.2s;"
        onmouseover="this.style.background='#f0fdf4'" onmouseout="this.style.background='#fff'">
        <i class="fas fa-map" style="font-size:1.5rem;color:${accentColor};"></i>
        <strong>Standard</strong>
        <span style="font-size:0.78rem;font-weight:400;color:#64748b;line-height:1.3;">Interactive map view</span>
      </button>` : ''}
      ${hasRoute ? `
      <button onclick="closeCourseChoice();openCourseModal();"
        style="flex:1;padding:1.25rem 1rem;border-radius:0.75rem;border:2px solid ${accentColor};
          background:linear-gradient(135deg,${accentColor},${darkColor});color:#fff;
          font-weight:600;font-size:1rem;cursor:pointer;text-align:center;
          display:flex;flex-direction:column;align-items:center;gap:0.5rem;transition:all 0.2s;"
        onmouseover="this.style.opacity='0.88'" onmouseout="this.style.opacity='1'">
        <i class="fas fa-route" style="font-size:1.5rem;"></i>
        <strong>Advanced</strong>
        <span style="font-size:0.78rem;font-weight:400;opacity:0.9;line-height:1.3;">Animated route &amp; elevation</span>
      </button>` : ''}
    </div>
  </div>
</div>

<!-- Standard Course Map Modal -->
<div id="standard-map-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;
  z-index:10000;background:rgba(0,0,0,0.65);backdrop-filter:blur(8px);
  align-items:center;justify-content:center;">
  <div style="background:#fff;border-radius:20px;max-width:700px;width:96%;
    box-shadow:0 32px 80px rgba(0,0,0,0.4);overflow:hidden;display:flex;flex-direction:column;">
    <div style="padding:13px 16px 11px;border-bottom:1px solid rgba(0,0,0,0.08);
      display:flex;align-items:center;justify-content:space-between;background:#fff;flex-shrink:0;">
      <div style="font-size:15px;font-weight:700;color:rgba(0,0,0,0.87);">${longName} — Course Map</div>
      <button onclick="closeStandardMap()"
        style="background:rgba(0,0,0,0.07);border:none;border-radius:50%;width:30px;height:30px;
          cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;
          color:rgba(0,0,0,0.5);">&times;</button>
    </div>
    <iframe id="standard-map-iframe"
      style="width:100%;height:500px;border:none;display:block;"
      src="" title="${longName} course map" allowfullscreen></iframe>
  </div>
</div>

<!-- Contact Modal -->
<div id="contact-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;
  z-index:10000;background:rgba(0,0,0,0.65);backdrop-filter:blur(8px);
  align-items:center;justify-content:center;">
  <div style="background:#fff;border-radius:20px;width:95%;max-width:700px;height:85%;
    box-shadow:0 32px 80px rgba(0,0,0,0.4);position:relative;overflow:hidden;display:flex;flex-direction:column;">
    <button onclick="closeContactModal()" style="position:absolute;top:12px;right:12px;
      background:rgba(0,0,0,0.07);border:none;border-radius:50%;width:32px;height:32px;
      cursor:pointer;font-size:16px;">&times;</button>
    <iframe
      src="https://forms.office.com/Pages/ResponsePage.aspx?id=DQSIkWdsW0yxEjajBLZtrQAAAAAAAAAAAAN__tNkQhJUREJVMVA2OUJVVVlXMTBLUUo1MUI2REc5SC4u&embed=true"
      style="border:none;width:100%;height:100%;border-radius:20px;"
      allowfullscreen>
    </iframe>
  </div>
</div>

<!-- Course Map Modal -->
<div id="course-map-modal">
  <div class="course-modal-inner">
    <div class="course-modal-header">
      <div class="course-modal-title" id="course-modal-title">Course Route</div>
      <button class="course-modal-close" onclick="closeCourseModal()">&times;</button>
    </div>
    <div class="course-modal-body">
      <div id="course-map-wrap">
        <div id="course-modal-map"></div>
        <canvas id="course-animation-canvas"></canvas>
      </div>
      <div class="course-video-controls">
        <div class="course-progress-bar-wrap" id="course-progress-wrap">
          <div class="course-progress-bar-fill" id="course-progress-fill" style="width:0%"></div>
        </div>
        <div class="course-video-row">
          <button class="course-ctrl-btn" id="course-play-btn" onclick="toggleCourseAnimation()">
            <i class="fas fa-play"></i>
          </button>
          <span class="course-time-label" id="course-time-label">0:00 / 0:30</span>
        </div>
      </div>
      <div id="elevation-chart-container">
        <div class="elevation-label">Elevation Profile — click to jump</div>
        <canvas id="elevation-chart" height="100"></canvas>
      </div>
    </div>
  </div>
</div>

<div class="download-footer">
  Download The App
  <div class="app-badges">
    <a href="https://apps.apple.com/gb/app/parkrunner-tourist/id6743163993" target="_blank" rel="noopener noreferrer">
      <img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" alt="Download on the App Store" />
    </a>
    <a href="https://play.google.com/store/apps/details?id=appinventor.ai_jlofty8.parkrunner_tourist" target="_blank" rel="noopener noreferrer">
      <img src="https://upload.wikimedia.org/wikipedia/commons/7/78/Google_Play_Store_badge_EN.svg" alt="Get it on Google Play" />
    </a>
  </div>
</div>
<footer>
  <p style="max-width:900px;margin:0 auto 1rem auto;font-size:0.85rem;line-height:1.5;color:#64748b;">
    parkrun is a registered trademark of parkrun Limited.
    This website is independent and is not affiliated with or endorsed by parkrun.
  </p>
  <div class="social-row">
    <a href="https://www.facebook.com/profile.php?id=61585873650397" target="_blank" class="social-icon">
      <i class="fab fa-facebook"></i>
    </a>
    <a href="https://www.youtube.com/@parkrunnertourist-app" target="_blank" class="social-icon">
      <i class="fab fa-youtube"></i>
    </a>
    <a href="https://www.tiktok.com/@parkrunner.tourist.app" target="_blank" class="social-icon">
      <i class="fab fa-tiktok"></i>
    </a>
    <a href="#" onclick="openContactModal()" class="social-icon">
      <i class="fas fa-envelope"></i>
    </a>
  </div>
  <p style="font-size:0.9rem;color:#64748b;">
    &copy; ${new Date().getFullYear()} ${siteName}
  </p>
</footer>

<script data-name="BMC-Widget" data-cfasync="false" src="https://cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js"
  data-id="jlofthouse" data-description="Support me on Buy me a coffee!"
  data-message="Support The App" data-color="#40DCA5" data-position="Right"
  data-x_margin="18" data-y_margin="18"></script>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script>
${decryptFnJs()}

const _er = ${encRoute};
const _es = ${encStart};
const _ef = ${encFinish};
const _sk = ${seed};
const _courseRoute  = _er ? _d(_er, _sk)         : null;
const _courseStart  = _es ? _d(_es, _sk +  7)[0] : null;
const _courseFinish = _ef ? _d(_ef, _sk + 13)[0] : null;
const HAS_ROUTE = !!(_courseRoute && _courseRoute.length > 1);

function getNextFridayDateISO() {
  const today = new Date();
  const day = today.getDay();
  const daysUntilFriday = (5 - day + 7) % 7 || 7;
  today.setDate(today.getDate() + daysUntilFriday);
  return today.toISOString().slice(0, 10);
}
const _checkinDate   = getNextFridayDateISO();
const _stay22Base    = "${stay22BaseUrl}&checkin=" + _checkinDate;
const _stay22ExpBase = "${stay22ExpBaseUrl}&checkin=" + _checkinDate;

document.getElementById('stay22Frame').src    = _stay22Base    + '&viewmode=listview&listviewexpand=true';
document.getElementById('stay22ExpFrame').src = _stay22ExpBase + '&viewmode=listview&listviewexpand=true';

function switchView(type, mode) {
  const id      = type === 'hotels' ? 'stay22Frame' : 'stay22ExpFrame';
  const baseUrl = type === 'hotels' ? _stay22Base : _stay22ExpBase;
  document.getElementById(id).src = baseUrl + '&viewmode=' + mode + '&listviewexpand=' + (mode === 'listview');
  const pfx = type === 'hotels' ? 'hotels' : 'exp';
  document.getElementById('btn-listview-' + pfx).classList.toggle('active', mode === 'listview');
  document.getElementById('btn-map-'      + pfx).classList.toggle('active', mode === 'map');
}

document.addEventListener('DOMContentLoaded', function() {
  const isBot = /bot|crawler|spider|facebookexternalhit|twitterbot|linkedinbot|googlebot|bingbot/i.test(navigator.userAgent);
  if (!isBot && 'IntersectionObserver' in window) {
    const obs = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting && !e.target.src) {
          e.target.src = e.target.dataset.src; obs.unobserve(e.target);
        }
      });
    }, { rootMargin: '50px' });
    document.querySelectorAll('iframe[data-src]').forEach(f => obs.observe(f));
  } else if (!isBot) {
    setTimeout(() => document.querySelectorAll('iframe[data-src]').forEach(f => { if (!f.src) f.src = f.dataset.src; }), 1000);
  }

  (async function() {
    try {
      const [upcoming, further, lastUpdate] = await Promise.all([
        fetch('https://www.parkrunnertourist.com/cancellations/upcoming.json').then(r => r.json()),
        fetch('https://www.parkrunnertourist.com/cancellations/further.json').then(r => r.json()),
        fetch('https://www.parkrunnertourist.com/cancellations/lastupdate.json').then(r => r.json())
      ]);
      const eventName = '${longName}';
      const upcomingCancel = upcoming.find(c => c.name === eventName);
      const furtherCancels = further.filter(c => c.name === eventName);
      const updateTime = lastUpdate.updated_utc ? new Date(lastUpdate.updated_utc).toLocaleString() : 'Unknown';
      const cancelTile = document.getElementById('cancel-tile');
      cancelTile.style.display = 'block';
      document.getElementById('cancel-update').textContent = 'Last updated: ' + updateTime;
      if (upcomingCancel) {
        const b = document.getElementById('cancel-banner');
        b.textContent = 'This event is cancelled on ' + upcomingCancel.date + ': ' + upcomingCancel.reason;
        b.style.display = 'block';
        document.getElementById('cancel-message').innerHTML = '<span class="status-icon red">!</span> Cancelled: ' + upcomingCancel.reason + ' on ' + upcomingCancel.date;
      } else {
        document.getElementById('cancel-message').innerHTML = '<span class="status-icon green">&#10003;</span> Event is running as scheduled';
      }
      if (furtherCancels.length > 0) {
        document.getElementById('further-tile').style.display = 'block';
        document.getElementById('further-update').textContent = 'Last updated: ' + updateTime;
        document.getElementById('further-list').innerHTML = furtherCancels.map(c =>
          '<li><span class="status-icon yellow">!</span> ' + c.reason + ' on ' + c.date + '</li>').join('');
      }
    } catch (e) { console.warn('Cancellations:', e); }
  })();

  if (HAS_ROUTE) setTimeout(initCoursePreview, 100);

  const mapEl = document.getElementById('event-map');
  if (mapEl) {
    const locMap = L.map('event-map', {
      zoomControl: true, scrollWheelZoom: true, attributionControl: false
    });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 19
    }).addTo(locMap);
    const iconUrl = ${isCurrentJunior ? "'../../Icons/Junior.png'" : "'../../Icons/5k.png'"};
    const customIcon = L.icon({
      iconUrl: iconUrl, iconSize: [48, 48], iconAnchor: [24, 42], popupAnchor: [0, -40]
    });
    L.marker([${latitude}, ${longitude}], { icon: customIcon }).addTo(locMap);
    const label = document.createElement('div');
    label.className = 'map-label';
    label.textContent = '${longName}';
    mapEl.appendChild(label);
    locMap.setView([${latitude}, ${longitude}], 15);
  }
});

let _previewMap = null;

function initCoursePreview() {
  const el = document.getElementById('course-preview-map');
  if (!el || _previewMap) return;
  _previewMap = L.map('course-preview-map', {
    zoomControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false,
    tap: false, touchZoom: false, attributionControl: false
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 18
  }).addTo(_previewMap);
  const routeLatLngs = _courseRoute.map(p => [p[1], p[0]]);
  L.polyline(routeLatLngs, {
    color: '#28a745', weight: 3.5, opacity: 0.9, lineJoin: 'round', lineCap: 'round'
  }).addTo(_previewMap);
  const startPt = _courseStart || _courseRoute[0];
  L.circleMarker([startPt[1], startPt[0]], {
    radius: 7, fillColor: '#28a745', color: '#fff', weight: 2, fillOpacity: 1
  }).addTo(_previewMap);
  const finishPt = _courseFinish || _courseRoute[_courseRoute.length - 1];
  L.circleMarker([finishPt[1], finishPt[0]], {
    radius: 7, fillColor: '#dc3545', color: '#fff', weight: 2, fillOpacity: 1
  }).addTo(_previewMap);
  _previewMap.fitBounds(L.latLngBounds(routeLatLngs), { padding: [24, 24], animate: false });
}

const _courseUrl = ${courseUrl ? `"${courseUrl}"` : 'null'};

function openCourseChoice() {
  document.body.classList.add('modal-open');
  document.getElementById('course-choice-modal').style.display = 'flex';
}
function closeCourseChoice() {
  document.getElementById('course-choice-modal').style.display = 'none';
  document.body.classList.remove('modal-open');
}
document.getElementById('course-choice-modal').addEventListener('click', function(e) {
  if (e.target === this) closeCourseChoice();
});
function openStandardMap() {
  if (!_courseUrl) return;
  document.body.classList.add('modal-open');
  document.getElementById('standard-map-iframe').src = _courseUrl;
  document.getElementById('standard-map-modal').style.display = 'flex';
}
function closeStandardMap() {
  document.getElementById('standard-map-modal').style.display = 'none';
  document.getElementById('standard-map-iframe').src = '';
  document.body.classList.remove('modal-open');
}
function openContactModal() {
  document.getElementById('contact-modal').style.display = 'flex';
  document.body.classList.add('modal-open');
}
function closeContactModal() {
  document.getElementById('contact-modal').style.display = 'none';
  document.body.classList.remove('modal-open');
}
document.getElementById('contact-modal').addEventListener('click', function(e) {
  if (e.target === this) closeContactModal();
});
document.getElementById('standard-map-modal').addEventListener('click', function(e) {
  if (e.target === this) closeStandardMap();
});

function openCourseModal() {
  document.body.classList.add('modal-open');
  if (!HAS_ROUTE) return;
  if (courseAnimFrameId) cancelAnimationFrame(courseAnimFrameId);
  courseAnimRunning = false;
  document.getElementById('course-map-modal').classList.add('show');
  const displayName = '${name}';
  document.getElementById('course-modal-title').textContent =
    displayName.charAt(0).toUpperCase() + displayName.slice(1) + ' parkrun';
  const maxKm = displayName.toLowerCase().includes('junior') ? 2.0 : 5.0;
  const [route, dists] = trimRouteToDistance(_courseRoute, maxKm);
  _trimmedRoute = route; courseDistances = dists;
  initProgressBarDrag();
  setTimeout(() => {
    initCourseModalMap(route);
    buildElevationChart(route, dists, null);
    fetchElevation(route).then(elevs => {
      if (elevs && elevs.length === route.length) {
        courseElevationData = elevs; buildElevationChart(route, dists, elevs);
      }
    });
    setTimeout(() => { syncCanvasSize(); updateCourseFrame(0); setTimeout(restartCourseAnimation, 50); }, 300);
  }, 80);
}
function closeCourseModal() {
  document.body.classList.remove('modal-open');
  document.getElementById('course-map-modal').classList.remove('show');
  if (courseAnimFrameId) cancelAnimationFrame(courseAnimFrameId);
  courseAnimRunning = false;
}
document.getElementById('course-map-modal').addEventListener('click', function(e) {
  if (e.target === this) closeCourseModal();
});

let courseModalMap = null;
let courseModalStartMark = null;
let courseModalFinishMark = null;
const COURSE_ANIM_DURATION = 30;
let courseAnimStartTime = null;
let courseAnimElapsedAtPause = 0;
let courseAnimRunning = false;
let courseAnimFrameId = null;
let courseAnimCanvas = null;
let courseAnimCtx = null;
let courseElevationChart = null;
let courseElevationData = [];
let courseDistances = [];
let _courseFitZoom = null;
let _trimmedRoute = null;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function trimRouteToDistance(route, maxKm) {
  const dists = [0]; const trimmed = [route[0]];
  for (let i = 1; i < route.length; i++) {
    const d = dists[i-1] + haversine(route[i-1][1], route[i-1][0], route[i][1], route[i][0]);
    if (d >= maxKm) {
      const prev = route[i-1], cur = route[i], frac = (maxKm - dists[i-1]) / (d - dists[i-1]);
      trimmed.push([prev[0] + (cur[0]-prev[0])*frac, prev[1] + (cur[1]-prev[1])*frac]);
      dists.push(maxKm); break;
    }
    trimmed.push(route[i]); dists.push(d);
  }
  return [trimmed, dists];
}
function fetchElevation(route) {
  return fetch('https://api.open-elevation.com/api/v1/lookup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations: route.map(c => ({ latitude: c[1], longitude: c[0] })) })
  }).then(r => r.json()).then(d => d.results.map(r => r.elevation)).catch(() => null);
}
function syncCanvasSize() {
  const wrap = document.getElementById('course-map-wrap');
  const canvas = document.getElementById('course-animation-canvas');
  if (!wrap || !canvas) return;
  const w = wrap.offsetWidth, h = wrap.offsetHeight;
  if (w <= 0 || h <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w*dpr), ph = Math.round(h*dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw; canvas.height = ph;
    canvas.style.width = w+'px'; canvas.style.height = h+'px';
  }
  courseAnimCanvas = canvas; courseAnimCtx = canvas.getContext('2d');
}
function initCourseModalMap(route) {
  if (!courseModalMap) {
    courseModalMap = L.map('course-modal-map', {
      zoomControl: true, dragging: true, scrollWheelZoom: true,
      doubleClickZoom: true, boxZoom: false, keyboard: false,
      tap: false, touchZoom: true, attributionControl: false
    });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(courseModalMap);
    courseModalMap.on('move zoom', _drawFrame);
    courseModalMap.on('moveend zoomend', function() { _drawFrame(); _enforceMinZoom(); });
  }
  if (courseModalStartMark)  courseModalMap.removeLayer(courseModalStartMark);
  if (courseModalFinishMark) courseModalMap.removeLayer(courseModalFinishMark);
  if (_courseStart) {
    courseModalStartMark = L.circleMarker([_courseStart[1], _courseStart[0]],
      { radius: 10, fillOpacity: 0, opacity: 0, interactive: true }).addTo(courseModalMap);
    courseModalStartMark.bindTooltip('Start', { permanent: false, direction: 'top' });
    courseModalStartMark._lo = false;
    courseModalStartMark.on('click', function() { this._lo ? this.closeTooltip() : this.openTooltip(); this._lo = !this._lo; });
  }
  if (_courseFinish) {
    courseModalFinishMark = L.circleMarker([_courseFinish[1], _courseFinish[0]],
      { radius: 10, fillOpacity: 0, opacity: 0, interactive: true }).addTo(courseModalMap);
    courseModalFinishMark.bindTooltip('Finish', { permanent: false, direction: 'top' });
    courseModalFinishMark._lo = false;
    courseModalFinishMark.on('click', function() { this._lo ? this.closeTooltip() : this.openTooltip(); this._lo = !this._lo; });
  }
  courseModalMap.invalidateSize({ animate: false });
  const bounds = L.latLngBounds(route.map(p => [p[1], p[0]]));
  courseModalMap.fitBounds(bounds, { padding: [55, 55], animate: false });
  _courseFitZoom = courseModalMap.getZoom();
  syncCanvasSize();
}
function _drawFrame() {
  if (courseAnimRunning) return;
  const pct = parseFloat(document.getElementById('course-progress-fill').style.width || '0') / 100;
  syncCanvasSize(); updateCourseFrame(pct, true);
}
function _enforceMinZoom() {
  if (_courseFitZoom && courseModalMap && courseModalMap.getZoom() < _courseFitZoom)
    courseModalMap.setZoom(_courseFitZoom, { animate: true });
}
function getInterpolatedPoint(route, progress) {
  const totalPts = route.length - 1;
  const fi = Math.min(progress * totalPts, totalPts);
  const fullIdx = Math.min(Math.floor(fi), route.length - 2);
  const frac = fi - fullIdx;
  const p1 = route[fullIdx], p2 = route[Math.min(fullIdx+1, route.length-1)];
  return { lat: p1[1]+(p2[1]-p1[1])*frac, lon: p1[0]+(p2[0]-p1[0])*frac, idx: fullIdx };
}
function updateCourseFrame(progress) {
  if (!courseModalMap) return;
  syncCanvasSize();
  const canvas = courseAnimCanvas, ctx = courseAnimCtx;
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save(); ctx.scale(dpr, dpr);
  const route = _trimmedRoute || _courseRoute;
  if (!route) { ctx.restore(); return; }
  function toXY(lat, lon) {
    const p = courseModalMap.latLngToContainerPoint(L.latLng(lat, lon));
    return [p.x, p.y];
  }
  ctx.beginPath(); ctx.setLineDash([7,5]); ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(150,150,150,0.5)'; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (let i = 0; i < route.length; i++) {
    const [x,y] = toXY(route[i][1], route[i][0]);
    i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
  }
  ctx.stroke(); ctx.setLineDash([]);
  const totalPts = route.length - 1;
  const fi = progress * totalPts;
  const fullIdx = Math.min(Math.floor(fi), route.length - 2);
  const frac = fi - fullIdx;
  const startLL  = _courseStart;
  const finishLL = _courseFinish;
  const [sx,sy]  = startLL  ? toXY(startLL[1],  startLL[0])  : toXY(route[0][1], route[0][0]);
  const [fx,fy]  = finishLL ? toXY(finishLL[1], finishLL[0]) : toXY(route[route.length-1][1], route[route.length-1][0]);
  if (progress > 0) {
    ctx.beginPath(); ctx.lineWidth = 5; ctx.strokeStyle = '#28a745';
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const [x0,y0] = toXY(route[0][1], route[0][0]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i <= Math.min(fullIdx, route.length-2); i++) {
      const [x,y] = toXY(route[i][1], route[i][0]);
      ctx.lineTo(x,y);
    }
    if (fullIdx < route.length-1) {
      const [x1,y1] = toXY(route[fullIdx][1],   route[fullIdx][0]);
      const [x2,y2] = toXY(route[fullIdx+1][1], route[fullIdx+1][0]);
      ctx.lineTo(x1+(x2-x1)*frac, y1+(y2-y1)*frac);
    }
    ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(fx,fy,8,0,Math.PI*2);
  ctx.fillStyle='#dc3545'; ctx.fill(); ctx.strokeStyle='#fff'; ctx.lineWidth=2.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(sx,sy,8,0,Math.PI*2);
  ctx.fillStyle='#28a745'; ctx.fill(); ctx.strokeStyle='#fff'; ctx.lineWidth=2.5; ctx.stroke();
  const {lat,lon} = getInterpolatedPoint(route, progress);
  const [dx,dy] = toXY(lat,lon);
  const grd = ctx.createRadialGradient(dx,dy,3,dx,dy,18);
  grd.addColorStop(0,'rgba(255,193,7,0.55)'); grd.addColorStop(1,'rgba(255,193,7,0)');
  ctx.beginPath(); ctx.arc(dx,dy,18,0,Math.PI*2); ctx.fillStyle=grd; ctx.fill();
  ctx.beginPath(); ctx.arc(dx,dy,8,0,Math.PI*2);
  ctx.fillStyle='#ffc107'; ctx.fill(); ctx.strokeStyle='#fff'; ctx.lineWidth=2.5; ctx.stroke();
  ctx.restore();
  document.getElementById('course-progress-fill').style.width = (progress*100) + '%';
  const tot = COURSE_ANIM_DURATION;
  const cur = progress * tot;
  const fmt = s => Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
  document.getElementById('course-time-label').textContent = fmt(cur) + ' / ' + fmt(tot);
  updateElevationCursor(progress);
}
function runCourseAnimation(ts) {
  if (!courseAnimRunning) return;
  if (!courseAnimStartTime) courseAnimStartTime = ts;
  const elapsed = (ts - courseAnimStartTime)/1000 + courseAnimElapsedAtPause;
  const progress = Math.min(elapsed / COURSE_ANIM_DURATION, 1);
  updateCourseFrame(progress);
  if (progress >= 1) {
    courseAnimRunning = false; courseAnimElapsedAtPause = COURSE_ANIM_DURATION;
    document.getElementById('course-play-btn').innerHTML = '<i class="fas fa-redo"></i>'; return;
  }
  courseAnimFrameId = requestAnimationFrame(runCourseAnimation);
}
function restartCourseAnimation() {
  if (courseAnimFrameId) cancelAnimationFrame(courseAnimFrameId);
  courseAnimStartTime = null; courseAnimElapsedAtPause = 0; courseAnimRunning = true;
  document.getElementById('course-play-btn').innerHTML = '<i class="fas fa-pause"></i>';
  courseAnimFrameId = requestAnimationFrame(runCourseAnimation);
}
function toggleCourseAnimation() {
  if (courseAnimElapsedAtPause >= COURSE_ANIM_DURATION) { restartCourseAnimation(); return; }
  courseAnimRunning = !courseAnimRunning;
  const btn = document.getElementById('course-play-btn');
  if (courseAnimRunning) {
    btn.innerHTML = '<i class="fas fa-pause"></i>';
    courseAnimStartTime = null; courseAnimFrameId = requestAnimationFrame(runCourseAnimation);
  } else {
    btn.innerHTML = '<i class="fas fa-play"></i>';
    courseAnimElapsedAtPause = parseFloat(document.getElementById('course-progress-fill').style.width||'0')/100*COURSE_ANIM_DURATION;
    if (courseAnimFrameId) cancelAnimationFrame(courseAnimFrameId);
  }
}
function seekToProgress(pct) {
  if (courseAnimFrameId) cancelAnimationFrame(courseAnimFrameId);
  courseAnimElapsedAtPause = pct * COURSE_ANIM_DURATION; courseAnimStartTime = null;
  updateCourseFrame(pct);
  if (courseAnimRunning) courseAnimFrameId = requestAnimationFrame(runCourseAnimation);
}
function initProgressBarDrag() {
  const wrap = document.getElementById('course-progress-wrap');
  const nw = wrap.cloneNode(true); wrap.parentNode.replaceChild(nw, wrap);
  function getPct(e) {
    const rect = nw.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    return Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
  }
  nw.addEventListener('mousedown', e => {
    e.preventDefault(); nw.classList.add('dragging');
    const was = courseAnimRunning; courseAnimRunning = false;
    if (courseAnimFrameId) cancelAnimationFrame(courseAnimFrameId);
    const mv = e => seekToProgress(getPct(e));
    const up = () => {
      nw.classList.remove('dragging');
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      courseAnimRunning = was;
      if (was) { courseAnimStartTime = null; courseAnimFrameId = requestAnimationFrame(runCourseAnimation); }
    };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    seekToProgress(getPct(e));
  });
  nw.addEventListener('touchstart', e => {
    e.preventDefault(); nw.classList.add('dragging');
    const was = courseAnimRunning; courseAnimRunning = false;
    if (courseAnimFrameId) cancelAnimationFrame(courseAnimFrameId);
    const mv = e => seekToProgress(getPct(e));
    const en = () => {
      nw.classList.remove('dragging');
      document.removeEventListener('touchmove', mv); document.removeEventListener('touchend', en);
      courseAnimRunning = was;
      if (was) { courseAnimStartTime = null; courseAnimFrameId = requestAnimationFrame(runCourseAnimation); }
    };
    document.addEventListener('touchmove', mv, { passive: false });
    document.addEventListener('touchend', en);
    seekToProgress(getPct(e));
  }, { passive: false });
}
function buildElevationChart(route, dists, elevs) {
  document.getElementById('elevation-chart-container').style.display = 'block';
  let elData;
  if (elevs && elevs.length === route.length) {
    elData = elevs;
  } else {
    elData = []; let e = 40 + Math.random()*30;
    for (let i = 0; i < route.length; i++) {
      e += (Math.random()-0.48)*3.5; e = Math.max(5, Math.min(300, e));
      elData.push(Math.round(e*10)/10);
    }
  }
  courseElevationData = elData;
  const labels = dists.map(d => d.toFixed(2));
  const minEl = Math.min(...elData), maxEl = Math.max(...elData);
  const yPad = Math.max(maxEl - minEl, 5) * 0.3;
  if (courseElevationChart) courseElevationChart.destroy();
  const ctx = document.getElementById('elevation-chart').getContext('2d');
  courseElevationChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Elevation (m)', data: elData, fill: true,
        backgroundColor: 'rgba(40,167,69,0.12)', borderColor: '#28a745',
        borderWidth: 2, pointRadius: 0, tension: 0.4 },
      { label: 'Current', data: elData.map((v,i) => i===0?v:null),
        fill: false, borderColor: 'transparent',
        pointRadius: elData.map((v,i) => i===0?7:0),
        pointBackgroundColor: '#ffc107', pointBorderColor: 'white',
        pointBorderWidth: 2.5, tension: 0 }
    ]},
    options: {
      responsive: true, animation: false,
      plugins: { legend: { display: false },
        tooltip: { mode: 'index', intersect: false,
          callbacks: { title: items => items[0].label+' km', label: item => item.datasetIndex===0?item.raw.toFixed(1)+' m':null },
          filter: item => item.datasetIndex === 0 }},
      scales: {
        x: { ticks: { maxTicksLimit: 5, callback: (v,i) => labels[i]+' km' }, grid: { display: false } },
        y: { min: Math.floor(minEl-yPad), max: Math.ceil(maxEl+yPad),
             ticks: { callback: v => v+'m', maxTicksLimit: 5 }, grid: { color: 'rgba(0,0,0,0.05)' } }
      },
      onClick: e => {
        const ca = courseElevationChart.chartArea;
        const rect = document.getElementById('elevation-chart').getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.native.clientX - rect.left - ca.left) / (ca.right - ca.left)));
        seekToProgress(pct);
      }
    }
  });
}
function updateElevationCursor(progress) {
  if (!courseElevationChart || !courseElevationData.length) return;
  const n = courseElevationData.length;
  const idx = Math.min(Math.round(progress*(n-1)), n-1);
  courseElevationChart.data.datasets[1].data = courseElevationData.map((v,i) => i===idx?v:null);
  courseElevationChart.data.datasets[1].pointRadius = courseElevationData.map((v,i) => i===idx?7:0);
  courseElevationChart.update('none');
}
</script>
</body>
</html>`;
}

// ============================================================
// MAIN
// ============================================================
function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function cleanupOldStructure() {
  try {
    if (fs.existsSync(OUTPUT_DIR))
      for (const item of fs.readdirSync(OUTPUT_DIR)) {
        const p = path.join(OUTPUT_DIR, item);
        if (fs.statSync(p).isFile() && item.endsWith('.html')) fs.unlinkSync(p);
      }
  } catch (e) { console.warn('Cleanup warning:', e.message); }
}

function cleanupRemovedEvents(validSlugs) {
  for (const folder of fs.readdirSync(OUTPUT_DIR)) {
    const folderPath = path.join(OUTPUT_DIR, folder);
    if (fs.statSync(folderPath).isDirectory()) {
      for (const file of fs.readdirSync(folderPath)) {
        if (file.endsWith('.html')) {
          const slug = path.basename(file, '.html');
          if (!validSlugs.has(slug)) { fs.unlinkSync(path.join(folderPath, file)); console.log('Deleted:', folder+'/'+file); }
        }
      }
    }
  }
}

async function main() {
  try {
    console.log('Fetching events JSON...');
    const data = await fetchJson(EVENTS_URL);
    let events;
    if (Array.isArray(data)) events = data;
    else if (Array.isArray(data.features)) events = data.features;
    else if (data.events && Array.isArray(data.events.features)) events = data.events.features;
    else throw new Error('Unexpected JSON structure');

    console.log('Fetching course maps...');
    let courseMaps = {};
    try {
      courseMaps = await fetchJson(COURSE_MAPS_URL);
      const keys = Object.keys(courseMaps);
      console.log(`Loaded ${keys.length} course map entries.`);
      if (keys.length > 0) console.log(`Sample key: "${keys[0]}" — value keys: ${Object.keys(courseMaps[keys[0]]).join(', ')}`);
    } catch (e) { console.warn('Could not load course maps:', e.message); }

    let folderMapping = {};
    try { folderMapping = JSON.parse(fs.readFileSync(path.join(__dirname, '../folder-mapping.json'), 'utf-8')); }
    catch (e) { console.warn('No folder mapping, using dynamic.'); }

    const allEventsInfoComplete = events.map(ev => ({
      slug: slugify(ev.properties.eventname),
      lat: ev.geometry.coordinates[1] || 0,
      lon: ev.geometry.coordinates[0] || 0,
      longName: ev.properties.EventLongName || ev.properties.eventname,
      country: ev.properties.countrycode
    }));

    const selectedEvents = events.slice(0, MAX_EVENTS);
    selectedEvents.sort((a, b) =>
      (a.properties.eventname || '').toLowerCase().localeCompare((b.properties.eventname || '').toLowerCase())
    );

    const limitedEvents = EVENT_LIMIT > 0 ? selectedEvents.slice(0, EVENT_LIMIT) : selectedEvents;
    if (EVENT_LIMIT > 0) console.log(`Limit set — generating up to ${EVENT_LIMIT} HTML pages.`);
    console.log(`Processing ${limitedEvents.length} events...`);

    const folderCounts = {};
    ensureDirectoryExists(OUTPUT_DIR);
    cleanupOldStructure();
    cleanupRemovedEvents(new Set(limitedEvents.map(e => slugify(e.properties.eventname))));

    const slugToSubfolder = {};
    for (const event of limitedEvents) {
      const slug = slugify(event.properties.eventname);
      let sub = folderMapping[slug] || getSubfolder(slug);
      if (!folderCounts[sub]) folderCounts[sub] = 0;
      if (folderCounts[sub] >= MAX_FILES_PER_FOLDER) {
        let sfx = 2;
        while (true) {
          const c = `${sub}${sfx}`; if (!folderCounts[c]) folderCounts[c] = 0;
          if (folderCounts[c] < MAX_FILES_PER_FOLDER) { sub = c; break; } sfx++;
        }
      }
      folderCounts[sub]++; slugToSubfolder[slug] = sub;
    }

    const completeS2S = {};
    for (const ev of events) {
      const slug = slugify(ev.properties.eventname);
      completeS2S[slug] = folderMapping[slug] || getSubfolder(slug);
    }

    // ============================================================
    // SITEMAP JSON
    // ============================================================
    const sitemapEntries = [];

    let found = 0, missing = 0;
    for (const event of limitedEvents) {
      const slug = slugify(event.properties.eventname);
      const sub  = slugToSubfolder[slug];
      ensureDirectoryExists(path.join(OUTPUT_DIR, sub));
      const name = event.properties.eventname || '';
      const courseKey = Object.keys(courseMaps).find(k =>
        k === name || k === name.toLowerCase() || k === slug ||
        k.replace(/-/g,'').toLowerCase() === name.replace(/\s+/g,'').toLowerCase()
      );
      if (courseKey) found++; else missing++;
      const html = await generateHtml(event, `${sub}/${slug}`, allEventsInfoComplete, completeS2S, courseMaps);
      fs.writeFileSync(path.join(OUTPUT_DIR, sub, `${slug}.html`), html, 'utf-8');
      console.log(`Generated: ${sub}/${slug}.html`);

      sitemapEntries.push({
        name: event.properties.EventLongName || event.properties.eventname,
        locationPath: buildLocationPath(event),
      });
    }

    const sitemapPath = path.join(__dirname, '../event-sitemap.json');
    fs.writeFileSync(sitemapPath, JSON.stringify(sitemapEntries, null, 2), 'utf-8');
    console.log(`\nSitemap written: ${sitemapPath} (${sitemapEntries.length} entries)`);

    console.log('\nFolder distribution:');
    Object.entries(folderCounts).forEach(([f,c]) => console.log(`  ${f}: ${c}`));
    console.log(`\nDone! ${limitedEvents.length} pages. Course: ${found} matched, ${missing} missing.`);

  } catch (err) { console.error('Error:', err); }
}

main();
