/**
 * urlValidator.js
 *
 * Validates a scraped website URL BEFORE enrichment.
 * Returns a structured result so the worker knows exactly
 * why a URL was rejected and how to classify the business.
 *
 * Usage:
 *   const { validateUrl } = require("./urlValidator");
 *   const result = await validateUrl(business.website);
 *
 *   if (!result.valid) {
 *     // use result.lead_tag and result.reason
 *   }
 */

const axios = require("axios");
const dns   = require("dns").promises;

// ─────────────────────────────────────────────
// KNOWN JUNK DOMAINS
// These are directory sites, social platforms, map
// providers, or domain-parking pages that a Yellow
// Pages / GMB / Yelp scraper might return as "website".
// ─────────────────────────────────────────────

const SOCIAL_REDIRECT_DOMAINS = new Set([
  "facebook.com", "www.facebook.com", "fb.com", "m.facebook.com",
  "instagram.com", "www.instagram.com",
  "twitter.com", "x.com", "www.twitter.com",
  "linkedin.com", "www.linkedin.com",
  "youtube.com", "www.youtube.com", "youtu.be",
  "tiktok.com", "www.tiktok.com",
  "pinterest.com", "www.pinterest.com",
  "snapchat.com", "www.snapchat.com",
]);

const DIRECTORY_DOMAINS = new Set([
  // Google
  "google.com", "www.google.com",
  "maps.google.com", "goo.gl",
  "business.google.com",
  "g.page",
  // Apple
  "maps.apple.com",
  // Yelp
  "yelp.com", "www.yelp.com", "yelp.ca", "www.yelp.ca",
  // Yellow Pages / directories
  "yellowpages.com", "www.yellowpages.com",
  "yellowpages.ca", "www.yellowpages.ca",
  "yp.com", "www.yp.com",
  "whitepages.com", "www.whitepages.com",
  "foursquare.com", "www.foursquare.com",
  "tripadvisor.com", "www.tripadvisor.com",
  "bbb.org", "www.bbb.org",
  "houzz.com", "www.houzz.com",
  "angi.com", "www.angi.com", "angieslist.com",
  "thumbtack.com", "www.thumbtack.com",
  "homeadvisor.com", "www.homeadvisor.com",
  "clutch.co", "www.clutch.co",
  "bark.com", "www.bark.com",
  "trustpilot.com", "www.trustpilot.com",
  "zomato.com", "www.zomato.com",
  "doordash.com", "www.doordash.com",
  "ubereats.com", "www.ubereats.com",
  "grubhub.com", "www.grubhub.com",
  "opentable.com", "www.opentable.com",
  // Canadian specifics
  "pagesjaunes.ca", "www.pagesjaunes.ca",
  "canpages.ca", "www.canpages.ca",
  "411.ca", "www.411.ca",
]);

const DOMAIN_PARKING_PATTERNS = [
  /^sedo\.com$/i,
  /^godaddy\.com$/i,
  /^namecheap\.com$/i,
  /^hugedomains\.com$/i,
  /^parkingcrew\.net$/i,
  /^bodis\.com$/i,
  /^dan\.com$/i,
  /^afternic\.com$/i,
  /^undeveloped\.com$/i,
  /^uniregistry\.com$/i,
  /^domainmarket\.com$/i,
  /^flippa\.com$/i,
];

// Wix sites that haven't been published yet still live on wixsite.com
const UNFINISHED_SITE_PATTERNS = [
  /\.wixsite\.com$/i,
  /\.weebly\.com$/i,
  /\.webflow\.io$/i,     // staging — real sites use custom domain
  /\.squarespace\.com$/i, // staging
  /\.myshopify\.com$/i,  // only if no custom domain
  /\.godaddysites\.com$/i,
  /\.site123\.me$/i,
  /\.wordpress\.com$/i,  // hosted WP (not self-hosted)
  /\.blogspot\.com$/i,
  /\.tumblr\.com$/i,
];

// HTML content patterns that indicate a parked/for-sale domain
const PARKED_PAGE_PATTERNS = [
  /this domain (is|has been) (for sale|parked|registered)/i,
  /buy this domain/i,
  /domain (is )?available/i,
  /this domain may be for sale/i,
  /inquire about this domain/i,
  /the domain owner/i,
  /this webpage (was|is) (generated|created) by/i,
  /future home of something (quite )?cool/i,
  /coming soon/i,
  /under construction/i,
  /site (is )?currently (under|in) (construction|development)/i,
  /website coming soon/i,
];

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function extractHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function normalizeUrl(url) {
  if (!url) return null;
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try { return new URL(url).href; } catch { return null; }
}

async function domainResolvable(hostname) {
  try {
    await dns.lookup(hostname);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// MAIN VALIDATOR
// ─────────────────────────────────────────────

/**
 * @param {string} rawUrl  - The raw URL from the scraper
 * @returns {Promise<{
 *   valid: boolean,
 *   normalizedUrl: string|null,
 *   finalUrl: string|null,
 *   reason: string,        // machine-readable
 *   lead_tag: string,      // used for DB classification
 *   notes: string,         // human-readable explanation
 * }>}
 */
async function validateUrl(rawUrl) {
  // ── 1. Empty / null ──────────────────────────
  if (!rawUrl || rawUrl.trim() === "") {
    return result(false, null, null, "no_url", "no_website", "No website URL provided");
  }

  const normalizedUrl = normalizeUrl(rawUrl);
  if (!normalizedUrl) {
    return result(false, null, null, "unparseable_url", "invalid_url", `Could not parse URL: ${rawUrl}`);
  }

  const rawHostname = new URL(normalizedUrl).hostname.toLowerCase();
  const hostname    = rawHostname.replace(/^www\./, "");

  // ── 2. Social platform redirect ──────────────
  if (SOCIAL_REDIRECT_DOMAINS.has(rawHostname)) {
    return result(false, normalizedUrl, null, "social_redirect", "social_redirect",
      `URL points to ${rawHostname} — this is a social profile, not a business website`);
  }

  // ── 3. Directory / listing site ──────────────
  if (DIRECTORY_DOMAINS.has(rawHostname)) {
    return result(false, normalizedUrl, null, "directory_listing", "directory_listing",
      `URL points to directory ${rawHostname} — not a business's own website`);
  }

  // ── 4. Unfinished / subdomain builder site ───
  if (UNFINISHED_SITE_PATTERNS.some((p) => p.test(rawHostname))) {
    // Still potentially useful — mark but allow enrichment
    return result(true, normalizedUrl, normalizedUrl, "builder_subdomain", "builder_subdomain",
      `Site is on a builder subdomain (${rawHostname}) — likely unfinished or very basic`);
  }

  // ── 5. Domain parking ────────────────────────
  if (DOMAIN_PARKING_PATTERNS.some((p) => p.test(hostname))) {
    return result(false, normalizedUrl, null, "domain_parking_host", "domain_parked",
      `URL is hosted on a known domain-parking service: ${hostname}`);
  }

  // ── 6. DNS check — domain doesn't resolve ────
  const resolvable = await domainResolvable(rawHostname);
  if (!resolvable) {
    return result(false, normalizedUrl, null, "dns_failed", "domain_not_registered",
      `Domain ${rawHostname} does not resolve — likely unregistered or expired`);
  }

  // ── 7. HTTP fetch — check for redirects & parking pages ──
  let response;
  try {
    response = await axios.get(normalizedUrl, {
      timeout: 10000,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      validateStatus: (s) => s < 500, // treat 4xx as valid responses for inspection
    });
  } catch (err) {
    const reason = classifyFetchError(err);
    return result(false, normalizedUrl, null, reason.code, reason.tag, reason.notes);
  }

  const finalUrl     = response.request?.res?.responseUrl || normalizedUrl;
  const finalHost    = new URL(finalUrl).hostname.toLowerCase().replace(/^www\./, "");
  const html         = typeof response.data === "string" ? response.data : "";
  const statusCode   = response.status;

  // ── 8. Post-redirect domain checks ──────────
  // e.g. entered "joesplumbing.com" but it redirected to google.com/maps/...
  if (finalHost !== hostname) {
    if (SOCIAL_REDIRECT_DOMAINS.has(finalHost) || SOCIAL_REDIRECT_DOMAINS.has("www." + finalHost)) {
      return result(false, normalizedUrl, finalUrl, "redirected_to_social", "social_redirect",
        `Redirected from ${hostname} → ${finalHost} (social platform)`);
    }
    if (DIRECTORY_DOMAINS.has(finalHost) || DIRECTORY_DOMAINS.has("www." + finalHost)) {
      return result(false, normalizedUrl, finalUrl, "redirected_to_directory", "directory_listing",
        `Redirected from ${hostname} → ${finalHost} (directory/listing site)`);
    }
    if (DOMAIN_PARKING_PATTERNS.some((p) => p.test(finalHost))) {
      return result(false, normalizedUrl, finalUrl, "redirected_to_parker", "domain_parked",
        `Redirected from ${hostname} → ${finalHost} (domain parking page)`);
    }
  }

  // ── 9. HTTP error pages ──────────────────────
  if (statusCode === 404) {
    return result(false, normalizedUrl, finalUrl, "http_404", "page_not_found",
      `Got 404 — page not found at ${finalUrl}`);
  }
  if (statusCode === 410) {
    return result(false, normalizedUrl, finalUrl, "http_410", "page_gone",
      `Got 410 — page permanently gone`);
  }
  if (statusCode >= 400) {
    return result(false, normalizedUrl, finalUrl, `http_${statusCode}`, "http_error",
      `Got HTTP ${statusCode} from ${finalUrl}`);
  }

  // ── 10. Parked/coming-soon page content ──────
  if (PARKED_PAGE_PATTERNS.some((p) => p.test(html))) {
    return result(false, normalizedUrl, finalUrl, "parked_content", "domain_parked",
      `Page content matches domain-parking or coming-soon pattern`);
  }

  // ── 11. Empty page ───────────────────────────
  if (!html || html.trim().length < 200) {
    return result(false, normalizedUrl, finalUrl, "empty_page", "empty_website",
      `Page returned almost no content (${html.trim().length} chars)`);
  }

  // ── ✅ All checks passed ─────────────────────
  return result(true, normalizedUrl, finalUrl, "ok", "real_website", "URL is valid and points to a real website");
}

// ─────────────────────────────────────────────
// FETCH ERROR CLASSIFIER
// ─────────────────────────────────────────────

function classifyFetchError(err) {
  const msg = err.message || "";
  const code = err.code || "";

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { code: "dns_not_found",    tag: "domain_not_registered", notes: `DNS lookup failed: ${msg}` };
  }
  if (code === "ECONNREFUSED") {
    return { code: "connection_refused", tag: "server_down",         notes: `Connection refused: ${msg}` };
  }
  if (code === "ECONNRESET" || code === "EPIPE") {
    return { code: "connection_reset",   tag: "server_down",         notes: `Connection reset: ${msg}` };
  }
  if (code === "ETIMEDOUT" || msg.includes("timeout")) {
    return { code: "timeout",            tag: "site_unreachable",    notes: `Request timed out: ${msg}` };
  }
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID" || msg.includes("certificate")) {
    return { code: "ssl_error",          tag: "ssl_issue",           notes: `SSL/TLS error: ${msg}` };
  }
  if (msg.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE")) {
    return { code: "ssl_untrusted",      tag: "ssl_issue",           notes: `Untrusted SSL certificate` };
  }
  return { code: "fetch_failed",         tag: "fetch_failed",        notes: `Unknown fetch error: ${msg}` };
}

// ─────────────────────────────────────────────
// RESULT BUILDER
// ─────────────────────────────────────────────

function result(valid, normalizedUrl, finalUrl, reason, lead_tag, notes) {
  return { valid, normalizedUrl, finalUrl, reason, lead_tag, notes };
}

module.exports = { validateUrl };