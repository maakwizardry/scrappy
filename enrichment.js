const axios = require("axios");
const cheerio = require("cheerio");
const { URL } = require("url");

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

async function performEnrichment(businessWebsite) {
    if (!businessWebsite) {
        throw new Error("No website provided");
    }
    const finalUrl = await resolveFinalUrl(businessWebsite);
    const host = getHost(finalUrl);
    const sourceType = classifySource(host);

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
    
    return {
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
        pageText: pageText.substring(0, 10000),
        internalLinks,
        imagesCount,
        ctaCount,
        socialLinks
    };
}

module.exports = { performEnrichment };
