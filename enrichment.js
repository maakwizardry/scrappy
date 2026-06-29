const axios = require("axios");
const cheerio = require("cheerio");

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const CMS_SIGNATURES = {
  wordpress:   [/wp-content/i, /wp-includes/i, /xmlrpc\.php/i, /wordpress/i],
  shopify:     [/cdn\.shopify\.com/i, /Shopify\.theme/i, /myshopify\.com/i],
  webflow:     [/webflow\.com/i, /\.webflow\.io/i, /data-wf-/i],
  squarespace: [/squarespace\.com/i, /static\.squarespace\.com/i, /squarespace-cdn/i],
  wix:         [/wix\.com/i, /wixstatic\.com/i, /wixsite\.com/i],
  framer:      [/framer\.com/i, /framerusercontent\.com/i],
  ghost:       [/ghost\.org/i, /ghost\.io/i],
  hubspot:     [/hs-scripts\.com/i, /hubspot\.com/i, /hsforms\.com/i],
};

const ANALYTICS_SIGNATURES = [
  /google-analytics\.com/i, /googletagmanager\.com/i,
  /gtag\(/i, /ga\(/i,
  /fbq\(/i, /facebook\.net\/en_US\/fbevents/i, // Meta Pixel
  /segment\.com/i, /mixpanel/i, /hotjar/i, /clarity\.ms/i,
  /heap\.io/i, /amplitude\.com/i,
];

const CHAT_WIDGET_SIGNATURES = {
  intercom:  [/intercom/i, /widget\.intercom\.io/i],
  crisp:     [/crisp\.chat/i, /client\.crisp\.chat/i],
  drift:     [/drift\.com/i, /js\.driftt\.com/i],
  tidio:     [/tidio/i, /code\.tidio\.co/i],
  tawk:      [/tawk\.to/i, /embed\.tawk\.to/i],
  zendesk:   [/zopim/i, /zendesk\.com\/embeddable/i],
  freshchat: [/freshchat/i, /wchat\.freshchat\.com/i],
};

const SOCIAL_PLATFORMS = {
  facebook:  /facebook\.com\//i,
  instagram: /instagram\.com\//i,
  twitter:   /twitter\.com\/|x\.com\//i,
  linkedin:  /linkedin\.com\//i,
  youtube:   /youtube\.com\//i,
  tiktok:    /tiktok\.com\//i,
  pinterest: /pinterest\.com\//i,
};

const PAIN_KEYWORDS = [
  "under construction", "coming soon", "lorem ipsum",
  "click here", "read more", "learn more", // weak CTAs
];

const CONTACT_PAGE_PATTERNS = /\/(contact|reach-us|get-in-touch|talk-to-us|hire-us)/i;
const PRICING_PAGE_PATTERNS  = /\/(pricing|plans|packages|rates|fees)/i;
const BLOG_PAGE_PATTERNS     = /\/(blog|news|articles|insights|resources|posts)/i;
const ABOUT_PAGE_PATTERNS    = /\/(about|team|who-we-are|our-story|company)/i;
const SERVICES_PAGE_PATTERNS = /\/(services|solutions|what-we-do|offerings|products)/i;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function normalizeUrl(url) {
  if (!url) return null;
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try { return new URL(url).href; } catch { return null; }
}

function matchesAny(source, patterns) {
  return patterns.some((p) => p.test(source));
}

function detectCMS(html, headers = {}) {
  const source = html + JSON.stringify(headers);
  for (const [cms, patterns] of Object.entries(CMS_SIGNATURES)) {
    if (matchesAny(source, patterns)) return cms;
  }
  return "custom";
}

function detectAnalytics(html) {
  return ANALYTICS_SIGNATURES.some((p) => p.test(html));
}

function detectChatWidget(html) {
  for (const [name, patterns] of Object.entries(CHAT_WIDGET_SIGNATURES)) {
    if (matchesAny(html, patterns)) return name;
  }
  return null;
}

function detectBookingSystem(html, $) {
  const bookingLinks = [
    /calendly\.com/i, /acuityscheduling\.com/i, /setmore\.com/i,
    /squareup\.com\/appointments/i, /vagaro\.com/i, /mindbodyonline\.com/i,
    /simplybook\.me/i, /appointlet\.com/i, /fresha\.com/i, /booksy\.com/i,
    /schedulicity\.com/i
  ];
  if (bookingLinks.some(regex => regex.test(html))) return true;

  const ctaSelectors = [
    "a.btn", "a.button", "button", ".cta", "[class*='cta']",
    "a[class*='btn']", "a[class*='button']",
  ];
  let hasBookingCTA = false;
  $(ctaSelectors.join(", ")).each((_, el) => {
    const text = $(el).text().trim().toLowerCase();
    if (text.includes("book") || text.includes("schedule") || text.includes("appointment")) {
      hasBookingCTA = true;
    }
  });
  
  return hasBookingCTA;
}

function detectSocialLinks($) {
  const found = {};
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    for (const [platform, pattern] of Object.entries(SOCIAL_PLATFORMS)) {
      if (pattern.test(href)) found[platform] = href;
    }
  });
  return Object.entries(found).map(([platform, url]) => ({ platform, url }));
}

function extractCopyrightYear(html) {
  const match = html.match(/©\s*(\d{4})|copyright\s*(\d{4})/i);
  if (match) return parseInt(match[1] || match[2]);
  return null;
}

function extractFooterCopyrightYear($) {
  const footerText = $("footer").text() + $('[class*="footer"]').text();
  const match = footerText.match(/©\s*(\d{4})|copyright\s*(?:©\s*)?(\d{4})/i);
  if (match) return parseInt(match[1] || match[2]);
  return null;
}

function extractNavLinks($, baseUrl) {
  const links = new Set();
  $("nav a[href], header a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (href && !href.startsWith("#") && !href.startsWith("mailto") && !href.startsWith("tel")) {
      try {
        const abs = new URL(href, baseUrl).href;
        links.add(abs);
      } catch {}
    }
  });
  return [...links];
}

function extractAllInternalLinks($, baseUrl) {
  const parsed = new URL(baseUrl);
  const links = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    try {
      const abs = new URL(href, baseUrl);
      if (abs.hostname === parsed.hostname) links.add(abs.pathname);
    } catch {}
  });
  return links.size;
}

function extractCTAs($) {
  const ctaSelectors = [
    "a.btn", "a.button", "button", ".cta", "[class*='cta']",
    "a[class*='btn']", "a[class*='button']",
  ];
  const texts = new Set();
  $(ctaSelectors.join(", ")).each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length < 60) texts.add(text);
  });
  return [...texts].slice(0, 10);
}

function extractServicesProducts($) {
  const candidates = [];
  // From nav items
  $("nav a, header a").each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length < 40 && !/home|about|contact|blog|login|sign/i.test(text)) {
      candidates.push(text);
    }
  });
  // From headings in service sections
  $("h2, h3").each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length < 80) candidates.push(text);
  });
  return [...new Set(candidates)].slice(0, 15);
}

function extractValueProp($) {
  // Hero section — most likely first h1 + nearby paragraph
  const h1 = $("h1").first().text().trim();
  const heroP = $("h1").first().next("p").text().trim()
    || $(".hero p, .banner p, [class*='hero'] p").first().text().trim();
  return { h1, heroP };
}

function extractBusinessSummary($) {
  // Try meta description first
  const meta = $('meta[name="description"]').attr("content")
    || $('meta[property="og:description"]').attr("content") || "";

  // Try about section
  const aboutSection = $('[class*="about"] p, #about p').first().text().trim();

  // Fallback to first meaningful paragraph
  const firstP = $("main p, article p, section p").first().text().trim();

  return (meta || aboutSection || firstP || "").slice(0, 500);
}

function detectPainPoints($, html, copyrightYear) {
  const issues = [];

  if (copyrightYear && copyrightYear < 2020) {
    issues.push(`site_outdated_${copyrightYear}`);
  }

  if (!$('meta[name="viewport"]').length) {
    issues.push("not_mobile_optimized");
  }

  const lowerHtml = html.toLowerCase();
  PAIN_KEYWORDS.forEach((kw) => {
    if (lowerHtml.includes(kw)) issues.push(`weak_copy_${kw.replace(/\s/g, "_")}`);
  });

  const imgCount = $("img").length;
  if (imgCount === 0) issues.push("no_images");

  return issues;
}

function classifyLead(enrichment) {
  const { hasWebsite, cms, painPoints, copyrightYear } = enrichment;

  if (!hasWebsite) return { lead_type: "web_design_lead", lead_tag: "no_website" };

  if (painPoints.includes("not_mobile_optimized")) return { lead_type: "web_design_lead", lead_tag: "not_mobile_friendly" };

  if (copyrightYear && copyrightYear < 2019) return { lead_type: "web_design_lead", lead_tag: "outdated_website" };

  if (cms === "wix" || cms === "squarespace") return { lead_type: "web_design_lead", lead_tag: `upgrade_from_${cms}` };

  return { lead_type: "general_outreach", lead_tag: "established_site" };
}

function cleanPageText($) {
  $("script, style, noscript, iframe, svg, head").remove();
  const text = $.root().text().replace(/\s+/g, " ").trim();
  return text.slice(0, 3000); // enough context for AI without bloat
}

// ─────────────────────────────────────────────
// MAIN ENRICHMENT FUNCTION
// ─────────────────────────────────────────────

async function performEnrichment(websiteUrl) {
  const normalizedUrl = normalizeUrl(websiteUrl);
  if (!normalizedUrl) throw new Error(`Invalid URL: ${websiteUrl}`);

  let response;
  try {
    response = await axios.get(normalizedUrl, {
      timeout: 12000,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    throw new Error(`Failed to fetch ${normalizedUrl}: ${err.message}`);
  }

  const html      = response.data || "";
  const finalUrl  = response.request?.res?.responseUrl || normalizedUrl;
  const headers   = response.headers || {};
  const $         = cheerio.load(html);

  // ── Tech Stack ──────────────────────────────
  const cms            = detectCMS(html, headers);
  const hasAnalytics   = detectAnalytics(html);
  const chatWidget     = detectChatWidget(html);
  const hasBookingSystem = detectBookingSystem(html, $);
  const hasSSL         = finalUrl.startsWith("https://");
  const hasViewportMeta = !!$('meta[name="viewport"]').length;

  // ── Page Identity ────────────────────────────
  const title          = $("title").text().trim();
  const metaDescription = $('meta[name="description"]').attr("content")?.trim() || "";
  const { h1, heroP }  = extractValueProp($);

  // ── Business Context ─────────────────────────
  const businessSummary   = extractBusinessSummary($);
  const servicesOrProducts = extractServicesProducts($);
  const ctaTexts          = extractCTAs($);
  const primaryCTA        = ctaTexts[0] || null;
  const socialLinks       = detectSocialLinks($);

  // ── Site Structure ───────────────────────────
  const navLinks          = extractNavLinks($, finalUrl);
  const internalLinksCount = extractAllInternalLinks($, finalUrl);
  const imagesCount       = $("img").length;

  const hasContactPage  = navLinks.some((l) => CONTACT_PAGE_PATTERNS.test(l));
  const hasPricingPage  = navLinks.some((l) => PRICING_PAGE_PATTERNS.test(l));
  const hasBlog         = navLinks.some((l) => BLOG_PAGE_PATTERNS.test(l));
  const hasAboutPage    = navLinks.some((l) => ABOUT_PAGE_PATTERNS.test(l));
  const hasServicesPage = navLinks.some((l) => SERVICES_PAGE_PATTERNS.test(l));
  const hasTestimonials = /testimonial|review|what.+client|what.+customer/i.test(html);
  const hasTeamPage     = /our.team|meet.the.team|our.people|staff/i.test(html)
    || navLinks.some((l) => ABOUT_PAGE_PATTERNS.test(l));

  // ── Inline contact info ───────────────────────
  const hasEmail = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i.test(html);
  const hasPhone = /(\+?\d[\d\s\-().]{7,}\d)/.test(html);

  // ── Pain Signals ─────────────────────────────
  const copyrightYear = extractFooterCopyrightYear($) || extractCopyrightYear(html);
  const painPoints    = detectPainPoints($, html, copyrightYear);

  // ── Score ─────────────────────────────────────
  let score = 50;
  if (hasSSL)            score += 5;
  if (hasAnalytics)      score += 10;
  if (chatWidget)        score += 5;
  if (hasViewportMeta)   score += 10;
  if (hasBlog)           score += 5;
  if (hasTestimonials)   score += 5;
  if (hasPricingPage)    score += 5;
  if (copyrightYear && copyrightYear < 2020) score -= 20;
  if (painPoints.length > 2) score -= 10;
  score = Math.max(0, Math.min(100, score));

  if (!hasBookingSystem) {
    painPoints.push("no_booking_system");
  }

  // ── Lead Classification ───────────────────────
  const { lead_type, lead_tag } = classifyLead({
    hasWebsite: true, cms, painPoints, copyrightYear,
  });

  // ── Raw text for AI ───────────────────────────
  const pageText = cleanPageText($);

  return {
    // Identity
    hasWebsite:      true,
    finalUrl,
    sourceType:      "scraped",
    title,
    metaDescription,
    h1,
    heroP,

    // Tech Stack
    cms,
    hasSSL,
    hasAnalytics,
    chatWidget,           // null or name of widget
    hasViewportMeta,

    // Business Context
    businessSummary,
    servicesOrProducts,   // string[]
    ctaTexts,             // string[]
    primaryCTA,
    socialLinks,          // [{ platform, url }]

    // Site Structure
    hasContactPage,
    hasPricingPage,
    hasBlog,
    hasAboutPage,
    hasServicesPage,
    hasTestimonials,
    hasTeamPage,
    hasEmail,
    hasPhone,
    internalLinksCount,
    imagesCount,

    // Pain Signals
    copyrightYear,
    painPoints,           // string[]

    // Score & Classification
    score,
    lead_type,
    lead_tag,

    // Raw text for AI prompt
    pageText,
  };
}

module.exports = { performEnrichment };