require('dotenv').config();
const mysql = require('mysql2/promise');

async function insertDummyBusiness() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });

  console.log('✅ Connected to database');

  try {
    // Generate unique name with timestamp
    const timestamp = Date.now();
    const businessName = `Sparkle Home Cleaning ${timestamp}`;

    console.log(`Creating dummy business: ${businessName}`);

    // Delete previous test businesses
    const [deleted] = await db.execute(
      `DELETE FROM businesses WHERE name LIKE 'Sparkle Home Cleaning%'`
    );
    if (deleted.affectedRows > 0) {
      console.log(`🗑️  Deleted ${deleted.affectedRows} previous test business(es)`);
    }

    // Insert dummy cleaning business
    const [result] = await db.execute(`
      INSERT INTO businesses (
        name, phone, address, website, profile_url,
        keyword, location, enriched, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW())
    `, [
      businessName,
      '647-555-1234',
      '123 Main St, Toronto, ON M5V 1A1',
      'https://example.com',
      'https://www.yellowpages.ca/dummy',
      'Home Cleaning Services',
      'Toronto, ON'
    ]);

    console.log('✅ Dummy business inserted with ID:', result.insertId);

    // Verify
    const [rows] = await db.execute(
      `SELECT id, name, keyword, location, enriched, booking_analyzed
       FROM businesses WHERE id = ?`,
      [result.insertId]
    );

    console.log('\n📋 Business Details:');
    console.log(rows[0]);
    console.log('\n✅ Ready for testing! Run: node ca/bookingOutreach.js --test');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await db.end();
  }
}

insertDummyBusiness();
