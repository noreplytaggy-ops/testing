const fs = require('fs');
const https = require('https');

const EVENTS_URL = 'https://www.parkrunnertourist.com/events1.json';
const BASE_URL = 'https://www.parkrunnertourist.com/explore';

// Helper: fetch JSON over HTTPS
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', (err) => reject(err));
  });
}

// Slugify event name for URLs
function slugify(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
}

// Determine subfolder based on first letter of slug
function getSubfolder(slug) {
  const firstChar = slug.charAt(0).toLowerCase();
  if (firstChar >= 'a' && firstChar <= 'z') {
    return firstChar.toUpperCase();
  }
  return '0-9';
}

// Sitemap XML generator with subfolder support
function generateSitemap(eventPaths) {
  const today = new Date().toISOString().slice(0, 10);
  const urlset = eventPaths
    .map(eventPath => {
      const cleanPath = eventPath.replace(/\.html$/, '').replace(/\/$/, '');
      return `<url>
        <loc>${BASE_URL}/${cleanPath}</loc>
        <lastmod>${today}</lastmod>
        <changefreq>monthly</changefreq>
        <priority>0.8</priority>
      </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlset}
</urlset>`;
}

async function main() {
  try {
    console.log('Fetching events JSON for sitemap...');
    const data = await fetchJson(EVENTS_URL);
    let events;
    if (Array.isArray(data)) {
      events = data;
    } else if (Array.isArray(data.features)) {
      events = data.features;
    } else if (data.events && Array.isArray(data.events.features)) {
      events = data.events.features;
    } else {
      throw new Error('Unexpected JSON structure');
    }

    const eventPaths = [];
    const folderCounts = {};

    // Generate paths for ALL events
    for (const event of events) {
      const name = event.properties.eventname || 'Unknown event';
      const slug = slugify(name);
      const subfolder = getSubfolder(slug);
      
      // Track folder usage to create overflow folders if needed
      if (!folderCounts[subfolder]) {
        folderCounts[subfolder] = 0;
      }
      
      let actualSubfolder = subfolder;
      const MAX_FILES_PER_FOLDER = 999;
      
      if (folderCounts[subfolder] >= MAX_FILES_PER_FOLDER) {
        let suffix = 2;
        while (true) {
          const cand = `${subfolder}${suffix}`;
          if (!folderCounts[cand]) {
            folderCounts[cand] = 0;
          }
          if (folderCounts[cand] < MAX_FILES_PER_FOLDER) {
            actualSubfolder = cand;
            break;
          }
          suffix++;
        }
      }
      
      folderCounts[actualSubfolder]++;
      const relativePath = `${actualSubfolder}/${slug}`;
      eventPaths.push(relativePath);
    }

    // Save sitemap.xml in root directory
    const sitemapContent = generateSitemap(eventPaths);
    fs.writeFileSync('./sitemap.events.xml', sitemapContent, 'utf-8');
    console.log(`Generated sitemap.xml with ${eventPaths.length} URLs`);
    
    // Also save the folder mapping for use by generate-events.js
    const folderMapping = {};
    let index = 0;
    for (const event of events) {
      const slug = slugify(event.properties.eventname || 'Unknown event');
      folderMapping[slug] = eventPaths[index].split('/')[0];
      index++;
    }
    fs.writeFileSync('./folder-mapping.json', JSON.stringify(folderMapping, null, 2), 'utf-8');
    console.log('Generated folder-mapping.json for consistent subfolder assignment');

  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
