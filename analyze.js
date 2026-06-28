/**
 * analyze.js
 *
 * Takes enrichment data from business_enrichment and generates a
 * highly personalized cold email using the OpenAI API.
 *
 * It can be run as a standalone worker or required by a server.
 */

require("dotenv").config();
const OpenAI = require("openai");
const mysql = require("mysql2/promise");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

let db;

async function initDB() {
  if (db) return;
  db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });
  console.log("✅ Analysis DB connected");
}

// ─────────────────────────────────────────────
// PROMPT BUILDER
// ─────────────────────────────────────────────

function buildPrompt(business, e) {
  const currentYear = new Date().getFullYear();

  const painLines = [];

  if (e.lead_tag === "no_website") {
    painLines.push("They have NO website at all — massive opportunity.");
  }
  if (e.copyrightYear && e.copyrightYear < 2020) {
    painLines.push(`Their site copyright shows ${e.copyrightYear} — likely very outdated.`);
  }
  if (e.painPoints?.includes("not_mobile_optimized")) {
    painLines.push("The site is NOT mobile-optimized (missing viewport meta tag).");
  }
  if (!e.hasAnalytics) {
    painLines.push("No analytics tracking detected — they're flying blind on traffic.");
  }
  if (e.cms === "wix" || e.cms === "squarespace") {
    painLines.push(`Site is built on ${e.cms} — often a sign of a business ready to upgrade.`);
  }
  if (!e.chatWidget) {
    painLines.push("No live chat widget — missing real-time lead capture.");
  }
  if (!e.hasBlog) {
    painLines.push("No blog/content section — zero SEO content strategy.");
  }
  if (!e.hasTestimonials) {
    painLines.push("No testimonials or social proof visible on the site.");
  }
  if (e.painPoints?.includes("weak_copy_lorem_ipsum")) {
    painLines.push("Placeholder lorem ipsum text still visible on the site!");
  }

  const hasLines = [];
  if (e.hasAnalytics) hasLines.push("analytics tracking");
  if (e.chatWidget) hasLines.push(`${e.chatWidget} chat`);
  if (e.hasBlog) hasLines.push("a blog");
  if (e.hasTestimonials) hasLines.push("testimonials");
  if (e.hasPricingPage) hasLines.push("a pricing page");

  const servicesStr = e.servicesOrProducts?.length
    ? e.servicesOrProducts.slice(0, 6).join(", ")
    : "not clearly listed";

  return `
You are Rehan Kanak, Co-Founder of MaaK (https://maakhq.com).

Write cold outreach emails that feel like a real founder casually pointing out a website issue after a quick review.

The email should feel natural, slightly conversational, and not overly structured.

---

=== CORE STYLE RULES ===
- 3 to 4 short paragraphs max (not bullet points, not long blocks)
- Each paragraph should be 1–3 sentences
- No marketing or agency language
- No hype words (transform, massive, crucial, game-changing, etc.)
- No overly direct “sales pitch” tone
- Not too short, not too long
- Should feel like a thoughtful observation, not a pitch

---

=== TONE ===
- Founder-to-founder
- Calm, grounded, observant
- Slightly informal but professional
- Like you’re commenting after quickly checking their site

---

=== STRUCTURE (FLEXIBLE) ===

Paragraph 1:
- One specific observation about their website (ONLY ONE issue)

Paragraph 2:
- Light explanation of what that usually affects (trust, leads, clarity, etc.)
- Keep it subtle, not exaggerated

Paragraph 3:
- Mention one relevant experience/case study naturally:
"We recently built a travel booking platform (https://best.so) with complex flows and integrations."

Paragraph 4:
- Soft invite to a 15-minute call
- Include Calendly link naturally:
https://calendly.com/workwithmaak/maak-discovery-call

---

=== BUSINESS DATA ===
Name: ${business.name}
Website: ${business.website || "None"}

Pick ONE issue from:
${painLines.length ? painLines.slice(0,1).join("\n") : "missing analytics / weak trust signals"}

---

=== STRICT RULES ===
- Only ONE issue per email
- No multiple problems
- No over-explaining
- No hype language
- No “marketing voice”
- No long intros or conclusions

---

=== OUTPUT FORMAT ===
Return JSON only:
{
  "subject": "...",
  "body": "..."
}
`.trim();
}

// ─────────────────────────────────────────────
// MAIN FUNCTION
// ─────────────────────────────────────────────

async function generateOutreachEmail(business, enrichment) {
  const prompt = buildPrompt(business, enrichment);

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.7,

    // 🔥 forces valid JSON output
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0]?.message?.content || "{}";

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { subject: null, body: raw };
  }

  return {
    subject: parsed.subject || null,
    body: parsed.body || null,
    meta: {
      lead_type: enrichment.lead_type || "unknown",
      lead_tag: enrichment.lead_tag || "unknown",
      score: enrichment.score || 0,
      pain_count: enrichment.painPoints?.length || 0,
    },
  };
}

// ─────────────────────────────────────────────
// WORKER / SERVER INTEGRATION
// ─────────────────────────────────────────────

async function analyzeNext() {
  if (!db) await initDB();

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
  console.log(`\n⏳ Analyzing: ${business.name} (${business.website || "No website"})`);

  let enrichmentData = {};
  const [enrichRows] = await db.execute(
    `SELECT * FROM business_enrichment WHERE business_id = ? ORDER BY id DESC LIMIT 1`,
    [business.id]
  );
  if (enrichRows.length > 0) {
    enrichmentData = enrichRows[0];
  }

  try {
    console.log(`   -> Generating email...`);
    const emailData = await generateOutreachEmail(business, enrichmentData);
    
    const emailText = emailData.subject 
      ? `Subject: ${emailData.subject}\n\n${emailData.body}`
      : emailData.body;

    await db.execute(
      `INSERT INTO business_analysis (business_id, website, generated_email, created_at) VALUES (?, ?, ?, NOW())`,
      [business.id, business.website, emailText]
    );

    await db.execute(
      `UPDATE businesses SET analyzed = 1, analyzed_at = NOW() WHERE id = ?`,
      [business.id]
    );

    console.log(`   ✅ Email generated and saved.`);
    return { status: "success", business: business.name };
  } catch (err) {
    console.error(`   ❌ Email generation failed: ${err.message}`);
    // Mark as analyzed so we don't infinitely retry failed queries
    await db.execute(
      `UPDATE businesses SET analyzed = 1, analyzed_at = NOW() WHERE id = ?`,
      [business.id]
    );
    return { status: "error", reason: err.message };
  }
}

async function startWorker() {
  await initDB();
  console.log("🚀 Analysis Job Queue Worker Started");
  
  while (true) {
    try {
      const result = await analyzeNext();
      if (result.status === "done") {
        console.log("💤 Analysis queue empty. Waiting 30 seconds...");
        await new Promise(r => setTimeout(r, 30000));
      } else {
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e) {
      console.error("🔥 Critical Queue Error:", e.message);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

// Start worker if executed directly (e.g., node analyze.js)
if (require.main === module) {
  startWorker();
}

module.exports = { initDB, analyzeNext, generateOutreachEmail, buildPrompt, startWorker };