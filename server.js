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

            const website =
                el.querySelector(".mlr__item--website a")?.href || null;

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
function getHost(url) {
  try {
    return new URL(url).hostname.replace("www.", "").toLowerCase();
  } catch {
    return null;
  }
}

function classifySource(host) {
  if (!host) return "unknown";

  if (host.includes("facebook.com") || host.includes("fb.com")) return "facebook";
  if (host.includes("google.") || host.includes("maps.google")) return "google";
  if (
      host.includes("yellowpages") ||
      host.includes("yelp.") ||
      host.includes("foursquare") ||
      host.includes("hotfrog")
  ) return "directory";

  if (
      host.includes("instagram.com") ||
      host.includes("linkedin.com") ||
      host.includes("tiktok.com") ||
      host.includes("twitter.com")
  ) return "social";

  return "website";
}

async function resolveFinalUrl(url) {
  try {
    const res = await axios.get(url, {
      maxRedirects: 5,
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0 (LeadBot/2.0)" }
    });
    return res.request?.res?.responseUrl || url;
  } catch {
    return url;
  }
}

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

    // -------------------- URL RESOLVE --------------------
    const finalUrl = await resolveFinalUrl(business.website);
    const host = getHost(finalUrl);
    const sourceType = classifySource(host);

    // -------------------- SCRAPE --------------------
    let html = "";
    try {
      const response = await axios.get(finalUrl, {
        timeout: 20000,
        headers: {
          "User-Agent": "Mozilla/5.0 (LeadBot/2.0)"
        }
      });
      html = response.data;
    } catch (e) {
      html = "";
    }

    const $ = cheerio.load(html);
    const pageText = $("body").text().replace(/\s+/g, " ").trim().toLowerCase();

    // -------------------- SEO --------------------
    const title = $("title").text().trim() || null;
    const metaDescription = $('meta[name="description"]').attr("content") || null;
    const h1 = $("h1").first().text().trim() || null;

    // -------------------- TECH --------------------
    const isWordPress = html.toLowerCase().includes("wp-content");
    const isShopify = html.toLowerCase().includes("shopify");

    // -------------------- CONTACT SIGNALS --------------------
    const emails = pageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g);
    const phones = pageText.match(/\+?[0-9][0-9\s\-()]{7,}/g);

    const hasEmail = !!(emails && emails.length);
    const hasPhone = !!(phones && phones.length);
    const hasForm = $("form").length > 0;

    const hasContactPage =
        $("a[href*='contact']").length > 0 || pageText.includes("contact");

    // -------------------- STRUCTURE --------------------
    const totalLinks = $("a").length;
    const imagesCount = $("img").length;

    const internalLinks = $("a").filter((i, el) => {
      const href = $(el).attr("href") || "";
      return href.startsWith("/") || href.includes(host);
    }).length;

    // -------------------- SOCIALS --------------------
    const socialLinks = [];

    $("a").each((_, el) => {
      const href = $(el).attr("href") || "";
      if (
          href.includes("facebook") ||
          href.includes("instagram") ||
          href.includes("linkedin") ||
          href.includes("twitter")
      ) {
        socialLinks.push(href);
      }
    });

    // -------------------- CTA --------------------
    const ctaKeywords = [
      "get a quote",
      "request a quote",
      "contact us",
      "book now",
      "call now",
      "schedule",
      "free estimate"
    ];

    let ctaCount = 0;
    for (const cta of ctaKeywords) {
      if (pageText.includes(cta)) ctaCount++;
    }

    // -------------------- SCORING (IMPROVED NORMALIZED) --------------------

    let score = 0;

    // base trust signals
    if (finalUrl.startsWith("https://")) score += 10;
    if (title) score += 5;
    if (metaDescription) score += 5;
    if (h1) score += 5;

    // contact signals
    if (hasEmail) score += 20;
    if (hasPhone) score += 20;
    if (hasForm) score += 10;
    if (hasContactPage) score += 10;

    // tech signals
    if (isWordPress) score += 5;
    if (isShopify) score += 5;

    // engagement signals
    score += Math.min(ctaCount * 3, 15);
    score += Math.min(socialLinks.length * 2, 10);

    // structure signals
    if (internalLinks > 5) score += 5;
    if (imagesCount > 5) score += 5;

    // -------------------- LEAD TYPE --------------------

    let lead_type = "web_design_lead";
    let lead_tag = "improve_site";

    if (sourceType === "facebook" || sourceType === "social") {
      lead_type = "social_lead";
      lead_tag = "convert_social";
    }

    if (sourceType === "directory") {
      lead_type = "directory_lead";
      lead_tag = "convert_listing";
    }

    if (score >= 80) {
      lead_type = "marketing_lead";
      lead_tag = "sell_leads";
    } else if (score < 40) {
      lead_type = "dead_lead";
      lead_tag = "ignore";
    }

    // -------------------- SAVE --------------------

    await db.execute(
        `
      INSERT INTO business_enrichment (
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          business.website,
          finalUrl,
          sourceType,
          title,
          metaDescription,
          h1,
          isWordPress,
          isShopify,
          hasEmail,
          hasPhone,
          hasForm,
          hasContactPage,
          score,
          lead_type,
          lead_tag,
          null,
          pageText.substring(0, 10000),
          internalLinks,
          imagesCount,
          ctaCount,
          JSON.stringify(socialLinks)
        ]
    );

    await db.execute(
        `UPDATE businesses SET enriched = 1, enriched_at = NOW() WHERE id = ?`,
        [business.id]
    );

    res.json({
      status: "success",
      business: business.name,
      finalUrl,
      sourceType,
      score,
      lead_type,
      lead_tag
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