/**
 * generate-locations.js
 *
 * Generates a three-tier set of static HTML pages:
 *   /locations/                                    — world index (all countries)
 *   /locations/[country-slug]/                     — country page (all regions)
 *   /locations/[country-slug]/[region-slug]/       — region page (cities + all event cards)
 *   /locations/[country-slug]/[region-slug]/[city-slug]/  — city page (event cards)
 *
 * All URLs use trailing slashes (index.html files in folders) — no .html in URLs.
 *
 * Region and city resolved via Nominatim (OpenStreetMap) reverse geocoding.
 * Results cached in ./geo-cache.json — repeat runs skip the API entirely.
 * Nominatim policy: max 1 req/s, descriptive User-Agent — both enforced.
 *
 * Header, footer, fonts, colours all match the main generate-events.js exactly.
 * Event cards use the same course preview mini-map (Leaflet + encrypted coords).
 * Pages with 8+ events get a client-side search filter.
 * Every region/city page has a Stay22 "book accommodation" CTA.
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const EVENTS_URL      = 'https://www.parkrunnertourist.com/events1.json';
const COURSE_MAPS_URL = process.env.COURSE_MAPS_URL;
if (!COURSE_MAPS_URL) throw new Error('COURSE_MAPS_URL secret not set');

const BASE_EXPLORE_URL   = 'https://www.parkrunnertourist.com/explore';
const BASE_LOCATIONS_URL = 'https://www.parkrunnertourist.com/locations';
const SITE_NAME          = 'parkrunner tourist';
const OUTPUT_DIR         = path.join(__dirname, '../locations');
const GEO_CACHE_FILE     = path.join(__dirname, '../locations/geo-cache.json');
const EVENT_LIMIT        = parseInt(process.env.EVENT_LIMIT || '0', 10);
const SEARCH_THRESHOLD   = 8;

// Exact colours from generate-events.js
const ACCENT    = '#4caf50';
const DARK      = '#2e7d32';
const ACCENT_JR = '#40e0d0';
const DARK_JR   = '#008080';

// ---------------------------------------------------------------------------
// Country flag helper — converts ISO 3166-1 alpha-2 code to emoji flag
// Regional indicator letters: A = U+1F1E6 ... Z = U+1F1FF
// ---------------------------------------------------------------------------
function isoToFlag(iso2) {
  if (!iso2 || iso2.length !== 2) return '';
  return Array.from(iso2.toUpperCase())
    .map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65))
    .join('');
}

// ---------------------------------------------------------------------------
// Country code → display name + parkrun domain + ISO 3166-1 alpha-2
// ---------------------------------------------------------------------------
const COUNTRY_META = {
  '0':  { name: 'Unknown',        url: null,                 iso2: ''   },
  '3':  { name: 'Australia',      url: 'www.parkrun.com.au', iso2: 'AU' },
  '4':  { name: 'Austria',        url: 'www.parkrun.co.at',  iso2: 'AT' },
  '14': { name: 'Canada',         url: 'www.parkrun.ca',     iso2: 'CA' },
  '23': { name: 'Denmark',        url: 'www.parkrun.dk',     iso2: 'DK' },
  '30': { name: 'Finland',        url: 'www.parkrun.fi',     iso2: 'FI' },
  '32': { name: 'Germany',        url: 'www.parkrun.com.de', iso2: 'DE' },
  '42': { name: 'Ireland',        url: 'www.parkrun.ie',     iso2: 'IE' },
  '44': { name: 'Italy',          url: 'www.parkrun.it',     iso2: 'IT' },
  '46': { name: 'Japan',          url: 'www.parkrun.jp',     iso2: 'JP' },
  '54': { name: 'Lithuania',      url: 'www.parkrun.lt',     iso2: 'LT' },
  '57': { name: 'Malaysia',       url: 'www.parkrun.my',     iso2: 'MY' },
  '64': { name: 'Netherlands',    url: 'www.parkrun.co.nl',  iso2: 'NL' },
  '65': { name: 'New Zealand',    url: 'www.parkrun.co.nz',  iso2: 'NZ' },
  '67': { name: 'Norway',         url: 'www.parkrun.no',     iso2: 'NO' },
  '74': { name: 'Poland',         url: 'www.parkrun.pl',     iso2: 'PL' },
  '82': { name: 'Singapore',      url: 'www.parkrun.sg',     iso2: 'SG' },
  '85': { name: 'South Africa',   url: 'www.parkrun.co.za',  iso2: 'ZA' },
  '88': { name: 'Sweden',         url: 'www.parkrun.se',     iso2: 'SE' },
  '97': { name: 'United Kingdom', url: 'www.parkrun.org.uk', iso2: 'GB' },
  '98': { name: 'United States',  url: 'www.parkrun.us',     iso2: 'US' },
};

// ---------------------------------------------------------------------------
// Address field priority per country code.
// These map to the normalised fields produced by reverseGeocode() above.
// ---------------------------------------------------------------------------
const ADDRESS_FIELDS = {
  // UK — county (admin level 6) as region, city/town as city
  '97': { regionFields: ['county', 'state_district', 'state'],       cityFields: ['city', 'town', 'village', 'suburb'] },
  // Australia — state as region, suburb/city as city
  '3':  { regionFields: ['state'],                                    cityFields: ['city', 'suburb', 'town', 'village'] },
  // USA — state as region
  '98': { regionFields: ['state'],                                    cityFields: ['city', 'town', 'village', 'county'] },
  // Canada
  '14': { regionFields: ['state', 'province'],                        cityFields: ['city', 'town', 'village'] },
  // Germany
  '32': { regionFields: ['state'],                                    cityFields: ['city', 'town', 'village', 'suburb'] },
  // Ireland
  '42': { regionFields: ['county', 'state'],                          cityFields: ['city', 'town', 'village', 'suburb'] },
  // New Zealand
  '65': { regionFields: ['state', 'region'],                          cityFields: ['city', 'town', 'suburb', 'village'] },
  // South Africa
  '85': { regionFields: ['state', 'province'],                        cityFields: ['city', 'town', 'suburb', 'village'] },
  // Poland
  '74': { regionFields: ['state'],                                    cityFields: ['city', 'town', 'village'] },
  // Sweden
  '88': { regionFields: ['county', 'state'],                          cityFields: ['city', 'town', 'village', 'suburb'] },
  // Denmark
  '23': { regionFields: ['state', 'county', 'region'],                cityFields: ['city', 'town', 'village'] },
  // Finland
  '30': { regionFields: ['state', 'region'],                          cityFields: ['city', 'town', 'village'] },
  // Norway
  '67': { regionFields: ['state', 'county'],                          cityFields: ['city', 'town', 'village'] },
  // Netherlands
  '64': { regionFields: ['state', 'province'],                        cityFields: ['city', 'town', 'village', 'suburb'] },
  // Italy
  '44': { regionFields: ['state', 'county'],                          cityFields: ['city', 'town', 'village', 'suburb'] },
  // Austria
  '4':  { regionFields: ['state'],                                    cityFields: ['city', 'town', 'village', 'suburb'] },
  // Japan
  '46': { regionFields: ['state', 'province', 'county'],              cityFields: ['city', 'town', 'village', 'suburb'] },
  // Lithuania
  '54': { regionFields: ['state', 'county'],                          cityFields: ['city', 'town', 'village'] },
  // Malaysia
  '57': { regionFields: ['state'],                                    cityFields: ['city', 'town', 'suburb', 'village'] },
  // Singapore — city-state
  '82': { regionFields: ['country'],                                  cityFields: ['suburb', 'city', 'town'] },
};
const DEFAULT_ADDRESS_FIELDS = {
  regionFields: ['state', 'county', 'state_district', 'region', 'province'],
  cityFields:   ['city', 'town', 'village', 'suburb', 'municipality'],
};

function getAddressFields(countryCode) {
  return ADDRESS_FIELDS[String(countryCode)] || DEFAULT_ADDRESS_FIELDS;
}

// ---------------------------------------------------------------------------
// Generic HTTP JSON fetch (used for events JSON, course maps, and geocoding)
// ---------------------------------------------------------------------------
function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json', ...headers } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Reverse geocoding — BigDataCloud (free, no API key, allows fast parallel use)
// Returns a normalised address object with the same field names we use downstream.
// Docs: https://www.bigdatacloud.com/free-api/free-reverse-geocode-to-city-api
// ---------------------------------------------------------------------------
async function reverseGeocode(lat, lon) {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
  try {
    const data = await fetchJson(url);
    if (!data || !data.countryCode) return null;

    // Normalise into the same shape our address field logic expects
    return {
      city:                  data.city || data.locality || null,
      town:                  data.locality || null,
      village:               data.localityInfo && data.localityInfo.administrative
                               ? (data.localityInfo.administrative.find(a => a.adminLevel === 8) || {}).name || null
                               : null,
      suburb:                data.locality || null,
      county:                data.localityInfo && data.localityInfo.administrative
                               ? (data.localityInfo.administrative.find(a => a.adminLevel === 6) || {}).name || null
                               : null,
      state_district:        data.localityInfo && data.localityInfo.administrative
                               ? (data.localityInfo.administrative.find(a => a.adminLevel === 5) || {}).name || null
                               : null,
      state:                 data.principalSubdivision || null,
      province:              data.principalSubdivision || null,
      region:                data.principalSubdivision || null,
      country:               data.countryName || null,
      country_code:          data.countryCode || null,
      // City/locality centre coordinates returned by BDC — much more accurate
      // than averaging the lat/lon of individual parkrun events in that city.
      _city_lat:             typeof data.latitude  === 'number' ? data.latitude  : null,
      _city_lon:             typeof data.longitude === 'number' ? data.longitude : null,
      // Extra BDC fields for richer UK county resolution
      _bdc_admin1:           data.principalSubdivision || null,
      _bdc_admin2:           data.localityInfo && data.localityInfo.administrative
                               ? (data.localityInfo.administrative.find(a => a.adminLevel === 6) || {}).name || null
                               : null,
    };
  } catch (e) {
    console.warn(`  Geocode error (${lat},${lon}): ${e.message}`);
    return null;
  }
}

// UK metropolitan borough → canonical city name.
// Nominatim at zoom=14 often returns "Salford", "Trafford", "Stockport" etc.
// as the city for events that are clearly in the Greater Manchester area.
// We snap these to the well-known city name visitors would search for.
const UK_METRO_SNAP = {
  // Greater Manchester
  'salford': 'Manchester', 'trafford': 'Manchester', 'stockport': 'Manchester',
  'tameside': 'Manchester', 'oldham': 'Manchester', 'rochdale': 'Manchester',
  'bury': 'Manchester', 'bolton': 'Manchester', 'wigan': 'Manchester',
  'leigh': 'Manchester',
  // West Yorkshire / Leeds
  'morley': 'Leeds', 'pudsey': 'Leeds', 'otley': 'Leeds', 'horsforth': 'Leeds',
  'guiseley': 'Leeds', 'garforth': 'Leeds', 'rothwell': 'Leeds',
  // West Midlands / Birmingham
  'solihull': 'Birmingham', 'smethwick': 'Birmingham', 'dudley': 'Birmingham',
  'wolverhampton': 'Birmingham', 'walsall': 'Birmingham', 'west bromwich': 'Birmingham',
  'sutton coldfield': 'Birmingham',
  // Greater London — keep boroughs as-is (they are useful), only snap truly ambiguous ones
  'city of london': 'London',
  // Merseyside / Liverpool
  'birkenhead': 'Liverpool', 'wallasey': 'Liverpool', 'knowsley': 'Liverpool',
  'st helens': 'Liverpool', 'halton': 'Liverpool',
  // South Yorkshire / Sheffield
  'rotherham': 'Sheffield', 'barnsley': 'Sheffield',
  // Tyne and Wear
  'gateshead': 'Newcastle', 'sunderland': 'Newcastle', 'north shields': 'Newcastle',
  'south shields': 'Newcastle', 'wallsend': 'Newcastle',
  // Bristol area
  'south gloucestershire': 'Bristol', 'bath': 'Bath',
};

function snapCity(city, countryCode) {
  if (!city) return city;
  if (String(countryCode) !== '97') return city;
  const lower = city.toLowerCase();
  return UK_METRO_SNAP[lower] || city;
}

function extractFromAddress(address, countryCode) {
  if (!address) return { city: null, region: null, cityLat: null, cityLon: null };
  const { regionFields, cityFields } = getAddressFields(countryCode);
  const region = regionFields.reduce((f, k) => f || address[k] || null, null);
  let city     = cityFields.reduce((f, k) => f || address[k] || null, null);
  city = snapCity(city, countryCode);
  return {
    city:    city    || null,
    region:  region  || null,
    cityLat: address._city_lat || null,
    cityLon: address._city_lon || null,
  };
}

// ---------------------------------------------------------------------------
// Geo cache — keyed by lat/lon rounded to 4 decimal places (~11 m grid)
// ---------------------------------------------------------------------------
function cacheKey(lat, lon) {
  return `${Math.round(lat * 1e4) / 1e4},${Math.round(lon * 1e4) / 1e4}`;
}

function loadCache() {
  try {
    if (fs.existsSync(GEO_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf-8'));
      // Auto-repair: remove legacy empty-object entries and CACHE_FAILED markers
      // so they get freshly resolved on this run.
      let purged = 0;
      for (const k of Object.keys(raw)) {
        const v = raw[k];
        if (!v || v === '__failed__' || (typeof v === 'object' && Object.keys(v).length === 0)) {
          delete raw[k];
          purged++;
        }
      }
      if (purged > 0) {
        console.log(`Geo cache: purged ${purged} stale entries (will be re-resolved).`);
        saveCache(raw);
      }
      return raw;
    }
  } catch (e) { console.warn('Could not load geo cache, starting fresh:', e.message); }
  return {};
}

function saveCache(cache) {
  try { fs.writeFileSync(GEO_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8'); }
  catch (e) { console.warn('Could not save geo cache:', e.message); }
}

// Failed lookups are stored as the string '__failed__' so they are retried
// on the next run (unlike {} which is truthy and would prevent retries).
const CACHE_FAILED = '__failed__';

function cacheHit(cache, k) {
  if (!Object.prototype.hasOwnProperty.call(cache, k)) return false;
  const v = cache[k];
  // Treat empty objects {} (legacy failure marker) and CACHE_FAILED string as misses
  if (!v || v === CACHE_FAILED) return false;
  if (typeof v === 'object' && Object.keys(v).length === 0) return false;
  return true;
}

function cacheAddress(cache, k) {
  const v = cache[k];
  if (!v || v === CACHE_FAILED) return null;
  if (typeof v === 'object' && Object.keys(v).length === 0) return null;
  return v;
}

async function geocodeAllEvents(events, cache) {
  const seen = new Set();
  const missing = [];
  for (const ev of events) {
    if (ev.lat === 0 && ev.lon === 0) continue;
    const k = cacheKey(ev.lat, ev.lon);
    if (cacheHit(cache, k) && !seen.has(k)) continue;
    if (!seen.has(k)) { seen.add(k); missing.push({ lat: ev.lat, lon: ev.lon, k }); }
  }
  if (!missing.length) { console.log('Geo cache: all coordinates resolved, skipping geocoding.'); return; }

  // BigDataCloud allows fast concurrent use — 10 in parallel, 100ms between batches.
  // 408 coordinates = ~5 seconds instead of ~7 minutes with Nominatim.
  const BATCH_SIZE  = 10;
  const BATCH_DELAY = 100;

  const secs = Math.ceil((missing.length / BATCH_SIZE) * BATCH_DELAY / 1000);
  console.log(`Geo cache: ${missing.length} coordinates to resolve (~${secs}s in batches of ${BATCH_SIZE})...`);

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async ({ lat, lon, k }) => {
      const result = await reverseGeocode(lat, lon);
      cache[k] = result || CACHE_FAILED;
    }));

    const done = Math.min(i + BATCH_SIZE, missing.length);
    if (done % 100 === 0 || done === missing.length) {
      console.log(`  Geocoded ${done}/${missing.length}...`);
      saveCache(cache);
    }

    if (i + BATCH_SIZE < missing.length) await sleep(BATCH_DELAY);
  }

  saveCache(cache);
  console.log('Geo cache: saved.');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function slugify(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function ensure(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function centroid(events) {
  if (!events.length) return { lat: 51.5, lon: -0.1 };
  return {
    lat: events.reduce((s, e) => s + e.lat, 0) / events.length,
    lon: events.reduce((s, e) => s + e.lon, 0) / events.length,
  };
}

function getExploreSubfolder(slug) {
  const c = slug.charAt(0).toLowerCase();
  return (c >= 'a' && c <= 'z') ? c.toUpperCase() : '0-9';
}

// ---------------------------------------------------------------------------
// Coordinate encryption — identical to generate-events.js
// ---------------------------------------------------------------------------
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

// Inlined decrypt function — same as in generate-events.js
function decryptFnJs() {
  return `function _d(b,s){const f=JSON.parse(atob(b));const r=[];let v=s>>>0;for(let i=0;i<f.length;i+=2){v=(Math.imul(v,1664525)+1013904223)>>>0;const lng=(f[i]^(v&0xFFFFFF))/1e6;v=(Math.imul(v,1664525)+1013904223)>>>0;const lat=(f[i+1]^(v&0xFFFFFF))/1e6;r.push([lng,lat]);}return r;}`;
}

// ---------------------------------------------------------------------------
// Shared page structure — identical to generate-events.js
// ---------------------------------------------------------------------------

// Exact <head> block matching the original site
function htmlHead({ title, description, canonicalUrl, lat, lon, locationName, breadcrumbItems = [] }) {
  const plainTitle = title.replace(/&amp;/g, '&');
  const plainDesc  = description.replace(/&amp;/g, '&');

  // BreadcrumbList schema — always include site root + any passed items
  const allCrumbs = [
    { name: 'parkrunner tourist', url: 'https://www.parkrunnertourist.com' },
    { name: 'Locations',          url: `${BASE_LOCATIONS_URL}/` },
    ...breadcrumbItems,
  ];
  const breadcrumbSchema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: allCrumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: c.url,
    })),
  });

  // WebPage schema
  const webPageSchema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: plainTitle,
    description: plainDesc,
    url: canonicalUrl,
    ...(lat != null ? { spatialCoverage: { '@type': 'Place', name: locationName, geo: { '@type': 'GeoCoordinates', latitude: lat, longitude: lon } } } : {}),
    publisher: { '@type': 'Organization', name: 'parkrunner tourist', url: 'https://www.parkrunnertourist.com' },
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta name="description" content="${description}" />
<meta name="author" content="Jake Lofthouse" />
${lat != null ? `<meta name="geo.placename" content="${locationName}" />
<meta name="geo.position" content="${lat};${lon}" />` : ''}
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
<meta property="og:url" content="${canonicalUrl}" />
<meta property="og:image" content="https://www.parkrunnertourist.com/Images/Feature.jpg">
<meta property="og:type" content="website" />
<meta property="og:site_name" content="parkrunner tourist" />
<meta name="twitter:image" content="https://www.parkrunnertourist.com/Images/Feature.jpg" />
<meta name="twitter:title" content="${title}" />
<meta name="twitter:description" content="${description}" />
<meta name="robots" content="index, follow" />
<link rel="icon" type="image/x-icon" href="https://parkrunnertourist.com/favicon.ico">
<meta name="language" content="en" />
<meta name="apple-itunes-app" content="app-id=6743163993, app-argument=https://www.parkrunnertourist.com">
<link rel="canonical" href="${canonicalUrl}" />
<link rel="sitemap" type="application/xml" href="${BASE_LOCATIONS_URL}/sitemap.xml" />
<script type="application/ld+json">${breadcrumbSchema}</script>
<script type="application/ld+json">${webPageSchema}</script>
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
</head>`;
}


// Exact header from generate-events.js (non-junior variant — location pages are always non-junior)
function htmlHeader() {
  return `<header>
  <a href="https://www.parkrunnertourist.com" target="_self">${SITE_NAME}</a>
  <a href="https://www.parkrunnertourist.com/webapp" target="_blank" class="header-map-btn">Show Full Map</a>
</header>`;
}

// Exact footer from generate-events.js
function htmlFooter() {
  return `<div class="download-footer">
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
  &copy; ${new Date().getFullYear()} ${SITE_NAME}
</footer>
<script data-name="BMC-Widget" data-cfasync="false" src="https://cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js"
  data-id="jlofthouse" data-description="Support me on Buy me a coffee!"
  data-message="" data-color="#40DCA5" data-position="Right"
  data-x_margin="18" data-y_margin="18"></script>
<script>
// Count-up animation for .stat-strip-value elements.
// Triggers when the stat strip scrolls into view. Each digit ticks up
// independently like an old terminal display, starting slightly offset
// from each other for a typewriter feel.
(function() {
  var strip = document.querySelector('.stat-strip');
  if (!strip) return;

  var items = strip.querySelectorAll('.stat-strip-value');
  if (!items.length) return;

  // Store raw numeric targets (strip commas/non-digits)
  var targets = Array.prototype.map.call(items, function(el) {
    return parseInt(el.textContent.replace(/[^0-9]/g, ''), 10) || 0;
  });
  // Hide the real values; we'll animate to them
  Array.prototype.forEach.call(items, function(el) { el.textContent = '0'; });

  function animateItem(el, target, delay) {
    setTimeout(function() {
      var duration = Math.min(1200, Math.max(400, target * 0.8));
      var start = null;
      function tick(ts) {
        if (!start) start = ts;
        var progress = Math.min((ts - start) / duration, 1);
        // Ease out: decelerate toward the end
        var eased = 1 - Math.pow(1 - progress, 3);
        var current = Math.round(eased * target);
        el.textContent = current.toLocaleString();
        if (progress < 1) requestAnimationFrame(tick);
        else el.textContent = target.toLocaleString();
      }
      requestAnimationFrame(tick);
    }, delay);
  }

  function runAnimation() {
    targets.forEach(function(target, i) {
      animateItem(items[i], target, i * 120);
    });
  }

  if ('IntersectionObserver' in window) {
    var obs = new IntersectionObserver(function(entries) {
      if (entries[0].isIntersecting) { runAnimation(); obs.disconnect(); }
    }, { threshold: 0.3 });
    obs.observe(strip);
  } else {
    runAnimation();
  }
})();
</script>`;
}

// Exact CSS from generate-events.js (non-junior palette) — extended with warmer location styles
function sharedStyles() {
  return `<style>
* { box-sizing: border-box; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  margin: 0; padding: 0;
  background: #f6f8f3;
  line-height: 1.6;
  color: #1a2318;
}
header {
  background: linear-gradient(135deg, #2e7d32 0%, #1b5e20 100%);
  color: white; padding: 1.5rem 2rem; font-weight: 600; font-size: 1.75rem;
  display: flex; justify-content: space-between; align-items: center;
  box-shadow: 0 4px 20px rgba(46,125,50,0.3);
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
.header-map-btn:hover { background: white; color: #2e7d32; transform: translateY(-2px); }
/* breadcrumb */
.breadcrumb {
  font-size: 0.825rem; color: #64748b; padding: 0.65rem 2rem;
  background: white; border-bottom: 1px solid #e5eae0;
  display: flex; gap: 0.35rem; align-items: center; flex-wrap: wrap;
}
.breadcrumb a { color: #4caf50; text-decoration: none; font-weight: 500; }
.breadcrumb a:hover { text-decoration: underline; }
.breadcrumb-sep { opacity: 0.35; }
/* page hero */
main { padding: 2.5rem 2rem 5rem; max-width: 1300px; margin: 0 auto; }
.hero { padding: 2rem 0 1.5rem; border-bottom: 1px solid #dde5d8; margin-bottom: 2rem; }
.hero-eyebrow { font-size: 0.7rem; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: #4caf50; margin-bottom: 0.35rem; }
.hero-title { font-size: clamp(1.75rem, 4vw, 2.75rem); font-weight: 800; color: #1a2318; line-height: 1.15; margin: 0 0 0.5rem; }
.hero-sub { font-size: 0.975rem; color: #5a6e52; max-width: 600px; line-height: 1.6; margin: 0; }
/* stat strip */
.stat-strip {
  display: flex; margin-bottom: 2rem;
  background: white; border: 1px solid #dde5d8; border-radius: 0.875rem; overflow: hidden;
}
.stat-strip-item {
  flex: 1; padding: 1rem 1.25rem; display: flex; flex-direction: column;
  border-right: 1px solid #dde5d8;
}
.stat-strip-item:last-child { border-right: none; }
.stat-strip-value {
  font-size: 1.5rem; font-weight: 800; color: #2e7d32; line-height: 1;
  font-variant-numeric: tabular-nums;
}
.stat-strip-label { font-size: 0.72rem; color: #7a8f72; margin-top: 0.2rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
/* section headings */
.section-heading {
  font-size: 1rem; font-weight: 700; color: #1a2318;
  margin: 2rem 0 0.875rem; display: flex; align-items: center; gap: 0.5rem;
}
.section-heading::after { content: ''; flex: 1; height: 1px; background: #dde5d8; }
/* country grid */
.country-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(195px, 1fr)); gap: 0.75rem; }
.country-card {
  background: white; border: 1px solid #dde5d8; border-radius: 0.75rem;
  padding: 0.85rem 0.95rem; text-decoration: none; color: inherit;
  display: flex; align-items: center; gap: 0.65rem;
  transition: box-shadow 0.18s, transform 0.18s, border-color 0.18s;
}
.country-card:hover { box-shadow: 0 3px 14px rgba(46,125,50,0.12); transform: translateY(-2px); border-color: #b2d8b4; }
.country-card-flag { font-size: 1.65rem; line-height: 1; flex-shrink: 0; }
.country-card-body { flex: 1; min-width: 0; }
.country-card h3 { font-weight: 700; font-size: 0.875rem; color: #1a2318; margin: 0 0 0.1rem; }
.country-card p { font-size: 0.73rem; color: #7a8f72; margin: 0; }
.country-card-arrow { color: #c8d8c0; font-size: 0.7rem; flex-shrink: 0; }
/* tiles */
.tile-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 0.625rem; margin-bottom: 2rem; }
.tile {
  background: white; border: 1px solid #dde5d8; border-radius: 0.625rem;
  padding: 0.8rem 0.95rem; display: flex; align-items: center; justify-content: space-between;
  text-decoration: none; color: inherit;
  transition: box-shadow 0.18s, transform 0.18s, border-color 0.18s;
}
.tile:hover { box-shadow: 0 3px 12px rgba(46,125,50,0.1); transform: translateY(-2px); border-color: #b2d8b4; }
.tile-name { font-weight: 600; font-size: 0.875rem; color: #1a2318; }
.tile-count { background: #eef6ee; color: #2e7d32; font-size: 0.68rem; font-weight: 700; padding: 0.15rem 0.5rem; border-radius: 99px; flex-shrink: 0; margin-left: 0.4rem; }
/* search */
.search-wrap { position: relative; margin-bottom: 1.25rem; }
.search-icon { position: absolute; left: 0.8rem; top: 50%; transform: translateY(-50%); color: #94a3b8; font-size: 0.85rem; pointer-events: none; }
.search-input {
  width: 100%; padding: 0.65rem 1rem 0.65rem 2.4rem;
  border: 1.5px solid #dde5d8; border-radius: 0.625rem;
  font-family: 'Inter', sans-serif; font-size: 0.925rem; background: white; outline: none; color: #1a2318;
  transition: border 0.18s;
}
.search-input:focus { border-color: #4caf50; }
.search-input::placeholder { color: #aab8a2; }
/* filter bar (junior / 5k toggle) */
.filter-bar {
  display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1.25rem; flex-wrap: wrap;
}
.filter-label { font-size: 0.8rem; font-weight: 600; color: #7a8f72; margin-right: 0.25rem; }
.event-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(285px, 1fr)); gap: 1.1rem; }
.event-card {
  background: white; border-radius: 0.875rem; overflow: hidden;
  border: 1px solid #dde5d8;
  display: flex; flex-direction: column;
  transition: box-shadow 0.2s, transform 0.2s, border-color 0.2s;
}
.event-card:hover { box-shadow: 0 5px 20px rgba(46,125,50,0.13); transform: translateY(-3px); border-color: #b2d8b4; }
.card-map-wrap { height: 180px; position: relative; background: #e8f0e5; flex-shrink: 0; overflow: hidden; }
.card-map-inner { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
.card-map-badges { position: absolute; bottom: 7px; left: 7px; z-index: 10; display: flex; gap: 4px; }
.card-map-badge { border-radius: 6px; padding: 2px 7px; font-size: 10px; font-weight: 700; color: #fff; }
.card-map-badge.start { background: #28a745; }
.card-map-badge.finish { background: #dc3545; }
.card-body { padding: 0.875rem 1rem; flex: 1; display: flex; flex-direction: column; gap: 0.3rem; }
.card-name { font-weight: 700; font-size: 0.95rem; color: #1a2318; line-height: 1.3; }
.card-location { font-size: 0.775rem; color: #7a8f72; display: flex; align-items: center; gap: 0.3rem; }
.card-badges { display: flex; gap: 0.35rem; flex-wrap: wrap; margin-top: auto; padding-top: 0.35rem; }
.card-badge { font-size: 0.66rem; font-weight: 600; padding: 0.15rem 0.5rem; border-radius: 99px; }
.card-badge.junior { background: #e0f7fa; color: #006064; }
.card-cta {
  display: block; margin: 0.5rem 0.875rem 0.875rem;
  padding: 0.55rem 1rem; text-align: center;
  background: linear-gradient(135deg, #4caf50, #2e7d32);
  color: white; border-radius: 0.5rem; font-weight: 600; font-size: 0.825rem;
  text-decoration: none; transition: opacity 0.18s, transform 0.18s;
}
.card-cta:hover { opacity: 0.87; transform: translateY(-1px); }
/* hotel CTA */
.hotel-cta {
  background: linear-gradient(135deg, #2e7d32 0%, #1b5e20 100%);
  border-radius: 0.875rem; padding: 1.4rem 1.6rem;
  display: flex; align-items: center; justify-content: space-between;
  gap: 1.25rem; margin-bottom: 2rem; flex-wrap: wrap;
}
.hotel-cta-text h2 { font-size: 1.15rem; font-weight: 700; color: white; margin: 0 0 0.2rem; }
.hotel-cta-text p { font-size: 0.85rem; color: rgba(255,255,255,0.73); margin: 0; }
.hotel-cta-btn {
  background: white; color: #2e7d32; font-weight: 700; font-size: 0.875rem;
  padding: 0.6rem 1.4rem; border-radius: 0.5rem; white-space: nowrap;
  border: none; cursor: pointer; transition: transform 0.18s, box-shadow 0.18s; flex-shrink: 0;
  font-family: 'Inter', sans-serif;
}
.hotel-cta-btn:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.14); }
/* toggle buttons */
.toggle-btn {
  padding: 0.45rem 1.1rem; border-radius: 0.5rem; margin-right: 0.5rem; margin-bottom: 0.25rem;
  cursor: pointer; font-weight: 600; border: 2px solid #4caf50;
  transition: all 0.2s; background-color: white; color: #4caf50;
  font-family: 'Inter', sans-serif; font-size: 0.875rem;
}
.toggle-btn:hover:not(.active):not(.filter-btn-disabled) { background-color: #f0faf0; }
.toggle-btn.active { background: linear-gradient(135deg, #4caf50, #2e7d32); color: white; }
.toggle-btn.filter-btn-disabled {
  opacity: 0.38; cursor: not-allowed; border-color: #c8d8c0; color: #aab8a2;
}
/* download footer */
.download-footer {
  background: linear-gradient(135deg, #4caf50 0%, #2e7d32 100%);
  padding: 3rem 2rem; display: flex; flex-direction: column; align-items: center; gap: 1.5rem;
  color: white; font-weight: 700; font-size: 1.3rem; text-transform: uppercase; letter-spacing: 1px;
}
.app-badges { display: flex; gap: 2rem; }
.download-footer img { height: 70px; width: auto; transition: transform 0.3s ease; cursor: pointer; border-radius: 0.5rem; }
.download-footer img:hover { transform: scale(1.1) translateY(-4px); }
footer { text-align: center; padding: 2rem; background: #f6f8f3; color: #64748b; font-weight: 500; }
.leaflet-control-attribution { display: none !important; }
@media (max-width: 768px) {
  main { padding: 1.5rem 1rem 4rem; }
  .hero-title { font-size: 1.7rem; }
  header { padding: 1rem; font-size: 1.3rem; }
  .hotel-cta { flex-direction: column; }
  .hotel-cta-btn { width: 100%; text-align: center; }
  .app-badges { flex-direction: column; gap: 1rem; align-items: center; }
  .stat-strip { flex-wrap: wrap; }
  .stat-strip-item { border-right: none; border-bottom: 1px solid #dde5d8; flex: 1 1 45%; }
  .stat-strip-item:last-child { border-bottom: none; }
}
</style>`;
}

function breadcrumb(crumbs) {
  // crumbs: [{label, href?}] — last item is current page (no href)
  const home = `<a href="${BASE_LOCATIONS_URL}/">All Locations</a><span class="breadcrumb-sep">/</span>`;
  const parts = crumbs.map((c, i) =>
    i < crumbs.length - 1
      ? `<a href="${c.href}">${c.label}</a><span class="breadcrumb-sep">/</span>`
      : `<span>${c.label}</span>`
  ).join('');
  return `<div class="breadcrumb">${home}${parts}</div>`;
}

// ---------------------------------------------------------------------------
// Stay22 modal — List View / Map View toggles matching generate-events.js
// ---------------------------------------------------------------------------
function stay22Modal() {
  return `<div id="stay22-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;
  z-index:9999;background:rgba(0,0,0,0.65);backdrop-filter:blur(8px);
  align-items:center;justify-content:center;">
  <div style="background:#fff;border-radius:20px;max-width:900px;width:96%;max-height:92vh;
    overflow:hidden;box-shadow:0 32px 80px rgba(0,0,0,0.4);display:flex;flex-direction:column;">
    <div style="padding:13px 16px 11px;border-bottom:1px solid rgba(0,0,0,0.08);
      display:flex;align-items:center;justify-content:space-between;flex-shrink:0;background:#fff;">
      <div style="font-size:15px;font-weight:700;color:rgba(0,0,0,0.87)" id="stay22-modal-title">Find Hotels</div>
      <button onclick="closeStay22()" style="background:rgba(0,0,0,0.07);border:none;border-radius:50%;
        width:30px;height:30px;cursor:pointer;font-size:14px;display:flex;align-items:center;
        justify-content:center;color:rgba(0,0,0,0.5);">&times;</button>
    </div>
    <div style="padding:10px 16px 6px;border-bottom:1px solid rgba(0,0,0,0.06);flex-shrink:0;background:#fff;">
      <button class="toggle-btn active" id="btn-listview" onclick="switchStay22View('listview')">List View</button>
      <button class="toggle-btn" id="btn-map" onclick="switchStay22View('map')">Map View</button>
    </div>
    <iframe id="stay22-iframe" style="flex:1;border:none;min-height:500px;"
      title="Find hotels near parkrun events" src=""></iframe>
  </div>
</div>
<script>
var _s22Base = '';
function openStay22(lat, lon, name) {
  var d = new Date(), day = d.getDay(), diff = (5 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  var checkin = d.toISOString().slice(0, 10);
  _s22Base = 'https://www.stay22.com/embed/gm?aid=parkrunnertourist'
    + '&lat=' + lat + '&lng=' + lon + '&maincolor=4caf50'
    + '&venue=' + encodeURIComponent(name) + '&checkin=' + checkin;
  document.getElementById('stay22-modal-title').textContent = 'Hotels near ' + name;
  document.getElementById('btn-listview').classList.add('active');
  document.getElementById('btn-map').classList.remove('active');
  document.getElementById('stay22-iframe').src = _s22Base + '&viewmode=listview&listviewexpand=true';
  var m = document.getElementById('stay22-modal');
  m.style.display = 'flex';
}
function switchStay22View(mode) {
  document.getElementById('btn-listview').classList.toggle('active', mode === 'listview');
  document.getElementById('btn-map').classList.toggle('active', mode === 'map');
  document.getElementById('stay22-iframe').src = _s22Base + '&viewmode=' + mode
    + (mode === 'listview' ? '&listviewexpand=true' : '');
}
function closeStay22() {
  document.getElementById('stay22-modal').style.display = 'none';
  document.getElementById('stay22-iframe').src = '';
  _s22Base = '';
}
document.getElementById('stay22-modal').addEventListener('click', function(e) {
  if (e.target === this) closeStay22();
});
</script>`;
}

// ---------------------------------------------------------------------------
// Search script
// ---------------------------------------------------------------------------
function searchScript(inputId, itemClass) {
  return `<script>
(function() {
  var inp = document.getElementById('${inputId}');
  if (!inp) return;
  inp.addEventListener('input', function() {
    var q = this.value.toLowerCase().trim();
    document.querySelectorAll('.${itemClass}').forEach(function(el) {
      el.style.display = (!q || (el.dataset.search || el.textContent).toLowerCase().includes(q)) ? '' : 'none';
    });
  });
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Event type filter — shown on all region/city pages that have event cards.
//
// State priority: URL param (?filter=5k|junior|all) > localStorage > default (5k).
// URL param is written when the user clicks a filter button, and appended to
// every city/region tile link so the preference carries through navigation.
// localStorage key is global ('prt-event-filter') so it follows the user
// across all location pages.
// ---------------------------------------------------------------------------
function filterScript(hasJunior, hasStandard, cityTileLinks) {
  // Always render the filter when there are any events
  const totalEvents = (hasJunior ? 1 : 0) + (hasStandard ? 1 : 0);
  if (totalEvents === 0) return '';

  // Build the city tile link injection — appends ?filter=VAL to each tile href
  // so clicking through carries the current filter to the next page.
  const tileSelector = cityTileLinks ? `'.tile'` : 'null';

  return `<div class="filter-bar" id="event-filter-bar">
  <span class="filter-label">Show:</span>
  <button class="toggle-btn${hasStandard ? '' : ' filter-btn-disabled'}" id="filter-5k"
    onclick="${hasStandard ? "setFilter('5k')" : ''}" title="${hasStandard ? '' : 'No 5k events here'}">5k Events</button>
  <button class="toggle-btn${hasJunior ? '' : ' filter-btn-disabled'}" id="filter-junior"
    onclick="${hasJunior ? "setFilter('junior')" : ''}" title="${hasJunior ? '' : 'No Junior events here'}">Junior Events</button>
  <button class="toggle-btn" id="filter-all" onclick="setFilter('all')">All Events</button>
</div>
<script>
(function() {
  var GLOBAL_KEY = 'prt-event-filter';
  var HAS_JUNIOR   = ${hasJunior};
  var HAS_STANDARD = ${hasStandard};

  // Read filter from URL param first, then localStorage, then default to 5k
  function getInitialFilter() {
    try {
      var params = new URLSearchParams(window.location.search);
      var fromUrl = params.get('filter');
      if (fromUrl && ['5k','junior','all'].indexOf(fromUrl) !== -1) {
        // Validate: if the page doesn't have that type, fall back
        if (fromUrl === '5k' && !HAS_STANDARD) fromUrl = HAS_JUNIOR ? 'junior' : 'all';
        if (fromUrl === 'junior' && !HAS_JUNIOR) fromUrl = HAS_STANDARD ? '5k' : 'all';
        localStorage.setItem(GLOBAL_KEY, fromUrl);
        return fromUrl;
      }
    } catch(e) {}
    try {
      var saved = localStorage.getItem(GLOBAL_KEY) || '5k';
      // Validate saved value against what this page has
      if (saved === '5k' && !HAS_STANDARD) saved = HAS_JUNIOR ? 'junior' : 'all';
      if (saved === 'junior' && !HAS_JUNIOR) saved = HAS_STANDARD ? '5k' : 'all';
      return saved;
    } catch(e) { return '5k'; }
  }

  function applyFilter(val) {
    try { localStorage.setItem(GLOBAL_KEY, val); } catch(e) {}

    // Update URL param without adding history entries
    try {
      var url = new URL(window.location.href);
      url.searchParams.set('filter', val);
      history.replaceState(null, '', url.toString());
    } catch(e) {}

    // Update button states
    var btn5k     = document.getElementById('filter-5k');
    var btnJunior = document.getElementById('filter-junior');
    var btnAll    = document.getElementById('filter-all');
    if (btn5k)     btn5k.classList.toggle('active', val === '5k');
    if (btnJunior) btnJunior.classList.toggle('active', val === 'junior');
    if (btnAll)    btnAll.classList.toggle('active', val === 'all');

    // Show/hide event cards
    document.querySelectorAll('.event-card').forEach(function(card) {
      var isJunior = card.dataset.junior === 'true';
      var show = val === 'all'
        || (val === '5k' && !isJunior)
        || (val === 'junior' && isJunior);
      card.style.display = show ? '' : 'none';
    });

    // Append ?filter=VAL to all tile (city/region) links on this page
    // so clicking through carries the preference forward
    document.querySelectorAll('.tile').forEach(function(tile) {
      try {
        var href = tile.getAttribute('href');
        if (!href) return;
        var u = new URL(href, window.location.href);
        u.searchParams.set('filter', val);
        tile.setAttribute('href', u.toString());
      } catch(e) {}
    });
  }

  window.setFilter = applyFilter;

  // Wait for DOM to be ready so event cards exist before we filter them
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { applyFilter(getInitialFilter()); });
  } else {
    applyFilter(getInitialFilter());
  }
})();
</script>`;
}
// ---------------------------------------------------------------------------
// Event card with course preview mini-map
// ---------------------------------------------------------------------------
function eventCardHtml(ev) {
  const { slug, longName, lat, lon, city, isJunior } = ev;
  const subfolder  = getExploreSubfolder(slug);
  const eventUrl   = `${BASE_EXPLORE_URL}/${subfolder}/${slug}`;
  const seed       = eventSeed(ev.eventName);
  const hasRoute   = ev.route && ev.route.length > 1;
  const encRoute   = hasRoute ? encryptCoords(ev.route, seed) : null;
  const mapId      = `cmap-${slug.replace(/[^a-z0-9]/g, '')}`;
  const accent     = isJunior ? ACCENT_JR : ACCENT;
  const cityLabel  = city ? `<span class="card-location"><i class="fas fa-map-marker-alt"></i> ${city}</span>` : '';
  const typeBadge  = isJunior ? `<span class="card-badge junior">Junior parkrun</span>` : '';

  // Build the Leaflet init script — same pattern as initCoursePreview in generate-events.js
  const mapScript = `
(function() {
  ${decryptFnJs()}
  var el = document.getElementById('${mapId}');
  if (!el) return;
  var map = L.map('${mapId}', {
    zoomControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false,
    tap: false, touchZoom: false, attributionControl: false
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 18 }).addTo(map);
  ${hasRoute ? `
  var route = _d("${encRoute}", ${seed});
  var lls = route.map(function(p) { return [p[1], p[0]]; });
  L.polyline(lls, { color: '${accent}', weight: 3.5, opacity: 0.9, lineJoin: 'round', lineCap: 'round' }).addTo(map);
  L.circleMarker(lls[0], { radius: 7, fillColor: '${accent}', color: '#fff', weight: 2, fillOpacity: 1 }).addTo(map);
  L.circleMarker(lls[lls.length - 1], { radius: 7, fillColor: '#dc3545', color: '#fff', weight: 2, fillOpacity: 1 }).addTo(map);
  map.fitBounds(L.latLngBounds(lls), { padding: [20, 20], animate: false });
  ` : `
  map.setView([${lat}, ${lon}], 14);
  L.circleMarker([${lat}, ${lon}], { radius: 8, fillColor: '${accent}', color: '#fff', weight: 2.5, fillOpacity: 1 }).addTo(map);
  `}
})();`;

  return `<div class="event-card" data-search="${longName.toLowerCase()} ${(city || '').toLowerCase()}" data-junior="${isJunior ? 'true' : 'false'}">
  <div class="card-map-wrap">
    <div id="${mapId}" class="card-map-inner"></div>
    ${hasRoute ? `<div class="card-map-badges">
      <span class="card-map-badge start">&#9679; Start</span>
      <span class="card-map-badge finish">&#9679; Finish</span>
    </div>` : ''}
  </div>
  <div class="card-body">
    <div class="card-name">${longName}</div>
    ${cityLabel}
    <div class="card-badges">${typeBadge}</div>
  </div>
  <a href="${eventUrl}" class="card-cta" target="_blank">View Guide &amp; Hotels</a>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>${mapScript}</script>`;
}

// ---------------------------------------------------------------------------
// Page generators
// ---------------------------------------------------------------------------

function generateWorldIndex(countries) {
  const sorted = Object.entries(countries).sort((a, b) => b[1].totalEvents - a[1].totalEvents);
  const totalEvents    = sorted.reduce((s, [, d]) => s + d.totalEvents, 0);
  const totalCountries = sorted.length;
  const totalCities    = sorted.reduce((s, [, d]) => s + d.cities.length, 0);

  const cards = sorted.map(([cSlug, d]) => {
    const flag = isoToFlag(d.iso2 || '');
    return `
<a href="${BASE_LOCATIONS_URL}/${cSlug}/" class="country-card">
  <div class="country-card-flag">${flag}</div>
  <div class="country-card-body">
    <h3>${d.name}</h3>
    <p>${d.totalEvents.toLocaleString()} event${d.totalEvents !== 1 ? 's' : ''} &middot; ${d.cities.length} town${d.cities.length !== 1 ? 's' : ''} &amp; cities</p>
  </div>
  <i class="fas fa-chevron-right country-card-arrow"></i>
</a>`;
  }).join('');

  return `${htmlHead({
    title: 'Find parkrun Events Near You — Hotels, Course Maps &amp; Visitor Guides | parkrunner tourist',
    description: 'Planning a parkrun holiday or visiting somewhere new? Find parkrun events near your destination by country and city. Compare hotels, view course maps and plan your perfect parkrun trip.',
    canonicalUrl: `${BASE_LOCATIONS_URL}/`,
    breadcrumbItems: [],
  })}
<body>
${sharedStyles()}
${htmlHeader()}
<main>
  <div class="hero">
    <div class="hero-eyebrow">parkrunner tourist</div>
    <h1 class="hero-title">Find parkruns Near Your Destination</h1>
    <p class="hero-sub">Going on holiday or visiting somewhere new? Browse parkrun events by country and town — then find hotels nearby, check the course map and plan your parkrun trip.</p>
  </div>
  <div class="stat-strip">
    <div class="stat-strip-item"><span class="stat-strip-value">${totalEvents.toLocaleString()}</span><span class="stat-strip-label">Events worldwide</span></div>
    <div class="stat-strip-item"><span class="stat-strip-value">${totalCountries}</span><span class="stat-strip-label">Countries</span></div>
    <div class="stat-strip-item"><span class="stat-strip-value">${totalCities}</span><span class="stat-strip-label">Towns &amp; cities</span></div>
  </div>
  <div class="section-heading">Select a country</div>
  <div class="country-grid">${cards}</div>
</main>
${htmlFooter()}
</body></html>`;
}

function generateCountryPage(countrySlug, countryData) {
  const { name, cities, totalEvents, iso2 } = countryData;
  const allEvents    = cities.flatMap(c => c.events);
  const c            = centroid(allEvents);
  const showSearch   = cities.length >= SEARCH_THRESHOLD;
  const flag         = isoToFlag(iso2 || '');
  const juniorCount  = allEvents.filter(e => e.isJunior).length;
  const standardCount = totalEvents - juniorCount;

  const tiles = cities
    .sort((a, b) => b.events.length - a.events.length)
    .map(city => `
<a href="${BASE_LOCATIONS_URL}/${countrySlug}/${city.slug}/" class="tile" data-search="${city.name.toLowerCase()}">
  <span class="tile-name">${city.name}</span>
  <span class="tile-count">${city.events.length}</span>
</a>`).join('');

  return `${htmlHead({
    title: `Find parkruns in ${name} — Hotels, Course Maps &amp; Visitor Guides`,
    description: `Looking for parkrun events in ${name}? Browse every town and city, view course maps, find hotels near each event and plan your parkrun trip to ${name}.`,
    canonicalUrl: `${BASE_LOCATIONS_URL}/${countrySlug}/`,
    lat: c.lat, lon: c.lon, locationName: name,
    breadcrumbItems: [{ name, url: `${BASE_LOCATIONS_URL}/${countrySlug}/` }],
  })}
<body>
${sharedStyles()}
${htmlHeader()}
${breadcrumb([{ label: name }])}
<main>
  <div class="hero">
    <div class="hero-eyebrow">${flag} ${name}</div>
    <h1 class="hero-title">Find parkruns in ${name}</h1>
    <p class="hero-sub">${totalEvents} parkrun event${totalEvents !== 1 ? 's' : ''} across ${cities.length} town${cities.length !== 1 ? 's' : ''} &amp; cit${cities.length !== 1 ? 'ies' : 'y'} — pick a location to see course maps and nearby hotels</p>
  </div>
  <div class="stat-strip">
    <div class="stat-strip-item"><span class="stat-strip-value">${standardCount.toLocaleString()}</span><span class="stat-strip-label">5k events</span></div>
    ${juniorCount > 0 ? `<div class="stat-strip-item"><span class="stat-strip-value">${juniorCount}</span><span class="stat-strip-label">Junior events</span></div>` : ''}
    <div class="stat-strip-item"><span class="stat-strip-value">${cities.length}</span><span class="stat-strip-label">Towns &amp; cities</span></div>
  </div>
  ${showSearch ? `<div class="search-wrap"><i class="fas fa-search search-icon"></i><input id="loc-search" class="search-input" type="text" placeholder="Search towns &amp; cities in ${name}..." /></div>` : ''}
  <div class="section-heading">Towns &amp; Cities</div>
  <div class="tile-grid">${tiles}</div>
</main>
${htmlFooter()}
${stay22Modal()}
${showSearch ? searchScript('loc-search', 'tile') : ''}
<script>
(function() {
  try {
    var params = new URLSearchParams(window.location.search);
    var f = params.get('filter') || localStorage.getItem('prt-event-filter') || '5k';
    document.querySelectorAll('.tile').forEach(function(tile) {
      try {
        var href = tile.getAttribute('href');
        if (!href) return;
        var u = new URL(href, window.location.href);
        u.searchParams.set('filter', f);
        tile.setAttribute('href', u.toString());
      } catch(e) {}
    });
  } catch(e) {}
})();
</script>
</body></html>`;
}

// City page — shows all events in a town/city directly (no region middle tier)
// URL: /locations/[country-slug]/[city-slug]/
function generateCityPage(countrySlug, countryName, citySlug, cityData) {
  const { name: cityName, events, centreLat, centreLon } = cityData;
  const eventCentroid = centroid(events);
  // Prefer the geocoded city centre; fall back to event centroid if not available
  const geoLat = centreLat !== null ? centreLat : eventCentroid.lat;
  const geoLon = centreLon !== null ? centreLon : eventCentroid.lon;
  const showSearch    = events.length >= SEARCH_THRESHOLD;
  const juniorCount   = events.filter(e => e.isJunior).length;
  const standardCount = events.length - juniorCount;

  const cards = events
    .sort((a, b) => a.longName.localeCompare(b.longName))
    .map(ev => eventCardHtml(ev)).join('\n');

  return `${htmlHead({
    title: `Find parkruns in ${cityName} — Hotels Near Each Event &amp; Course Maps`,
    description: `Planning a visit to ${cityName}? Find ${events.length} parkrun event${events.length !== 1 ? 's' : ''} in ${cityName}, ${countryName} — view course maps, compare hotels nearby and plan your perfect parkrun trip.`,
    canonicalUrl: `${BASE_LOCATIONS_URL}/${countrySlug}/${citySlug}/`,
    lat: geoLat, lon: geoLon, locationName: `${cityName}, ${countryName}`,
    breadcrumbItems: [
      { name: countryName, url: `${BASE_LOCATIONS_URL}/${countrySlug}/` },
      { name: cityName,    url: `${BASE_LOCATIONS_URL}/${countrySlug}/${citySlug}/` },
    ],
  })}
<body>
${sharedStyles()}
${htmlHeader()}
${breadcrumb([
    { label: countryName, href: `${BASE_LOCATIONS_URL}/${countrySlug}/` },
    { label: cityName },
  ])}
<main>
  <div class="hero">
    <div class="hero-eyebrow">${countryName}</div>
    <h1 class="hero-title">Find parkruns in ${cityName}</h1>
    <p class="hero-sub">${events.length} parkrun event${events.length !== 1 ? 's' : ''} in ${cityName} — view course maps and find hotels nearby</p>
  </div>
  <div class="stat-strip">
    <div class="stat-strip-item"><span class="stat-strip-value">${standardCount.toLocaleString()}</span><span class="stat-strip-label">5k events</span></div>
    ${juniorCount > 0 ? `<div class="stat-strip-item"><span class="stat-strip-value">${juniorCount}</span><span class="stat-strip-label">Junior events</span></div>` : ''}
  </div>
  <div class="hotel-cta">
    <div class="hotel-cta-text">
      <h2>Staying in ${cityName}?</h2>
      <p>Find hotels and rentals near your parkrun event.</p>
    </div>
    <button class="hotel-cta-btn" onclick="openStay22(${geoLat},${geoLon},'${cityName.replace(/'/g, "\\'")} parkrun')">Find Hotels</button>
  </div>
  ${showSearch ? `<div class="search-wrap"><i class="fas fa-search search-icon"></i><input id="evt-search" class="search-input" type="text" placeholder="Search events in ${cityName}..." /></div>` : ''}
  ${filterScript(juniorCount > 0, standardCount > 0, true)}
  <div class="section-heading">Events in ${cityName}</div>
  <div class="event-grid">${cards}</div>
</main>
${htmlFooter()}
${stay22Modal()}
${showSearch ? searchScript('evt-search', 'event-card') : ''}
</body></html>`;
}

// ---------------------------------------------------------------------------
// Sitemap generator
// Writes /locations/sitemap.xml listing every location page.
// Priority: world index 1.0, country 0.9, region 0.8, city 0.7
// changefreq: weekly (event count can change as new events open)
// ---------------------------------------------------------------------------
function generateSitemap(hierarchy) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [];

  urls.push({ loc: `${BASE_LOCATIONS_URL}/`, priority: '0.9' });

  for (const [countrySlug, countryData] of Object.entries(hierarchy)) {
    urls.push({ loc: `${BASE_LOCATIONS_URL}/${countrySlug}/`, priority: '0.8' });
    for (const [citySlug] of Object.entries(countryData.cities)) {
      urls.push({ loc: `${BASE_LOCATIONS_URL}/${countrySlug}/${citySlug}/`, priority: '0.8' });
    }
  }

  const entries = urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
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

  const limited = EVENT_LIMIT > 0 ? events.slice(0, EVENT_LIMIT) : events;
  console.log(`Processing ${limited.length} events...`);

  // Build minimal list for geocoding pass
  const rawEvents = limited.map(ev => {
    const props  = ev.properties || {};
    const coords = (ev.geometry && ev.geometry.coordinates) || [0, 0];
    return {
      eventName:   props.eventname || '',
      longName:    props.EventLongName || props.eventname || '',
      slug:        slugify(props.eventname || ''),
      countryCode: String(props.countrycode || '0'),
      lat:         coords[1] || 0,
      lon:         coords[0] || 0,
    };
  });

  // Resolve coordinates via Nominatim (cache-first)
  const cache = loadCache();
  await geocodeAllEvents(rawEvents, cache);

  // Enrich with geocoded admin data + course routes
  const enriched = rawEvents.map(ev => {
    const address = cacheAddress(cache, cacheKey(ev.lat, ev.lon));
    const { city, region, cityLat, cityLon } = extractFromAddress(address, ev.countryCode);
    const isJunior = ev.longName.toLowerCase().includes('junior');

    const courseKey = Object.keys(courseMaps).find(k =>
      k === ev.eventName ||
      k === ev.eventName.toLowerCase() ||
      k === ev.slug ||
      k.replace(/-/g, '').toLowerCase() === ev.eventName.replace(/\s+/g, '').toLowerCase()
    );
    const courseData = courseKey ? courseMaps[courseKey] : null;
    const route = (courseData && Array.isArray(courseData.route) && courseData.route.length > 1)
      ? courseData.route : null;

    return { ...ev, isJunior, city, region, cityLat, cityLon, route };
  });

  // Build 2-tier hierarchy: country → town/city
  // URL structure: /locations/[country-slug]/[city-slug]/
  const hierarchy = {};
  for (const ev of enriched) {
    const meta        = COUNTRY_META[ev.countryCode] || { name: 'Unknown', iso2: '' };
    const countrySlug = slugify(meta.name);
    const cityName    = ev.city || meta.name;
    const citySlug    = slugify(cityName);

    if (!hierarchy[countrySlug]) {
      hierarchy[countrySlug] = { name: meta.name, iso2: meta.iso2 || '', cities: {}, totalEvents: 0 };
    }
    hierarchy[countrySlug].totalEvents++;

    const cities = hierarchy[countrySlug].cities;
    if (!cities[citySlug]) {
      cities[citySlug] = {
        name: cityName, slug: citySlug, events: [],
        // City centre from BDC geocoding — more accurate than averaging event lat/lons
        centreLat: ev.cityLat || null,
        centreLon: ev.cityLon || null,
      };
    }
    cities[citySlug].events.push(ev);
  }

  // Write all HTML files
  ensure(OUTPUT_DIR);

  const countryList = Object.fromEntries(
    Object.entries(hierarchy).map(([cs, cd]) => [cs, {
      name: cd.name, iso2: cd.iso2, totalEvents: cd.totalEvents,
      cities: Object.values(cd.cities),
    }])
  );

  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), generateWorldIndex(countryList), 'utf-8');
  console.log('Generated: locations/index.html');
  let pageCount = 1;

  for (const [countrySlug, countryData] of Object.entries(hierarchy)) {
    const countryDir = path.join(OUTPUT_DIR, countrySlug);
    ensure(countryDir);

    fs.writeFileSync(
      path.join(countryDir, 'index.html'),
      generateCountryPage(countrySlug, { ...countryData, cities: Object.values(countryData.cities) }),
      'utf-8'
    );
    console.log(`Generated: locations/${countrySlug}/`);
    pageCount++;

    for (const [citySlug, cityData] of Object.entries(countryData.cities)) {
      if (!cityData.events.length) continue;
      const cityDir = path.join(countryDir, citySlug);
      ensure(cityDir);
      fs.writeFileSync(
        path.join(cityDir, 'index.html'),
        generateCityPage(countrySlug, countryData.name, citySlug, cityData),
        'utf-8'
      );
      console.log(`Generated: locations/${countrySlug}/${citySlug}/`);
      pageCount++;
    }
  }

  console.log(`\nDone. ${pageCount} location pages generated in ./locations/`);

  // Write sitemap
  fs.writeFileSync(path.join(OUTPUT_DIR, 'sitemap.xml'), generateSitemap(hierarchy), 'utf-8');
  console.log(`Sitemap: locations/sitemap.xml (${pageCount} URLs)`);
}

main().catch(err => { console.error(err); process.exit(1); });
