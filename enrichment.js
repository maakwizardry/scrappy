const cheerio = require("cheerio");
const { fetchWithFallback } = require("./fetchPage");

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
  const { hasWebsite, painPoints, copyrightYear, cms } = enrichment;

  // 1. No website = strongest intent
  if (!hasWebsite) {
    return { lead_type: "web_design_lead", lead_tag: "no_website" };
  }

  // 2. Strong UX / conversion issues
  if (painPoints.includes("no_booking_system")) {
    return { lead_type: "web_design_lead", lead_tag: "no_booking_system" };
  }

  if (painPoints.includes("not_mobile_optimized")) {
    return { lead_type: "web_design_lead", lead_tag: "not_mobile_friendly" };
  }

  // 3. Outdated content (time-based signal)
  if (copyrightYear && copyrightYear < 2019) {
    return { lead_type: "web_design_lead", lead_tag: "outdated_website" };
  }

  // 4. CMS becomes CONTEXT, not a category
  // (don’t create lead_tag from CMS)

  return { lead_type: "general_outreach", lead_tag: "established_site" };
}

const EMAIL_BLACKLIST = /\.(png|jpg|jpeg|gif|svg|webp|woff|ttf|css|js)$/i;
const JUNK_EMAIL_DOMAINS = /sentry\.io|example\.com|yourdomain|domain\.com|email\.com|test\.com/i;

// Page-builder templates (Webflow, Wix, GoDaddy, etc.) ship with the vendor's
// own placeholder mailto: href baked into a component; site owners often edit
// the *visible* text to their real address but never touch the underlying
// href. Trust the href outright only when it matches the business's own
// domain or a known public mailbox provider — otherwise it's most likely
// leftover template boilerplate.
const COMMON_EMAIL_PROVIDERS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
  "aol.com", "protonmail.com", "live.com", "msn.com", "comcast.net",
  "yandex.com", "zoho.com", "gmx.com", "mail.com",
]);

function isValidEmail(addr) {
  return !!addr && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(addr) && !JUNK_EMAIL_DOMAINS.test(addr);
}

// Cloudflare's "email protection" replaces real addresses with an XOR-encoded
// hex blob in a data-cfemail attribute, decoded client-side by their JS.
// A raw-HTML regex never sees the real address unless we decode it ourselves.
function decodeCfEmail(encoded) {
  try {
    const r = parseInt(encoded.substr(0, 2), 16);
    let email = "";
    for (let n = 2; n < encoded.length; n += 2) {
      email += String.fromCharCode(parseInt(encoded.substr(n, 2), 16) ^ r);
    }
    return email;
  } catch {
    return null;
  }
}

function extractEmail($, html, siteDomain) {
  // 1. Priority: visible mailto: links (most trustworthy)
  let found = null;
  let suspicious = null; // href present but doesn't match the site's own domain
  $("a[href^='mailto:']").each((_, el) => {
    if (found) return;
    const href = $(el).attr("href") || "";
    let addr = href.replace(/^mailto:/i, "").split("?")[0].trim();
    // hrefs are sometimes URL-encoded (e.g. "%20" before the address) —
    // decode before validating, otherwise a stray %20 gets glued onto the
    // local part and produces an invalid, unusable address.
    try { addr = decodeURIComponent(addr); } catch {}
    addr = addr.trim().toLowerCase();
    if (!isValidEmail(addr)) return;

    const emailDomain = addr.split("@")[1];
    const matchesSite = siteDomain && (emailDomain === siteDomain || emailDomain.endsWith("." + siteDomain));
    const isPublicProvider = COMMON_EMAIL_PROVIDERS.has(emailDomain);

    if (matchesSite || isPublicProvider) {
      found = addr;
      return;
    }

    // href domain is unrelated to this business — likely a template vendor's
    // placeholder. The link's own visible text is often the real address the
    // owner actually edited; prefer that if it's a different valid email.
    const visibleText = $(el).text().trim().toLowerCase();
    if (isValidEmail(visibleText) && visibleText !== addr) {
      found = visibleText;
      return;
    }

    if (!suspicious) suspicious = addr;
  });
  if (found) return found;

  // 2. Cloudflare-obfuscated emails (data-cfemail attribute)
  $("[data-cfemail]").each((_, el) => {
    if (found) return;
    const decoded = decodeCfEmail($(el).attr("data-cfemail") || "");
    if (decoded && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(decoded) && !JUNK_EMAIL_DOMAINS.test(decoded)) {
      found = decoded.toLowerCase();
    }
  });
  if (found) return found;

  // 3. Fallback: scan visible text only (strip script/style to avoid bundle noise)
  //
  // Some sites (anti-spam plugins) split emails into one <span> per character
  // with no whitespace between them. Cheerio's .text() correctly reassembles
  // those (same as a browser's innerText would), but it just as happily fuses
  // in whatever sits directly next to it with no separator too — a phone
  // number before, a "business" label after — producing e.g.
  // "contacts651-274-9658ritascleaners123@gmail.combusiness". An open-ended
  // `[a-zA-Z]{2,}` TLD can't tell a real TLD from glued-on trailing text, so
  // anchor to a known TLD list and sanity-check the local part isn't a
  // phone-number-shaped run.
  const $2 = require("cheerio").load(html);
  $2("script, style, noscript, head").remove();
  const rawText = $2.root().text();
  // A social-icon link sitting right next to the contact email with no
  // separator (e.g. "...gmail.comwww.facebook.com") is common enough to
  // guard for specifically: a real domain's dots are indistinguishable from
  // glued-domain dots by TLD-boundary matching alone, since both look like
  // "word.word.tld". Insert a separator before the recognizable glue partner.
  const visibleText = rawText.replace(
    /([a-z0-9])((?:https?:\/\/)?(?:www\.)?(?:facebook|instagram|twitter|linkedin|youtube|tiktok|pinterest|snapchat)\.[a-z]{2,})/gi,
    "$1 $2"
  );
  const match = visibleText.match(
    /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.(com|net|org|us|ca|co|io|biz|info|edu|gov|me|app|dev|xyz|online|shop|store|cloud|tech|site|ai|uk|au|nz|in|mx|de|fr|es|it|nl)(?![a-zA-Z0-9])/i
  );
  if (match) {
    const addr = match[0].toLowerCase();
    const localPart = addr.split("@")[0];
    const looksLikePhoneNumber = /\d{3}[\d\-.\s]{4,}\d{3}/.test(localPart);
    if (!JUNK_EMAIL_DOMAINS.test(addr) && !EMAIL_BLACKLIST.test(addr) && localPart.length <= 40 && !looksLikePhoneNumber) {
      return addr;
    }
  }

  // 4. Last resort: an off-domain mailto href we couldn't corroborate.
  // Still more useful than nothing, but least trustworthy — kept last.
  if (suspicious) return suspicious;

  return null;
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

  // Falls back to a headless-browser render when the plain fetch looks
  // blocked (403/429) or empty (client-rendered site) — recovers real
  // content for sites that would otherwise look dead.
  const fetched = await fetchWithFallback(normalizedUrl, { timeout: 12000 });
  if (!fetched.ok) {
    throw new Error(`Failed to fetch ${normalizedUrl}: ${fetched.error?.message || "unknown error"}`);
  }

  const html      = fetched.html || "";
  const finalUrl  = fetched.finalUrl || normalizedUrl;
  const headers   = fetched.headers || {};
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
  const siteDomain = new URL(finalUrl).hostname.toLowerCase().replace(/^www\./, "");
  let extractedEmail = extractEmail($, html, siteDomain);

  // Most small-business sites put their email on the Contact (or About) page,
  // not the homepage. Only the homepage was ever checked before, which is
  // the main reason emails went missing on sites that scraped fine otherwise.
  if (!extractedEmail) {
    const secondaryLink =
      navLinks.find((l) => CONTACT_PAGE_PATTERNS.test(l)) ||
      navLinks.find((l) => ABOUT_PAGE_PATTERNS.test(l));

    if (secondaryLink) {
      try {
        const secondaryFetch = await fetchWithFallback(secondaryLink, { timeout: 10000 });
        if (secondaryFetch.ok && secondaryFetch.html) {
          const $secondary = cheerio.load(secondaryFetch.html);
          extractedEmail = extractEmail($secondary, secondaryFetch.html, siteDomain);
        }
      } catch {
        // Best-effort only — homepage result (null) stands if this fails
      }
    }
  }

  const hasEmail = !!extractedEmail;
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
    email: extractedEmail,      // actual email address string or null
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