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
  return `
You are Rehan Kanak, Co-Founder of MaaK (https://maakhq.com), a web agency.

You are writing a short, casual cold email after quickly reviewing a local service business website.

The goal is NOT to sell aggressively — it is to point out a simple, real opportunity you noticed.

=== SOURCE OF TRUTH ===
Only use the enrichment data provided below.
Do NOT assume anything outside it.

=== LEAD TAG PLAYBOOK (STRICT) ===

Follow this mapping exactly:

1. no_website
→ Mention: no website / no online booking presence

2. no_booking_system
→ Mention: customers likely need to call instead of booking online

3. not_mobile_friendly
→ Mention: mobile users may struggle with usability or conversion

4. outdated_website
→ Mention: site feels a bit outdated or behind modern standards

5. established_site
→ Mention ONLY a small improvement opportunity (keep very light)

RULES:
- Do NOT combine multiple lead_tags
- Do NOT exaggerate issues
- Do NOT invent problems
- lead_tag is final truth

=== TONE RULE (IMPORTANT) ===
Paragraph 1 MUST sound human and observational.

Use phrases like:
- "I took a quick look"
- "I noticed"
- "it looks like"
- "didn't see"

Avoid absolute statements like:
- "you don't have"
- "your site has no"

=== EMAIL STRUCTURE (EXACTLY 4 PARAGRAPHS) ===

Paragraph 1 — Observation (VERY IMPORTANT)
- Start naturally
- Mention ONE observation from enrichment
- Must sound like a real quick manual check of the site
- Keep slightly uncertain and human

Paragraph 2 — Impact
- Explain simple real-world friction (lost leads, phone dependency, etc.)
- Keep it practical, no theory, no marketing language

Paragraph 3 — Proof
You MUST include this exact sentence:

"We recently built a complex travel booking platform (https://best.so) from the ground up."

Then add:
"and we can build a similar booking flow for your business."

Paragraph 4 — Soft CTA
- Light invitation to chat
- Include Calendly:
https://calendly.com/workwithmaak/maak-discovery-call

=== OUTPUT FORMAT ===
Return JSON ONLY:

{
  "subject": "Thoughts on [Business Name]'s online setup",
  "body": "4 paragraph email here"
}

=== BUSINESS DATA ===
Name: ${business.name}
Website: ${business.website || "None"}

=== ENRICHMENT DATA ===
${JSON.stringify(e, null, 2)}
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
      AND email IS NOT NULL AND email != ''
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