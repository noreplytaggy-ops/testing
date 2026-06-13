const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { createCanvas, loadImage } = require('canvas');
const sharp = require('sharp');

// ============================================================
// CONFIG
// ============================================================
const EVENTS_URL           = 'https://www.parkrunnertourist.com/events1.json';
const COURSE_MAPS_URL      = process.env.COURSE_MAPS_URL;
const OUTPUT_DIR           = path.join(__dirname, '../explore/images');
const IMAGE_WIDTH          = 1200;
const IMAGE_HEIGHT         = 630;
const TILE_SIZE            = 256;
const MAX_EVENTS           = 9999999;
const MAX_FILES_PER_FOLDER = 999;
const IMAGE_LIMIT          = parseInt(process.env.IMAGE_LIMIT || '0', 10);
const CONCURRENCY          = 12; // no browser overhead — pure CPU/IO
const TILE_ZOOM            = 14;
const TILE_CACHE_DIR       = path.join(__dirname, '../.tile-cache');

if (!COURSE_MAPS_URL) throw new Error('COURSE_MAPS_URL secret not set');

// ============================================================
// HELPERS
// ============================================================
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function slugify(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function getSubfolder(slug) {
  const c = slug.charAt(0).toLowerCase();
  return (c >= 'a' && c <= 'z') ? c.toUpperCase() : '0-9';
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// ============================================================
// TILE MATHS (Web Mercator / Slippy Map)
// ============================================================
function lngLatToTile(lng, lat, zoom) {
  const x = Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom));
  return { x, y };
}

function lngLatToPixel(lng, lat, zoom, originTileX, originTileY) {
  const scale = Math.pow(2, zoom);
  const worldX = (lng + 180) / 360 * scale * TILE_SIZE;
  const latRad = lat * Math.PI / 180;
  const worldY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * scale * TILE_SIZE;
  return {
    x: worldX - originTileX * TILE_SIZE,
    y: worldY - originTileY * TILE_SIZE
  };
}

// ============================================================
// TILE FETCHING WITH DISK CACHE
// ============================================================
const tileInflight = new Map(); // deduplicate concurrent fetches of same tile

function fetchTile(x, y, z) {
  const key = `${z}-${x}-${y}`;
  if (tileInflight.has(key)) return tileInflight.get(key);

  const cacheFile = path.join(TILE_CACHE_DIR, `${key}.png`);
  if (fs.existsSync(cacheFile)) {
    return Promise.resolve(fs.readFileSync(cacheFile));
  }

  const subdomain = ['a', 'b', 'c', 'd'][Math.abs(x + y) % 4];
  const url = `https://${subdomain}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`;

  const promise = new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'parkrunnertourist-imagegen/1.0' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        try { ensureDir(TILE_CACHE_DIR); fs.writeFileSync(cacheFile, buf); } catch (_) {}
        resolve(buf);
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error(`Tile timeout: ${key}`)); });
  }).finally(() => tileInflight.delete(key));

  tileInflight.set(key, promise);
  return promise;
}

// ============================================================
// BEST ZOOM LEVEL
// ============================================================
function chooseBestZoom(route, start, finish) {
  const pts = [...route];
  if (start)  pts.push(start);
  if (finish) pts.push(finish);
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lng, lat] of pts) {
    if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
  }

  for (let z = 16; z >= 10; z--) {
    const tl = lngLatToTile(minLng, maxLat, z);
    const br = lngLatToTile(maxLng, minLat, z);
    const tilesW = (br.x - tl.x + 1) * TILE_SIZE;
    const tilesH = (br.y - tl.y + 1) * TILE_SIZE;
    if (tilesW <= IMAGE_WIDTH && tilesH <= IMAGE_HEIGHT) return { z, minLng, maxLng, minLat, maxLat };
  }
  return { z: 10, minLng, maxLng, minLat, maxLat };
}

// ============================================================
// SVG OVERLAY — title bar + badge (composited by sharp)
// ============================================================
function buildOverlaySvg(longName, isJunior, w, h) {
  const escaped   = longName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const darkColor = isJunior ? '#008080' : '#2e7d32';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs>
    <linearGradient id="grad" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="rgba(0,0,0,0.72)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${h - 200}" width="${w}" height="200" fill="url(#grad)"/>
  <text x="40" y="${h - 58}"
    font-family="Arial, sans-serif" font-size="52" font-weight="bold"
    fill="white">${escaped}</text>
  <text x="40" y="${h - 22}"
    font-family="Arial, sans-serif" font-size="22" font-weight="500"
    fill="rgba(255,255,255,0.82)">parkrunner tourist · Course Map</text>
  <rect x="${w - 210}" y="18" width="192" height="36" rx="18"
    fill="rgba(255,255,255,0.92)"/>
  <text x="${w - 114}" y="42"
    font-family="Arial, sans-serif" font-size="15" font-weight="bold"
    fill="${darkColor}" text-anchor="middle">parkrunner tourist</text>
</svg>`;
}

// ============================================================
// DRAW ONE IMAGE
// ============================================================
async function renderImage(event, courseMaps, slugToSubfolder) {
  const name     = event.properties.eventname || '';
  const longName = event.properties.EventLongName || name;
  const isJunior = longName.toLowerCase().includes('junior');
  const slug     = slugify(name);

  const sub     = slugToSubfolder[slug] || getSubfolder(slug);
  const outDir  = path.join(OUTPUT_DIR, sub);
  const outFile = path.join(outDir, `${slug}.jpg`);

  if (fs.existsSync(outFile)) return 'skipped';

  const courseKey = Object.keys(courseMaps).find(k =>
    k === name || k === name.toLowerCase() || k === slug ||
    k.replace(/-/g, '').toLowerCase() === name.replace(/\s+/g, '').toLowerCase()
  );
  const courseData = courseKey ? courseMaps[courseKey] : null;
  const hasRoute   = courseData && Array.isArray(courseData.route) && courseData.route.length > 1;
  if (!hasRoute) return 'skipped';

  const route  = courseData.route;
  const start  = Array.isArray(courseData.start)  && courseData.start.length  === 2 ? courseData.start  : null;
  const finish = Array.isArray(courseData.finish) && courseData.finish.length === 2 ? courseData.finish : null;

  const accentColor = isJunior ? '#40e0d0' : '#4caf50';

  // Choose zoom + bounds
  const { z: zoom, minLng, maxLng, minLat, maxLat } = chooseBestZoom(route, start, finish);

  const tlTile = lngLatToTile(minLng, maxLat, zoom);
  const brTile = lngLatToTile(maxLng, minLat, zoom);
  const tileX0 = tlTile.x - 2;
  const tileY0 = tlTile.y - 2;
  const tileX1 = brTile.x + 2;
  const tileY1 = brTile.y + 2;
  const tilesWide = tileX1 - tileX0 + 1;
  const tilesHigh = tileY1 - tileY0 + 1;
  const canvasW   = tilesWide * TILE_SIZE;
  const canvasH   = tilesHigh * TILE_SIZE;

  // Fetch tiles in parallel
  const tileJobs = [];
  for (let tx = tileX0; tx <= tileX1; tx++) {
    for (let ty = tileY0; ty <= tileY1; ty++) {
      tileJobs.push(
        fetchTile(tx, ty, zoom)
          .then(buf => ({ tx, ty, buf }))
          .catch(() => ({ tx, ty, buf: null }))
      );
    }
  }
  const tiles = await Promise.all(tileJobs);

  // Stitch tiles onto canvas
  const canvas = createCanvas(canvasW, canvasH);
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = '#f2f3f0';
  ctx.fillRect(0, 0, canvasW, canvasH);

  await Promise.all(tiles.map(async ({ tx, ty, buf }) => {
    if (!buf) return;
    try {
      const img = await loadImage(buf);
      ctx.drawImage(img, (tx - tileX0) * TILE_SIZE, (ty - tileY0) * TILE_SIZE);
    } catch (_) {}
  }));

  function toXY(lng, lat) {
    return lngLatToPixel(lng, lat, zoom, tileX0, tileY0);
  }

  // Route polyline
  ctx.beginPath();
  ctx.strokeStyle = accentColor;
  ctx.lineWidth   = 5;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  for (let i = 0; i < route.length; i++) {
    const { x, y } = toXY(route[i][0], route[i][1]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Marker helper
  function drawMarker(lng, lat, fillColor) {
    const { x, y } = toXY(lng, lat);
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 3;
    ctx.stroke();
  }

  // Label helper
  function drawLabel(lng, lat, text) {
    const { x, y } = toXY(lng, lat);
    ctx.font      = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    const tw = ctx.measureText(text).width;
    const bx = x - tw / 2 - 5, by = y - 38, bw = tw + 10, bh = 20, br = 5;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.moveTo(bx + br, by);
    ctx.lineTo(bx + bw - br, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + br);
    ctx.lineTo(bx + bw, by + bh - br);
    ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - br, by + bh);
    ctx.lineTo(bx + br, by + bh);
    ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - br);
    ctx.lineTo(bx, by + br);
    ctx.quadraticCurveTo(bx, by, bx + br, by);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#1f2937';
    ctx.fillText(text, x, by + 14);
  }

  const finishPt = finish || route[route.length - 1];
  const startPt  = start  || route[0];
  drawMarker(finishPt[0], finishPt[1], '#dc3545');
  drawMarker(startPt[0],  startPt[1],  '#28a745');
  drawLabel(startPt[0],   startPt[1],  'Start');
  drawLabel(finishPt[0],  finishPt[1], 'Finish');

  // Compute crop centred on route
  const routePixels = route.map(p => toXY(p[0], p[1]));
  let rMinX = Infinity, rMaxX = -Infinity, rMinY = Infinity, rMaxY = -Infinity;
  for (const { x, y } of routePixels) {
    if (x < rMinX) rMinX = x; if (x > rMaxX) rMaxX = x;
    if (y < rMinY) rMinY = y; if (y > rMaxY) rMaxY = y;
  }
  const PAD    = 90;
  const routeW = rMaxX - rMinX + PAD * 2;
  const routeH = rMaxY - rMinY + PAD * 2;
  const scale  = Math.min(IMAGE_WIDTH / routeW, IMAGE_HEIGHT / routeH, 1);
  const cropW  = Math.round(IMAGE_WIDTH  / scale);
  const cropH  = Math.round(IMAGE_HEIGHT / scale);
  const cropX  = Math.max(0, Math.min(Math.round(rMinX - PAD + (routeW - cropW) / 2), canvasW - cropW));
  const cropY  = Math.max(0, Math.min(Math.round(rMinY - PAD + (routeH - cropH) / 2), canvasH - cropH));

  const fullBuf = canvas.toBuffer('image/png');
  const overlay = Buffer.from(buildOverlaySvg(longName, isJunior, IMAGE_WIDTH, IMAGE_HEIGHT));

  ensureDir(outDir);
  await sharp(fullBuf)
    .extract({ left: cropX, top: cropY, width: Math.min(cropW, canvasW - cropX), height: Math.min(cropH, canvasH - cropY) })
    .resize(IMAGE_WIDTH, IMAGE_HEIGHT)
    .composite([{ input: overlay, gravity: 'center' }])
    .jpeg({ quality: 88 })
    .toFile(outFile);

  console.log(`Generated: ${sub}/${slug}.jpg`);
  return 'generated';
}

// ============================================================
// WORKER POOL
// ============================================================
async function runWithConcurrency(items, concurrency, fn) {
  let index = 0, generated = 0, skipped = 0, failed = 0;
  async function worker() {
    while (index < items.length) {
      const item = items[index++];
      try {
        const result = await fn(item);
        if (result === 'generated') generated++;
        else if (result === 'skipped') skipped++;
        else failed++;
      } catch (e) {
        failed++;
        console.warn(`Error on ${item.properties?.eventname}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { generated, skipped, failed };
}

// ============================================================
// MAIN
// ============================================================
async function main() {
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
    console.log(`Loaded ${Object.keys(courseMaps).length} course map entries.`);
  } catch (e) { console.warn('Could not load course maps:', e.message); }

  let folderMapping = {};
  try { folderMapping = JSON.parse(fs.readFileSync(path.join(__dirname, '../folder-mapping.json'), 'utf-8')); }
  catch (e) { console.warn('No folder mapping, using dynamic.'); }

  const selectedEvents = events.slice(0, MAX_EVENTS);
  selectedEvents.sort((a, b) =>
    (a.properties.eventname || '').toLowerCase().localeCompare((b.properties.eventname || '').toLowerCase())
  );

  const limitedEvents = IMAGE_LIMIT > 0 ? selectedEvents.slice(0, IMAGE_LIMIT) : selectedEvents;
  if (IMAGE_LIMIT > 0) console.log(`Limit set — generating up to ${IMAGE_LIMIT} images.`);
  console.log(`Processing ${limitedEvents.length} events...`);

  // Build slugToSubfolder with overflow logic
  const folderCounts = {};
  const slugToSubfolder = {};
  for (const event of selectedEvents) {
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

  ensureDir(OUTPUT_DIR);
  ensureDir(TILE_CACHE_DIR);

  const { generated, skipped, failed } = await runWithConcurrency(
    limitedEvents,
    CONCURRENCY,
    event => renderImage(event, courseMaps, slugToSubfolder)
  );

  console.log(`\nDone! ${generated} generated, ${skipped} skipped, ${failed} failed.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
