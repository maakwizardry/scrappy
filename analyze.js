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

Write a personalized cold outreach email that feels like a real founder casually pointing out an opportunity after reviewing their business.

=== YOUR STRATEGY ===
Below is the complete JSON profile of the business, including their technical website stack, missing elements (pain points), and their online setup.
Your job is to analyze this data, figure out the most glaring weakness or the biggest opportunity, and formulate a highly personalized pitch around it. 
- If they don't have a website but are a service business, pitch a new site with an automated booking system.
- If their site looks established but lacks a booking system, pitch integrating a seamless booking flow to stop losing leads.
- If their site is outdated or missing mobile optimization, pitch a modernization.
- Pick the SINGLE most compelling angle based on the data. Do NOT overwhelm them with multiple problems.

=== EMAIL FORMATTING STRUCTURE ===
The email MUST be formatted into exactly 4 distinct, separated paragraphs. Do not merge them into one block of text.

Paragraph 1: Introduction & Hook
- Get straight to the point. No "I hope this finds you well."
- Point out the specific issue or opportunity (the "pain point") you found on their site or lack thereof.

Paragraph 2: The Pain Point Expansion
- Briefly explain why this issue is costing them leads or hurting trust, then pitch the value of your solution.

Paragraph 3: Social Proof & Example
- Casually mention our past project to build authority.
- CRITICAL: You MUST use this exact example without altering the industry: "We recently built a complex travel booking platform (https://best.so) from the ground up." 
- Do NOT claim best.so is a plumbing, roofing, or local service site. It is strictly a travel booking platform. 
- You can relate it back to them by saying something like "and we can build a similar robust booking flow for your business."

Paragraph 4: Booking Call
- Soft invite for a quick chat (e.g., "Open to a quick chat?", "Worth exploring?").
- Include your Calendly link naturally: https://calendly.com/workwithmaak/maak-discovery-call

=== STRICT RULES ===
- Subject line: Must be specific to them (e.g., "Thoughts on [Business Name]'s online setup"). Avoid generic subjects.
- Tone: Direct, peer-to-peer, confident, grounded. No hype words (transform, massive, game-changing). No "agency" jargon.
- Sign off as:
  Rehan Kanak
  Co-Founder, MaaK
  https://maakhq.com

=== BUSINESS CONTEXT ===
Business Name: ${business.name}
Website: ${business.website || "None"}

Raw Enrichment Data:
${JSON.stringify(e, null, 2)}

=== OUTPUT FORMAT ===
Return JSON ONLY:
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