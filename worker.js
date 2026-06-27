require("dotenv").config();
const mysql = require("mysql2/promise");
const { performEnrichment } = require("./enrichment");
const { analyzeNext } = require("./analyze"); // we'll still use analyzeNext or we can re-implement it here
// Wait, analyze.js analyzeNext currently looks for enriched=1 and analyzed=0.
// Let's create a custom loop here since we want to do both steps in sequence for a business.
const axios = require("axios");

let db;

async function initDB() {
  db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });
  console.log("✅ Worker DB connected");
}

async function generateEmailWorker(business, enrichment) {
  const hasWebsite = !!business.website;
  const pitchInstruction = hasWebsite
    ? "short pitch (we can rebuild/improve your site at MaaK. Mention this case study: Recently, we helped a US-based company build their travel booking platform (https://best.so) from the ground up - including complex booking flows, third-party integrations, and performance optimization.)"
    : "short pitch (since they do not have a website, pitch that we can build them a beautiful, high-converting website from scratch at MaaK to establish their online presence. Mention this case study: Recently, we helped a US-based company build their travel booking platform (https://best.so) from the ground up.)";

  const prompt = `
You are a sales expert.

Write a short cold outreach email for my web development agency, MaaK (https://maakhq.com).
I am Rehan Kanak, the Co-Founder. My email is rehan@maakhq.com.

Business Info:
Name: ${business.name}
Website: ${business.website || "No website"}
Phone: ${business.phone}
Address: ${business.address}

Website Analysis:
Title: ${enrichment.title}
Meta: ${enrichment.meta_description}
H1: ${enrichment.h1}
Score: ${enrichment.score}

Observations:
- WordPress: ${enrichment.is_wordpress}
- Shopify: ${enrichment.is_shopify}
- Has Contact Page: ${enrichment.has_contact_page}
- Has Email: ${enrichment.has_email}
- Has Phone: ${enrichment.has_phone}
- CTA Count: ${enrichment.cta_count}

Write:
1. 1 line business insight
2. ${hasWebsite ? "2 pain points about their website" : "Point out they are missing out on online leads by not having a website"}
3. ${pitchInstruction}
4. email closing (Sign off as Rehan Kanak, Co-Founder at MaaK)

Keep it under 150 words.
`;

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    }
  );

  return response.data.choices[0].message.content;
}

async function processNextBusiness() {
  // 1. Find next un-analyzed business
  const [rows] = await db.execute(`
    SELECT * FROM businesses
    WHERE analyzed = 0
    ORDER BY created_at ASC
    LIMIT 1
  `);

  if (rows.length === 0) {
    return { status: "done", message: "No businesses left to analyze" };
  }

  const business = rows[0];
  console.log(`\n⏳ Processing: ${business.name} (${business.website || 'No website'})`);

  let enrichmentData = null;

  // 2. Perform Enrichment if not already enriched
  if (business.enriched === 0) {
    if (!business.website) {
      console.log(`   -> No website found. Storing fallback enrichment data...`);
      enrichmentData = {
        finalUrl: null, sourceType: "unknown", title: "N/A", metaDescription: "N/A", h1: "N/A",
        isWordPress: false, isShopify: false, hasEmail: false, hasPhone: false, hasForm: false,
        hasContactPage: false, score: 0, lead_type: "web_design_lead", lead_tag: "no_website",
        pageText: "", internalLinks: 0, imagesCount: 0, ctaCount: 0, socialLinks: []
      };
      
      await db.execute(
        `
        INSERT INTO business_enrichment (
          business_id, website, final_url, source_type, title, meta_description, h1,
          is_wordpress, is_shopify, has_email, has_phone, has_form,
          has_contact_page, score, lead_type, lead_tag, services_text,
          all_text, internal_links_count, images_count, cta_count, social_links
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          business.id, business.website, enrichmentData.finalUrl, enrichmentData.sourceType, enrichmentData.title,
          enrichmentData.metaDescription, enrichmentData.h1, enrichmentData.isWordPress, enrichmentData.isShopify,
          enrichmentData.hasEmail, enrichmentData.hasPhone, enrichmentData.hasForm, enrichmentData.hasContactPage,
          enrichmentData.score, enrichmentData.lead_type, enrichmentData.lead_tag, null,
          enrichmentData.pageText, enrichmentData.internalLinks, enrichmentData.imagesCount, enrichmentData.ctaCount,
          JSON.stringify(enrichmentData.socialLinks)
        ]
      );
      await db.execute(`UPDATE businesses SET enriched = 1, enriched_at = NOW() WHERE id = ?`, [business.id]);
      console.log(`   ✅ Fallback enrichment saved.`);
    } else {
      try {
        console.log(`   -> Enriching website...`);
        enrichmentData = await performEnrichment(business.website);
        
        // Save enrichment data
        await db.execute(
          `
          INSERT INTO business_enrichment (
            business_id, website, final_url, source_type, title, meta_description, h1,
            is_wordpress, is_shopify, has_email, has_phone, has_form,
            has_contact_page, score, lead_type, lead_tag, services_text,
            all_text, internal_links_count, images_count, cta_count, social_links
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            business.id, business.website, enrichmentData.finalUrl, enrichmentData.sourceType, enrichmentData.title,
            enrichmentData.metaDescription, enrichmentData.h1, enrichmentData.isWordPress, enrichmentData.isShopify,
            enrichmentData.hasEmail, enrichmentData.hasPhone, enrichmentData.hasForm, enrichmentData.hasContactPage,
            enrichmentData.score, enrichmentData.lead_type, enrichmentData.lead_tag, null,
            enrichmentData.pageText, enrichmentData.internalLinks, enrichmentData.imagesCount, enrichmentData.ctaCount,
            JSON.stringify(enrichmentData.socialLinks)
          ]
        );
        await db.execute(`UPDATE businesses SET enriched = 1, enriched_at = NOW() WHERE id = ?`, [business.id]);
        console.log(`   ✅ Enrichment saved.`);
      } catch (err) {
        console.error(`   ❌ Enrichment failed:`, err);
        await db.execute(`UPDATE businesses SET enriched = 1, enriched_at = NOW() WHERE id = ?`, [business.id]);
        // proceed to email generation
      }
    }
  } else {
    console.log(`   -> Already enriched, fetching data...`);
    // Fetch by business_id instead of website to be safe (handles no-website cases too)
    const [enrichRows] = await db.execute(`SELECT * FROM business_enrichment WHERE business_id = ? ORDER BY id DESC LIMIT 1`, [business.id]);
    if (enrichRows.length > 0) {
      enrichmentData = enrichRows[0];
    }
  }

  // Provide fallback enrichment data for prompt safety
  enrichmentData = enrichmentData || {
    title: "N/A", meta_description: "N/A", h1: "N/A", score: 0,
    is_wordpress: false, is_shopify: false, has_contact_page: false,
    has_email: false, has_phone: false, cta_count: 0
  };

  // 3. Perform Analysis (Email Gen)
  try {
    console.log(`   -> Generating email...`);
    const email = await generateEmailWorker(business, enrichmentData);

    await db.execute(
      `INSERT INTO business_analysis (business_id, website, generated_email, created_at) VALUES (?, ?, ?, NOW())`,
      [business.id, business.website, email]
    );
    await db.execute(`UPDATE businesses SET analyzed = 1, analyzed_at = NOW() WHERE id = ?`, [business.id]);
    console.log(`   ✅ Email generated and saved.`);
    
    return { status: "success", business: business.name };
  } catch (err) {
    console.error(`   ❌ Email generation failed: ${err.message}`);
    // If AI fails, we might want to keep analyzed=0 to retry later, or mark analyzed=1 to skip. Let's skip for now.
    await db.execute(`UPDATE businesses SET analyzed = 1, analyzed_at = NOW() WHERE id = ?`, [business.id]);
    return { status: "error", reason: "ai failed" };
  }
}

async function startWorker() {
  await initDB();
  console.log("🚀 Job Queue Worker Started");
  
  while (true) {
    try {
      const result = await processNextBusiness();
      if (result.status === "done") {
        console.log("💤 Queue empty. Waiting 30 seconds...");
        await new Promise(r => setTimeout(r, 30000));
      } else {
        // Wait a short time between jobs to avoid rate limits
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e) {
      console.error("🔥 Critical Queue Error:", e.message);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

startWorker();
