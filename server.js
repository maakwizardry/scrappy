require("dotenv").config();

const express = require("express");
const { chromium } = require("playwright");
const mysql = require("mysql2/promise");
const axios = require("axios");
const cheerio = require("cheerio");
const { URL } = require("url");
const analyzeService = require("./analyze");

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

// -------------------- SAFE HELPERS --------------------
function safeString(val) {
  if (val === null || val === undefined) return null;
  return typeof val === "string" ? val : String(val);
}

function safeJsonParse(input) {
  if (!input) return null;
  if (typeof input !== "string") return input;

  const cleaned = input
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("❌ JSON parse failed:", cleaned);
    return null;
  }
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

      return Array.from(items)
          .map((el) => {
            const name =
                el.querySelector("a.listing__name--link")?.innerText?.trim() ||
                null;

            const phone =
                el.querySelector("[data-phone]")?.getAttribute("data-phone") ||
                el.querySelector(".mlr__submenu__item h4")?.innerText?.trim() ||
                null;

            const address =
                el.querySelector(".listing__address")?.innerText?.trim() ||
                null;

            let website =
                el.querySelector(".mlr__item--website a")?.href || null;
            if (website && website.includes("redirect=")) {
              try {
                const urlObj = new URL(website);
                const redirectParam = urlObj.searchParams.get("redirect");
                if (redirectParam) {
                  website = decodeURIComponent(redirectParam);
                }
              } catch (e) {}
            }

            const profile_url =
                el.querySelector("a.listing__name--link")?.href || null;

            return {
              name,
              phone,
              address,
              website,
              profile_url,
            };
          })
          .filter((x) => x.name);
    });

    await browser.close();

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
            location,
          ]
      );
    }

    res.json({
      status: "success",
      count: results.length,
      saved_to_db: true,
      results,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Scraping failed",
      details: error.message,
    });
  }
});
const { performEnrichment } = require("./enrichment");
// -------------------- ENRICH API --------------------

app.post("/enrich", async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT * FROM businesses
      WHERE enriched = 0
      ORDER BY created_at ASC
      LIMIT 1
    `);

    if (!rows.length) {
      return res.json({
        status: "done",
        message: "No businesses left to enrich"
      });
    }

    const business = rows[0];

    if (!business.website) {
      await db.execute(
          `UPDATE businesses SET enriched = 1, enriched_at = NOW() WHERE id = ?`,
          [business.id]
      );

      return res.json({
        status: "skipped",
        reason: "no website",
        business: business.name
      });
    }

    // -------------------- ENRICHMENT CALL --------------------
    let enrichmentData;
    try {
      enrichmentData = await performEnrichment(business.website);
    } catch (err) {
      await db.execute(
          `UPDATE businesses SET enriched = 1, enriched_at = NOW() WHERE id = ?`,
          [business.id]
      );
      return res.json({
        status: "skipped",
        reason: err.message,
        business: business.name
      });
    }

    // -------------------- SAVE --------------------

    await db.execute(
        `
      INSERT INTO business_enrichment (
        business_id,
        website,
        final_url,
        source_type,
        title,
        meta_description,
        h1,
        is_wordpress,
        is_shopify,
        has_email,
        has_phone,
        has_form,
        has_contact_page,
        score,
        lead_type,
        lead_tag,
        services_text,
        all_text,
        internal_links_count,
        images_count,
        cta_count,
        social_links
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          business.id,
          business.website,
          enrichmentData.finalUrl,
          enrichmentData.sourceType,
          enrichmentData.title,
          enrichmentData.metaDescription,
          enrichmentData.h1,
          enrichmentData.isWordPress,
          enrichmentData.isShopify,
          enrichmentData.hasEmail,
          enrichmentData.hasPhone,
          enrichmentData.hasForm,
          enrichmentData.hasContactPage,
          enrichmentData.score,
          enrichmentData.lead_type,
          enrichmentData.lead_tag,
          null,
          enrichmentData.pageText,
          enrichmentData.internalLinks,
          enrichmentData.imagesCount,
          enrichmentData.ctaCount,
          JSON.stringify(enrichmentData.socialLinks)
        ]
    );

    await db.execute(
        `UPDATE businesses SET enriched = 1, enriched_at = NOW() WHERE id = ?`,
        [business.id]
    );

    res.json({
      status: "success",
      business: business.name,
      finalUrl: enrichmentData.finalUrl,
      sourceType: enrichmentData.sourceType,
      score: enrichmentData.score,
      lead_type: enrichmentData.lead_type,
      lead_tag: enrichmentData.lead_tag
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Enrichment failed",
      details: error.message
    });
  }
});

app.post("/analyze", async (req, res) => {
  try {
    const result = await analyzeService.analyzeNext();
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Analysis failed", details: error.message });
  }
});

// -------------------- START SERVER --------------------
app.listen(PORT, async () => {
  await initDB();
  await analyzeService.initDB();
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});