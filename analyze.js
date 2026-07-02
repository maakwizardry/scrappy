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
  console.log("OK Analysis DB connected");
}

// ---------------------------------------------
// NICHE PLAYBOOK
// ---------------------------------------------

function getNichePlaybook(keyword) {
  const k = (keyword || "").toLowerCase();

  if (k.includes("plumb")) {
    return [
      "NICHE: Plumbing",
      "",
      "Observation angle:",
      "  Customers likely have to call to schedule plumbing service -- no online booking visible.",
      "",
      "Business impact angle:",
      "  If someone visits after hours or while the team is on another job, there is a good chance",
      "  they will call another plumber instead.",
      "",
      "Solution angle:",
      "  We build websites with online booking, emergency service requests, photo uploads, and",
      "  automated confirmations so customers can schedule without waiting on the phone.",
      "",
      "CTA angle:",
      "  Would you be open to a quick 15-minute call next week to see if this could help your business?",
    ].join("\n");
  }

  if (
    k.includes("hvac") ||
    k.includes("heating") ||
    k.includes("cooling") ||
    k.includes("air condition")
  ) {
    return [
      "NICHE: HVAC",
      "",
      "Observation angle:",
      "  Customers still need to call to book HVAC service or maintenance -- no self-serve option visible.",
      "",
      "Business impact angle:",
      "  During peak heating and cooling seasons, every missed call can mean a lost installation",
      "  or service appointment.",
      "",
      "Solution angle:",
      "  We build booking systems that let customers schedule appointments online, request quotes,",
      "  sign up for maintenance plans, and receive automatic reminders.",
      "",
      "CTA angle:",
      "  Would you be open to a quick 15-minute conversation to see how this could work for your company?",
    ].join("\n");
  }

  if (k.includes("electric")) {
    return [
      "NICHE: Electrician",
      "",
      "Observation angle:",
      "  There is no simple way for customers to request electrical work online -- it all goes through a call.",
      "",
      "Business impact angle:",
      "  Many homeowners prefer requesting quotes online instead of calling during work hours,",
      "  and that friction can lead them to choose another contractor.",
      "",
      "Solution angle:",
      "  We build websites that let customers request estimates, upload photos, schedule appointments,",
      "  and automatically notify your team.",
      "",
      "CTA angle:",
      "  Would you be open to a brief 15-minute call to explore whether this would be useful?",
    ].join("\n");
  }

  if (k.includes("roof")) {
    return [
      "NICHE: Roofing",
      "",
      "Observation angle:",
      "  Homeowners have to call to request a roofing estimate -- no online request form visible.",
      "",
      "Business impact angle:",
      "  Roof replacements and repairs are high-value jobs, so making it easier to request an estimate",
      "  can help capture more qualified leads.",
      "",
      "Solution angle:",
      "  We build websites that allow homeowners to request inspections, upload roof photos, schedule",
      "  appointments, and submit insurance-related information online.",
      "",
      "CTA angle:",
      "  Would you be available for a quick 15-minute chat next week?",
    ].join("\n");
  }

  if (k.includes("landscap") || k.includes("lawn") || k.includes("garden")) {
    return [
      "NICHE: Landscaping",
      "",
      "Observation angle:",
      "  Customers cannot easily book landscaping services online -- the process seems to require a phone call.",
      "",
      "Business impact angle:",
      "  Many homeowners want to request lawn care or seasonal services outside business hours,",
      "  and a manual process can result in missed opportunities.",
      "",
      "Solution angle:",
      "  We build booking systems that automate scheduling, recurring maintenance, reminders,",
      "  and customer communication.",
      "",
      "CTA angle:",
      "  Would you be open to a short 15-minute conversation to see if this would fit your business?",
    ].join("\n");
  }

  // Fallback for unrecognised niches
  return [
    "NICHE: General local service business",
    "",
    "Observation angle:",
    "  Customers likely need to call to book or request a service -- no online option visible.",
    "",
    "Business impact angle:",
    "  Potential clients who cannot self-serve may move on to a competitor who lets them book instantly.",
    "",
    "Solution angle:",
    "  We build websites that let customers book, request quotes, and communicate without a phone call.",
    "",
    "CTA angle:",
    "  Would you be open to a quick 15-minute call to see if this would be a good fit?",
  ].join("\n");
}

// ---------------------------------------------
// PROMPT BUILDER
// ---------------------------------------------

function buildPrompt(business, e) {
  const nicheBlock = getNichePlaybook(business.keyword);

  return `
You are Rehan Kanak, Co-Founder of MaaK (https://maakhq.com), a web agency.

Write a short, direct cold email. No fluff. No filler. Get to the point fast.
The whole email must be under 100 words.

=== LEAD TAG (STRICT) ===
lead_tag tells you the ONE problem to mention. Do not invent others.

- no_website        -> no online presence at all
- no_booking_system -> customers must call to book
- not_mobile_friendly -> site is hard to use on mobile
- outdated_website  -> site looks behind modern standards
- established_site  -> mention one small improvement (light touch)

=== NICHE GUIDE ===
Use these angles. Adapt the language -- do not copy word-for-word.

${nicheBlock}

=== EMAIL FORMAT (EXACTLY 3 PARAGRAPHS) ===

Paragraph 1 -- Intro + what they are missing (2 sentences MAX)
Open with a quick, human intro -- who you are and that you took a look at their site.
Then state the ONE gap you noticed (use the niche observation angle). Keep it soft, not accusatory.

Paragraph 2 -- What we offer + how it helps them (2-3 sentences MAX)
First sentence MUST be exactly:
"We recently built a complex travel booking platform (https://best.so) from the ground up."

Then describe what you can build for them and the direct business benefit:
- no_website -> "We can build a similar online presence for your business -- so customers can find you, trust you, and reach out without picking up the phone."
- all others -> Use the niche solution angle + one concrete benefit in one clean sentence.

Paragraph 3 -- Outro + meeting link (1-2 sentences MAX)
Light, no-pressure close. Use the niche CTA angle.
Include: https://calendly.com/workwithmaak/maak-discovery-call

=== RULES ===
- Max 100 words total
- No bullet points in the email body
- No sign-off line
- Every sentence must earn its place -- cut anything that does not add value

=== OUTPUT FORMAT ===
Return JSON ONLY. You MUST use \\n\\n in the "body" to separate the 3 paragraphs. Do not output a single wall of text.

{
  "subject": "Thoughts on [Business Name]'s online setup",
  "body": "Paragraph 1 here\\n\\nParagraph 2 here\\n\\nParagraph 3 here"
}

=== BUSINESS DATA ===
Name: ${business.name}
Website: ${business.website || "None"}
Keyword: ${business.keyword || "general"}

=== ENRICHMENT DATA ===
${JSON.stringify(e, null, 2)}
`.trim();
}

// ---------------------------------------------
// MAIN FUNCTION
// ---------------------------------------------

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

    // forces valid JSON output
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

// ---------------------------------------------
// WORKER / SERVER INTEGRATION
// ---------------------------------------------

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
  console.log(`\n Analyzing: ${business.name} (${business.website || "No website"})`);

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

    const signature = `

Rehan Kanak
Co-Founded, MaaK
Quebec, Canada
rehan@maakhq.com
+1 (647) 472 7894`;

    const emailText = emailData.subject
      ? `Subject: ${emailData.subject}\n\n${emailData.body}${signature}`
      : `${emailData.body}${signature}`;

    await db.execute(
      `INSERT INTO business_analysis (business_id, website, generated_email, created_at) VALUES (?, ?, ?, NOW())`,
      [business.id, business.website, emailText]
    );

    await db.execute(
      `UPDATE businesses SET analyzed = 1, analyzed_at = NOW() WHERE id = ?`,
      [business.id]
    );

    console.log(`   OK Email generated and saved.`);
    return { status: "success", business: business.name };
  } catch (err) {
    console.error(`   ERROR Email generation failed: ${err.message}`);
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
  console.log("Analysis Job Queue Worker Started");

  while (true) {
    try {
      const result = await analyzeNext();
      if (result.status === "done") {
        console.log("Analysis queue empty. Waiting 30 seconds...");
        await new Promise((r) => setTimeout(r, 30000));
      } else {
        await new Promise((r) => setTimeout(r, 5000));
      }
    } catch (e) {
      console.error("Critical Queue Error:", e.message);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}

// Start worker if executed directly (e.g., node analyze.js)
if (require.main === module) {
  startWorker();
}

module.exports = { initDB, analyzeNext, generateOutreachEmail, buildPrompt, startWorker };