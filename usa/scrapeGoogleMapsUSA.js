/**
 * scrapeGoogleMapsUSA.js
 *
 * Automated scraper that loops through home-cleaning keywords and US border-state
 * cities/towns (locationsUSA.json), scrolling through Google Maps results to
 * extract names, ratings, addresses, phones and websites.
 *
 * Adapted from scrapeGoogleMaps.js (India/Tailors campaign) for the US
 * home-cleaning outreach campaign, targeting states bordering Canada.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const mysql = require("mysql2/promise");

// --- CONFIGURATION ---

const MAX_SCROLLS = 10; // How many times to press PageDown/End on the results feed

const KEYWORDS = [
  "House Cleaning Service",
  "Residential Cleaning Services",
  "Home Cleaning Services",
  "Maid Service",
  "Deep Cleaning Service"
];

// Load US border-state cities/towns
const LOCATIONS = JSON.parse(fs.readFileSync(path.join(__dirname, "locationsUSA.json"), "utf8"));

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

// Prevent "Data too long for column" errors on varchar columns
function trunc(str, maxLen) {
  if (!str) return str;
  return str.length > maxLen ? str.substring(0, maxLen) : str;
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

  const progressFile = path.join(__dirname, "progressGmapsUSA.json");
  let progress = { locationIndex: 0, keywordIndex: 0 };
  if (fs.existsSync(progressFile)) {
    try {
      progress = JSON.parse(fs.readFileSync(progressFile, "utf8"));
    } catch (e) {}
  }

  console.log("🚀 Google Maps USA Scraper Worker Started");
  console.log(`Will scan ${KEYWORDS.length} keywords across ${LOCATIONS.length} locations.`);
  console.log(`Resuming at Location Index: ${progress.locationIndex}, Keyword Index: ${progress.keywordIndex}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    locale: 'en-US'
  });

  let startL = progress.locationIndex;

  for (let k = progress.keywordIndex; k < KEYWORDS.length; k++) {
    const keyword = KEYWORDS[k];

    for (let l = startL; l < LOCATIONS.length; l++) {
      const location = LOCATIONS[l];

      console.log(`\n🔍 Searching Google Maps: ${keyword} in ${location} (Location ${l+1}/${LOCATIONS.length})`);

      const page = await context.newPage();

      // Navigate directly to the search query on Google Maps
      const url = `https://www.google.com/maps/search/${encodeURIComponent(keyword)}+in+${encodeURIComponent(location)}/`;
      console.log(`   -> Scraping ${url}...`);

      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await delay(5000); // wait for initial load

        // The results are contained in a div with role="feed"
        const feedSelector = 'div[role="feed"]';

        try {
          await page.waitForSelector(feedSelector, { timeout: 15000 });
        } catch (e) {
          console.log(`   ⚠️ Could not find results feed. Maybe no results or Google blocked it. Moving on.`);
          await page.close();
          continue;
        }

        console.log(`   -> Scrolling through results...`);

        // Focus the feed and scroll down multiple times
        await page.click(feedSelector);
        let previousHeight = 0;
        let stuckCount = 0;

        for (let scroll = 0; scroll < MAX_SCROLLS; scroll++) {
          await page.mouse.wheel(0, 10000);
          await page.keyboard.press("End");
          await delay(2000 + Math.random() * 1000); // Wait for network to load more

          // Check if we hit the end (height didn't change)
          const currentHeight = await page.evaluate((selector) => {
            const feed = document.querySelector(selector);
            return feed ? feed.scrollHeight : 0;
          }, feedSelector);

          if (currentHeight === previousHeight) {
            stuckCount++;
            if (stuckCount >= 2) {
              console.log(`   -> Reached the end of the list after ${scroll} scrolls.`);
              break;
            }
          } else {
            stuckCount = 0;
          }
          previousHeight = currentHeight;
        }

        // Now extract all articles
        const results = await page.evaluate(() => {
          const items = document.querySelectorAll('div[role="article"]');

          return Array.from(items).map((el) => {
            // Google uses obfuscated classes. A common structure:
            // Name is usually in the aria-label of the article itself.
            let name = el.getAttribute("aria-label");

            // Extract the text content from the container
            const textContent = el.innerText || "";
            const lines = textContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            if (!name && lines.length > 0) {
               name = lines[0]; // fallback
            }

            let phone = null;
            let address = null;
            let website = null;

            // Find phone numbers and address info from the text lines
            for (let line of lines) {
              // Match phone numbers with optional prefixes/spaces/parens/dashes
              if (/[\d\s\-\+\(\)]{10,}/.test(line) && !line.includes(":") && !line.includes("$") && !line.toLowerCase().includes("closed")) {
                const digits = line.replace(/\D/g, '');
                if (digits.length >= 8 && digits.length <= 13) {
                  phone = line;
                }
              }
              // Address heuristic: contains a comma separating locations
              else if (line.includes(",") && /\d/.test(line)) {
                address = line;
              }

              if (line.toLowerCase().includes(".com") || line.toLowerCase().includes("website")) {
                 website = line;
              }
            }

            const profile_url = el.querySelector('a') ? el.querySelector('a').getAttribute("href") : null;

            return { name, phone, address, website, profile_url };
          }).filter(x => x.name && !x.name.includes("Ad ·")); // Ignore ads
        });

        await page.close();

        if (results.length === 0) {
          console.log(`   ⚠️ No results found. Moving to next city/keyword.`);
        } else {
          console.log(`   -> Found ${results.length} basic profiles. Visiting each to extract phone numbers & websites...`);

          let newRecordsCount = 0;
          for (let i = 0; i < results.length; i++) {
            const item = results[i];
            console.log(`      [${i+1}/${results.length}] Extracting details for: ${item.name}`);

            if (item.profile_url) {
              const detailPage = await context.newPage();
              try {
                await detailPage.goto(item.profile_url, { waitUntil: "domcontentloaded", timeout: 15000 });
                await delay(2000 + Math.random() * 1000); // wait for panel to populate

                const details = await detailPage.evaluate(() => {
                  let p = null; let w = null; let a = null;

                  const buttons = document.querySelectorAll("button");
                  for (const btn of buttons) {
                    const label = btn.getAttribute("aria-label");
                    if (label) {
                      if (label.startsWith("Address: ")) a = label.replace("Address: ", "").trim();
                      else if (label.startsWith("Phone: ")) p = label.replace("Phone: ", "").trim();
                    }
                  }

                  const links = document.querySelectorAll("a");
                  for (const link of links) {
                    const label = link.getAttribute("aria-label");
                    if (label && label.startsWith("Website: ")) w = link.href;
                  }

                  return { phone: p, website: w, address: a };
                });

                // Override fallback heuristics with definitive panel data
                if (details.phone) item.phone = details.phone;
                if (details.website) item.website = details.website;
                if (details.address) item.address = details.address;

              } catch (err) {
                console.log(`      ⚠️ Timeout/Error extracting details for ${item.name}`);
              }
              await detailPage.close().catch(()=>{});
            }

            const exists = await businessExists(item.name, item.phone);
            if (!exists) {
              await db.execute(
                `INSERT INTO businesses (name, phone, address, website, profile_url, keyword, location) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                  trunc(item.name, 255),
                  trunc(item.phone, 100),
                  trunc(item.address, 500),
                  trunc(item.website, 255),
                  trunc(item.profile_url, 500),
                  trunc(keyword, 255),
                  trunc(location, 255),
                ]
              );
              newRecordsCount++;
            }
          }
          console.log(`   ✅ Fully processed ${results.length} businesses. Saved ${newRecordsCount} new entries with deep details.`);
        }

      } catch (error) {
        console.error(`   ❌ Failed to scrape:`, error.message);
        await page.close().catch(() => {});
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

  if (fs.existsSync(progressFile)) {
    fs.unlinkSync(progressFile);
  }

  process.exit(0);
}

startScraping().catch(console.error);
