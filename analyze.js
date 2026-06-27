const mysql = require("mysql2/promise");
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
}

// ---------------- AI EMAIL GENERATION ----------------
async function generateEmail(business, enrichment) {
const prompt = `
You are a sales expert.

Write a short cold outreach email for my web development agency, MaaK (https://maakhq.com).
I am Rehan Kanak, the Co-Founder. My email is rehan@maakhq.com.

Business Info:
Name: ${business.name}
Website: ${business.website}
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
2. 2 pain points about their website
3. short pitch (we can rebuild/improve your site at MaaK. Mention this case study: Recently, we helped a US-based company build their travel booking platform (https://best.so) from the ground up - including complex booking flows, third-party integrations, and performance optimization.)
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

// ---------------- ANALYZE NEXT BUSINESS ----------------
async function analyzeNext() {
  const [rows] = await db.execute(`
    SELECT * FROM businesses
    WHERE enriched = 1 AND analyzed = 0
    ORDER BY created_at ASC
    LIMIT 1
  `);

  if (rows.length === 0) {
    return { status: "done", message: "No businesses left to analyze" };
  }

  const business = rows[0];

  const [enrichRows] = await db.execute(
    `SELECT * FROM business_enrichment WHERE website = ? ORDER BY id DESC LIMIT 1`,
    [business.website]
  );

  if (enrichRows.length === 0) {
    return { status: "skip", reason: "no enrichment found" };
  }

  const enrichment = enrichRows[0];

  const email = await generateEmail(business, enrichment);

  await db.execute(
    `
    INSERT INTO business_analysis
    (
      business_id,
      website,
      generated_email,
      created_at
    )
    VALUES (?, ?, ?, NOW())
    `,
    [business.id, business.website, email]
  );

  await db.execute(
    `UPDATE businesses SET analyzed = 1, analyzed_at = NOW() WHERE id = ?`,
    [business.id]
  );

  return {
    status: "success",
    business: business.name,
    email
  };
}

module.exports = { initDB, analyzeNext };
