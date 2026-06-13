const fs = require('fs');
const https = require('https');
const path = require('path');

const EVENTS_URL = 'https://www.parkrunnertourist.com/events1.json';
const COURSE_MAPS_URL = process.env.COURSE_MAPS_URL;

if (!COURSE_MAPS_URL) {
  throw new Error("COURSE_MAPS_URL secret not set");
}

const OUTPUT_DIR = path.join(__dirname, '../explore');
const EVENT_LIMIT = parseInt(process.env.EVENT_LIMIT || '0', 10);

const COUNTRY_NAMES = {
  "0": "other", "3": "australia", "4": "austria", "14": "canada", "23": "denmark",
  "30": "finland", "32": "germany", "42": "ireland", "44": "italy", "46": "japan",
  "54": "lithuania", "57": "malaysia", "64": "netherlands", "65": "new-zealand",
  "67": "norway", "74": "poland", "82": "singapore", "85": "south-africa",
  "88": "sweden", "97": "united-kingdom", "98": "united-states"
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

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
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

    console.log('Processing location data...');
    ensureDirectoryExists(OUTPUT_DIR);

    // Create location structure and event mapping
    const locationStructure = {};
    const eventLocationMap = {};

    for (const event of events) {
      const countryCode = event.properties.countrycode || '0';
      const countryName = COUNTRY_NAMES[countryCode] || 'other';
      
      // Extract city
      let cityName = 'unknown';
      if (event.properties.EventRegion) {
        cityName = event.properties.EventRegion;
      } else if (event.properties.EventLocation) {
        cityName = event.properties.EventLocation;
      }
      
      const citySlug = slugify(cityName);
      const eventSlug = slugify(event.properties.eventname);
      const eventName = event.properties.eventname || '';
      const eventLongName = event.properties.EventLongName || eventName;

      // Build location structure
      if (!locationStructure[countryName]) {
        locationStructure[countryName] = {};
      }
      if (!locationStructure[countryName][citySlug]) {
        locationStructure[countryName][citySlug] = {
          cityName: cityName,
          events: []
        };
      }

      locationStructure[countryName][citySlug].events.push({
        slug: eventSlug,
        name: eventName,
        longName: eventLongName
      });

      // Create event mapping
      eventLocationMap[eventSlug] = {
        country: countryName,
        city: citySlug,
        cityName: cityName,
        eventName: eventName,
        coordinates: event.geometry.coordinates || [0, 0]
      };
    }

    // Create country and city index folders
    console.log('Creating location folders...');
    for (const [country, cities] of Object.entries(locationStructure)) {
      const countryDir = path.join(OUTPUT_DIR, country);
      ensureDirectoryExists(countryDir);

      // Create country/index.html placeholder
      fs.writeFileSync(path.join(countryDir, 'index.html'), `<!-- ${country} -->`);
      console.log(`Created: ${country}/index.html`);

      for (const [citySlug, cityData] of Object.entries(cities)) {
        const cityDir = path.join(countryDir, citySlug);
        ensureDirectoryExists(cityDir);

        // Create city/index.html placeholder
        fs.writeFileSync(path.join(cityDir, 'index.html'), `<!-- ${cityData.cityName} -->`);
        console.log(`Created: ${country}/${citySlug}/index.html`);
      }
    }

    // Save event location mapping
    fs.writeFileSync(
      path.join(__dirname, '../event-location-map.json'),
      JSON.stringify(eventLocationMap, null, 2)
    );
    console.log(`\nSaved event location map with ${Object.keys(eventLocationMap).length} events`);

    // Save location structure for reference
    fs.writeFileSync(
      path.join(__dirname, '../location-structure.json'),
      JSON.stringify(locationStructure, null, 2)
    );
    console.log(`Saved location structure`);

    console.log('\nLocation structure:');
    for (const [country, cities] of Object.entries(locationStructure)) {
      console.log(`  ${country}:`);
      for (const [slug, data] of Object.entries(cities)) {
        console.log(`    ${slug} (${data.events.length} events)`);
      }
    }

  } catch (err) { console.error('Error:', err); }
}

main();
