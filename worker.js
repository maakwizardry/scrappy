require("dotenv").config();
const mysql = require("mysql2/promise");
const { performEnrichment } = require("./enrichment");
const { validateUrl } = require("./urlValidator");
let db;
async function initDB() {
  db = await mysql.createConnection({
    host:     process.env.DB_HOST,
    port:     Number(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });
  console.log("✅ Enrichment Worker DB connected");
}

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK — no website, or junk URL
// ─────────────────────────────────────────────────────────────────────────────
function needsBookingSystem(business) {
  if (!business) return false;
  const serviceKeywords = /salon|spa|hair|barber|nail|dentist|doctor|clinic|massage|cleaning|plumb|repair|mechanic|gym|fitness|yoga|consult|lawyer|attorney|coach|tutor|therapy|chiropractor/i;
  const target = `${business.name || ""} ${business.keyword || ""}`;
  return serviceKeywords.test(target);
}

function noWebsiteEnrichment(business) {
  const painPoints = ["no_website"];
  if (business && needsBookingSystem(business)) {
    painPoints.push("needs_booking_system");
  }

  return {
    hasWebsite: false, finalUrl: null, sourceType: "unknown",
    title: null, metaDescription: null, h1: null, heroP: null,
    cms: "none", hasSSL: false, hasAnalytics: false, chatWidget: null, hasViewportMeta: false,
    businessSummary: null, servicesOrProducts: [], ctaTexts: [], primaryCTA: null, socialLinks: [],
    hasContactPage: false, hasPricingPage: false, hasBlog: false, hasAboutPage: false,
    hasServicesPage: false, hasTestimonials: false, hasTeamPage: false,
    hasEmail: false, hasPhone: false, internalLinksCount: 0, imagesCount: 0,
    copyrightYear: null, painPoints: painPoints,
    score: 0, lead_type: "web_design_lead", lead_tag: "no_website",
    pageText: "",
  };
}

// Map validator lead_tags to lead_types for the email generator
function resolveLeadType(lead_tag) {
  const map = {
    no_website:           "web_design_lead",
    social_redirect:      "web_design_lead",   // they only have a FB page — perfect prospect
    directory_listing:    "web_design_lead",   // only listed on YP/Google — no real site
    domain_not_registered:"web_design_lead",   // owned a domain once, let it lapse
    domain_parked:        "web_design_lead",   // owns domain but hasn't built anything
    builder_subdomain:    "web_design_lead",   // wixsite.com etc — upgrade opportunity
    empty_website:        "web_design_lead",   // blank/broken site
    site_unreachable:     "web_design_lead",   // server dead
    server_down:          "web_design_lead",
    ssl_issue:            "web_design_lead",
    fetch_failed:         "general_outreach",
    http_error:           "general_outreach",
  };
  return map[lead_tag] || "general_outreach";
}

// ─────────────────────────────────────────────────────────────────────────────
// DB UPSERT
// ─────────────────────────────────────────────────────────────────────────────
async function saveEnrichment(businessId, website, e) {
  await db.execute(
    `
    INSERT INTO business_enrichment (
      business_id, website, final_url, source_type,
      title, meta_description, h1, hero_paragraph,
      cms, has_ssl, has_analytics, chat_widget, has_viewport_meta,
      business_summary, services_or_products, cta_texts, primary_cta, social_links,
      has_contact_page, has_pricing_page, has_blog, has_about_page,
      has_services_page, has_testimonials, has_team_page,
      has_email, has_phone,
      internal_links_count, images_count,
      copyright_year, pain_points,
      score, lead_type, lead_tag,
      page_text
    )
    VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?,
      ?
    )
    ON DUPLICATE KEY UPDATE
      final_url             = VALUES(final_url),
      source_type           = VALUES(source_type),
      title                 = VALUES(title),
      meta_description      = VALUES(meta_description),
      h1                    = VALUES(h1),
      hero_paragraph        = VALUES(hero_paragraph),
      cms                   = VALUES(cms),
      has_ssl               = VALUES(has_ssl),
      has_analytics         = VALUES(has_analytics),
      chat_widget           = VALUES(chat_widget),
      has_viewport_meta     = VALUES(has_viewport_meta),
      business_summary      = VALUES(business_summary),
      services_or_products  = VALUES(services_or_products),
      cta_texts             = VALUES(cta_texts),
      primary_cta           = VALUES(primary_cta),
      social_links          = VALUES(social_links),
      has_contact_page      = VALUES(has_contact_page),
      has_pricing_page      = VALUES(has_pricing_page),
      has_blog              = VALUES(has_blog),
      has_about_page        = VALUES(has_about_page),
      has_services_page     = VALUES(has_services_page),
      has_testimonials      = VALUES(has_testimonials),
      has_team_page         = VALUES(has_team_page),
      has_email             = VALUES(has_email),
      has_phone             = VALUES(has_phone),
      internal_links_count  = VALUES(internal_links_count),
      images_count          = VALUES(images_count),
      copyright_year        = VALUES(copyright_year),
      pain_points           = VALUES(pain_points),
      score                 = VALUES(score),
      lead_type             = VALUES(lead_type),
      lead_tag              = VALUES(lead_tag),
      page_text             = VALUES(page_text),
      updated_at            = NOW()
    `,
    [
      businessId, website, e.finalUrl, e.sourceType,
      e.title, e.metaDescription, e.h1, e.heroP,
      e.cms, e.hasSSL, e.hasAnalytics, e.chatWidget, e.hasViewportMeta,
      e.businessSummary,
      JSON.stringify(e.servicesOrProducts),
      JSON.stringify(e.ctaTexts),
      e.primaryCTA,
      JSON.stringify(e.socialLinks),
      e.hasContactPage, e.hasPricingPage, e.hasBlog, e.hasAboutPage,
      e.hasServicesPage, e.hasTestimonials, e.hasTeamPage,
      e.hasEmail, e.hasPhone,
      e.internalLinksCount, e.imagesCount,
      e.copyrightYear,
      JSON.stringify(e.painPoints),
      e.score, e.lead_type, e.lead_tag,
      e.pageText,
    ]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS ONE BUSINESS
// ─────────────────────────────────────────────────────────────────────────────
async function processNextBusiness() {
  const [rows] = await db.execute(`
    SELECT * FROM businesses
    WHERE enriched = 0
    ORDER BY created_at ASC
    LIMIT 1
  `);

  if (rows.length === 0) {
    return { status: "done" };
  }

  const business = rows[0];
  console.log(`\n⏳ Enriching: ${business.name} (${business.website || "No website"})`);

  let enrichmentData;

  if (!business.website) {
    // ── No URL at all ─────────────────────────────────────────────────────
    console.log("   -> No website. Storing fallback...");
    enrichmentData = noWebsiteEnrichment(business);

  } else {
    // ── Step 1: Pre-validate URL ───────────────────────────────────────────
    console.log("   -> Validating URL...");
    const validation = await validateUrl(business.website);

    if (!validation.valid) {
      // Junk URL — classify, skip heavy scraping, move on
      console.warn(`   ⚠️  Skipping [${validation.reason}]: ${validation.notes}`);
      const fallback = noWebsiteEnrichment(business);
      enrichmentData = {
        ...fallback,
        hasWebsite: false,
        finalUrl:   validation.finalUrl,
        sourceType: validation.reason,
        lead_type:  resolveLeadType(validation.lead_tag),
        lead_tag:   validation.lead_tag,
        painPoints: [...fallback.painPoints, validation.reason],
      };

    } else {
      // ── Step 2: Valid URL — run full enrichment ──────────────────────────
      if (validation.lead_tag === "builder_subdomain") {
        console.log("   ℹ️  Builder subdomain — enriching anyway");
      }
      try {
        // Use finalUrl from validation (already followed redirects once)
        enrichmentData = await performEnrichment(validation.finalUrl || business.website);
        console.log(`   📊 CMS: ${enrichmentData.cms} | Score: ${enrichmentData.score}`);
        console.log(`   🏷  Lead: ${enrichmentData.lead_type} / ${enrichmentData.lead_tag}`);
        console.log(`   ⚠️  Pain: ${enrichmentData.painPoints.join(", ") || "none"}`);
      } catch (err) {
        console.error(`   ❌ Enrichment failed: ${err.message}`);
        const fallback = noWebsiteEnrichment(business);
        enrichmentData = {
          ...fallback,
          hasWebsite:  false,
          sourceType:  "fetch_failed",
          lead_tag:    "fetch_failed",
          painPoints:  [...fallback.painPoints, "fetch_failed"],
        };
      }
    }
  }

  await saveEnrichment(business.id, business.website, enrichmentData);
  await db.execute(
    `UPDATE businesses SET enriched = 1, enriched_at = NOW() WHERE id = ?`,
    [business.id]
  );

  console.log(`   ✅ Saved.`);
  return { status: "success", business: business.name };
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKER LOOP
// ─────────────────────────────────────────────────────────────────────────────
async function startWorker() {
  await initDB();
  console.log("🚀 Enrichment Worker Started");

  while (true) {
    try {
      const result = await processNextBusiness();
      if (result.status === "done") {
        console.log("💤 Queue empty. Waiting 30s...");
        await new Promise((r) => setTimeout(r, 30_000));
      } else {
        await new Promise((r) => setTimeout(r, 5_000));
      }
    } catch (err) {
      console.error("🔥 Critical error:", err.message);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

startWorker();