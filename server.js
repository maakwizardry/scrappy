require("dotenv").config();

const express = require("express");
const { chromium } = require("playwright");
const mysql = require("mysql2/promise");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// -------------------- DB CONNECTION --------------------
let db;

async function initDB() {
  db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });

  console.log("✅ MySQL connected");
}

// -------------------- SCRAPER API --------------------
app.post("/scrape", async (req, res) => {
  try {
    const { keyword, location } = req.body;

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const url = `https://www.yellowpages.ca/search/si/1/${encodeURIComponent(
      keyword
    )}/${encodeURIComponent(location)}`;

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const results = await page.evaluate(() => {
      const items = document.querySelectorAll(".listing");

      return Array.from(items).map((el) => {
        const name =
          el.querySelector("a.listing__name--link")?.innerText?.trim() || null;

        const phone =
          el.querySelector("[data-phone]")?.getAttribute("data-phone") ||
          el.querySelector(".mlr__submenu__item h4")?.innerText?.trim() ||
          null;

        const address =
          el.querySelector(".listing__address")?.innerText?.trim() || null;

        const website =
          el.querySelector(".mlr__item--website a")?.href || null;

        const profile_url =
          el.querySelector("a.listing__name--link")?.href || null;

        return {
          name,
          phone,
          address,
          website,
          profile_url
        };
      }).filter(x => x.name);
    });

    await browser.close();

    // -------------------- SAVE TO DATABASE --------------------
    for (const item of results) {
      await db.execute(
        `INSERT INTO businesses 
        (name, phone, address, website, profile_url, keyword, location)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          item.name,
          item.phone,
          item.address,
          item.website,
          item.profile_url,
          keyword,
          location
        ]
      );
    }

    res.json({
      status: "success",
      count: results.length,
      saved_to_db: true,
      results
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Scraping failed",
      details: error.message
    });
  }
});

// -------------------- START SERVER --------------------
app.listen(PORT, async () => {
  await initDB();
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});