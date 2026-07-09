/**
 * scrapeWorker.js
 * 
 * Automated scraper that loops through standard keywords and Canadian cities,
 * paginating up to 20 pages per query, and inserting results into the database.
 */

require("dotenv").config();
const fs = require("fs");
const { chromium } = require("playwright");
const mysql = require("mysql2/promise");

// --- CONFIGURATION ---

const MAX_PAGES = 20;

const KEYWORDS = [
  // "plumber",
  // "electrician",
  // "hvac",
  // "roofer",
  // "landscaping"
  "physiotherapy",
  "rehab clinic",
  "chiropractor",
  "medical clinic",
  "family doctor",
  "optometrist",
  "eye clinic",
  "electricians",
  "Lawn Maintenance",
  "Snow Removal Service",
  "Auto Detailing",
  "Beauty Salons"
];

// Load thousands of Canadian cities dynamically
const LOCATIONS = JSON.parse(fs.readFileSync("./locations.json", "utf8"));

// ---------------------

let db;

async function initDB() {
  if (db) return;
  db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });
  console.log("✅ Scraper DB connected");
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Check if a business already exists to avoid duplicates
async function businessExists(name, phone) {
  if (!name) return false;
  
  if (phone) {
    const [rows] = await db.execute(
      `SELECT id FROM businesses WHERE name = ? AND phone = ? LIMIT 1`,
      [name, phone]
    );
    return rows.length > 0;
  } else {
    const [rows] = await db.execute(
      `SELECT id FROM businesses WHERE name = ? LIMIT 1`,
      [name]
    );
    return rows.length > 0;
  }
}

async function startScraping() {
  await initDB();
  
  const progressFile = "./progress.json";
  let progress = { locationIndex: 0, keywordIndex: 0 };
  if (fs.existsSync(progressFile)) {
    try {
      progress = JSON.parse(fs.readFileSync(progressFile, "utf8"));
    } catch (e) {}
  }

  console.log("🚀 Automated Scraper Worker Started");
  console.log(`Will scan ${KEYWORDS.length} keywords across ${LOCATIONS.length} locations.`);
  console.log(`Resuming at Location Index: ${progress.locationIndex}, Keyword Index: ${progress.keywordIndex}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
  });

  let startL = progress.locationIndex;

  for (let k = progress.keywordIndex; k < KEYWORDS.length; k++) {
    const keyword = KEYWORDS[k];

    for (let l = startL; l < LOCATIONS.length; l++) {
      const location = LOCATIONS[l];
      
      console.log(`\n🔍 Searching: ${keyword} in ${location} (Location ${l+1}/${LOCATIONS.length})`);
      
      let consecutiveEmptyPages = 0;
      
      // Loop through pages 1 to MAX_PAGES
      for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
        const page = await context.newPage();
        const url = `https://www.yellowpages.ca/search/si/${pageNum}/${encodeURIComponent(keyword)}/${encodeURIComponent(location)}`;
        
        console.log(`   -> Scraping Page ${pageNum}...`);
        
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          // Add a random delay to avoid triggering anti-bot protection
          await delay(2000 + Math.random() * 2000); 

          const results = await page.evaluate(() => {
            const items = document.querySelectorAll(".listing");

            return Array.from(items).map((el) => {
              const name = el.querySelector("a.listing__name--link")?.innerText?.trim() || null;
              
              const phone = el.querySelector("[data-phone]")?.getAttribute("data-phone") || 
                            el.querySelector(".mlr__submenu__item h4")?.innerText?.trim() || null;

              const address = el.querySelector(".listing__address")?.innerText?.trim() || null;

              let website = el.querySelector(".mlr__item--website a")?.href || null;
              if (website && website.includes("redirect=")) {
                try {
                  const urlObj = new URL(website);
                  const redirectParam = urlObj.searchParams.get("redirect");
                  if (redirectParam) {
                    website = decodeURIComponent(redirectParam);
                  }
                } catch (e) {}
              }

              const profile_url = el.querySelector("a.listing__name--link")?.href || null;

              return { name, phone, address, website, profile_url };
            }).filter(x => x.name); // only keep if name exists
          });
          
          await page.close();

          if (results.length === 0) {
            console.log(`   ⚠️ No results found on page ${pageNum}. Stopping pagination for this city/keyword.`);
            break; // Move to next city/keyword
          }

          let newRecordsCount = 0;

          // Insert into database
          for (const item of results) {
            const exists = await businessExists(item.name, item.phone);
            
            if (!exists) {
              await db.execute(
                `INSERT INTO businesses (name, phone, address, website, profile_url, keyword, location) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [item.name, item.phone, item.address, item.website, item.profile_url, keyword, location]
              );
              newRecordsCount++;
            }
          }

          console.log(`   ✅ Found ${results.length} businesses. Saved ${newRecordsCount} new entries.`);

          // Wait between pages
          await delay(3000 + Math.random() * 3000);

        } catch (error) {
          console.error(`   ❌ Failed to scrape page ${pageNum}:`, error.message);
          await page.close().catch(() => {});
          
          // Break the pagination loop on severe errors (like CAPTCHA or blocking)
          if (error.message.includes('ERR_TIMED_OUT') || error.message.includes('Navigation timeout')) {
            console.log(`   ⚠️ Network issue or blocking detected. Moving to next search...`);
            break;
          }
        }
      }
      
      // Save progress after each location is complete
      fs.writeFileSync(progressFile, JSON.stringify({ keywordIndex: k, locationIndex: l + 1 }));

      // Wait between different locations
      console.log(`   ⏳ Waiting before next search...`);
      await delay(5000 + Math.random() * 5000);
    }
    
    // Reset location index for the next keyword
    startL = 0;
    fs.writeFileSync(progressFile, JSON.stringify({ keywordIndex: k + 1, locationIndex: 0 }));
  }

  await browser.close();
  console.log("\n🎉 Scraping cycle completed!");
  
  // Clean up progress file when fully done
  if (fs.existsSync(progressFile)) {
    fs.unlinkSync(progressFile);
  }
  
  process.exit(0);
}

startScraping().catch(console.error);
