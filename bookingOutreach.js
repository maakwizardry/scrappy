require('dotenv').config();
const mysql = require('mysql2/promise');
const { BookingApiClient } = require('./bookingApiClient');

let db;
const apiClient = new BookingApiClient();

/**
 * Initialize database connection
 */
async function initDB() {
  if (db) return;

  db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });

  console.log('✅ Booking Outreach DB connected');
}

/**
 * Randomly select one of the message templates
 * @param {Array} templates - Array of message templates
 * @returns {Object} Selected template and its index
 */
function selectRandomTemplate(templates) {
  if (!Array.isArray(templates) || templates.length === 0) {
    throw new Error('No templates available');
  }

  const randomIndex = Math.floor(Math.random() * Math.min(templates.length, 3));
  return {
    template: templates[randomIndex],
    label: templates[randomIndex].label,
    index: randomIndex
  };
}

/**
 * Build email from template using existing 3-paragraph format
 * @param {Object} business - Business data
 * @param {Object} template - Selected message template
 * @param {Object} provider - Provider data from API
 * @returns {Object} Email subject and body
 */
function buildEmail(business, template, provider) {
  const bookingUrl = `https://letsbook.maakhq.com/business/${provider.slug}`;
  const calendlyUrl = 'https://calendly.com/workwithmaak/maak-discovery-call';

  // Signature block (from analyze.js:308-314)
  const signature = `

Rehan Kanak
Co-Founded, MaaK
Quebec, Canada
rehan@maakhq.com
+1 (647) 472 7894`;

  // Use template message as the core body
  let body = template.message;

  // Ensure booking URL is present
  if (!body.includes(bookingUrl)) {
    body = body.replace(
      /https:\/\/letsbook\.maakhq\.com\/business\/[a-z0-9-]+/gi,
      bookingUrl
    );
  }

  // Ensure Calendly link is in the email
  if (!body.includes('calendly.com')) {
    // Split into paragraphs
    const paragraphs = body.split('\n\n');

    // Add CTA to last paragraph
    const lastParagraph = paragraphs[paragraphs.length - 1];

    // Remove the generic closing if present, replace with Calendly CTA
    paragraphs[paragraphs.length - 1] = lastParagraph.replace(
      /No pressure at all.*$/s,
      `No pressure at all — would you be open to a quick 15-minute call to see if this could help?\n\nHere's my calendar: ${calendlyUrl}`
    );

    body = paragraphs.join('\n\n');
  }

  const subject = `I built a booking page for ${business.name}`;

  return {
    subject,
    body,
    fullEmail: `Subject: ${subject}\n\n${body}${signature}`
  };
}

/**
 * Process the next business for booking outreach
 * @returns {Object} Processing result
 */
async function processNextBookingLead() {
  if (!db) await initDB();

  // Query for qualified home cleaning service businesses ONLY
  // Exact matching for: Residential Cleaning Services, Home Cleaning Services,
  // Maid Service, Deep Cleaning Service, House Cleaning Service
  const [rows] = await db.execute(`
    SELECT b.*, e.pain_points, e.lead_tag, e.lead_type
    FROM businesses b
    LEFT JOIN business_enrichment e ON b.id = e.business_id
    WHERE b.enriched = 1
      AND b.booking_analyzed = 0
      AND b.email IS NOT NULL
      AND b.email != ''
      AND (b.keyword IN ('Residential Cleaning Services', 'Home Cleaning Services', 'Maid Service', 'House Cleaning Service', 'Deep Cleaning Service')
           OR b.name IN ('Residential Cleaning Services', 'Home Cleaning Services', 'Maid Service', 'House Cleaning Service', 'Deep Cleaning Service'))
    ORDER BY b.created_at ASC
    LIMIT 1
  `);

  if (rows.length === 0) {
    return {
      status: 'done',
      message: 'No businesses left to process for booking outreach'
    };
  }

  const business = rows[0];
  console.log(`\n📋 Processing booking outreach: ${business.name}`);

  try {
    // Call booking API with retry logic
    console.log('   -> Fetching templates from booking API...');
    const apiResponse = await apiClient.retryWithBackoff(
      () => apiClient.getProviderTemplates(business.name)
    );

    console.log(`   -> Provider created: ${apiResponse.provider.slug} (ID: ${apiResponse.provider.id})`);

    // Random template selection
    const { template, label, index } = selectRandomTemplate(apiResponse.templates);
    console.log(`   -> Selected template: "${label}" (${index + 1}/3)`);

    // Generate email
    console.log('   -> Generating email...');
    const emailData = buildEmail(business, template, apiResponse.provider);

    // Save to database
    await db.execute(`
      INSERT INTO business_analysis (
        business_id,
        website,
        generated_email,
        booking_api_processed,
        booking_api_provider_id,
        booking_api_provider_slug,
        booking_template_used,
        created_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, NOW())
    `, [
      business.id,
      business.website || business.name,
      emailData.fullEmail,
      apiResponse.provider.id,
      apiResponse.provider.slug,
      label
    ]);

    // Mark as processed
    await db.execute(`
      UPDATE businesses
      SET booking_analyzed = 1, booking_analyzed_at = NOW()
      WHERE id = ?
    `, [business.id]);

    console.log('   ✅ Booking outreach email generated and saved.');

    return {
      status: 'success',
      business: business.name,
      provider_slug: apiResponse.provider.slug,
      template_used: label
    };

  } catch (err) {
    console.error(`   ❌ ERROR: ${err.message || JSON.stringify(err)}`);

    // Mark as processed even on error to avoid infinite retries
    // (unless it's a retryable error like rate limiting)
    if (!err.retryable) {
      console.log('   -> Marking as processed to avoid retry loop');
      await db.execute(`
        UPDATE businesses
        SET booking_analyzed = 1, booking_analyzed_at = NOW()
        WHERE id = ?
      `, [business.id]);
    }

    return {
      status: 'error',
      business: business.name,
      reason: err.message || err.type || 'Unknown error'
    };
  }
}

/**
 * Start the worker loop
 */
async function startWorker() {
  await initDB();
  console.log('🚀 Booking Outreach Worker Started');
  console.log('   Processing home service businesses for booking page outreach');
  console.log('');

  while (true) {
    try {
      const result = await processNextBookingLead();

      if (result.status === 'done') {
        console.log('⏸️  Queue empty. Waiting 30 seconds...');
        await new Promise(r => setTimeout(r, 30000));
      } else if (result.status === 'error') {
        // Slower retry on errors
        console.log('   Waiting 10 seconds before next attempt...');
        await new Promise(r => setTimeout(r, 10000));
      } else {
        // Rate limiting: wait between successful API calls
        console.log('   Waiting 5 seconds (rate limiting)...');
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e) {
      console.error('🔥 Critical Queue Error:', e.message);
      console.error(e.stack);
      await new Promise(r => setTimeout(r, 15000));
    }
  }
}

// Test mode: process a single business
if (process.argv[2] === '--test') {
  (async () => {
    console.log('🧪 TEST MODE: Processing single business\n');
    await initDB();
    const result = await processNextBookingLead();
    console.log('\n📊 Result:', JSON.stringify(result, null, 2));

    if (result.status === 'success') {
      // Fetch and display the generated email
      const [emailRows] = await db.execute(`
        SELECT generated_email
        FROM business_analysis
        WHERE booking_api_provider_slug = ?
        LIMIT 1
      `, [result.provider_slug]);

      if (emailRows.length > 0) {
        console.log('\n📧 Generated Email:');
        console.log('─'.repeat(80));
        console.log(emailRows[0].generated_email);
        console.log('─'.repeat(80));
      }
    }

    await db.end();
    process.exit(0);
  })();
}
// Production mode: start worker loop
else if (require.main === module) {
  startWorker();
}

module.exports = { initDB, processNextBookingLead, startWorker };
