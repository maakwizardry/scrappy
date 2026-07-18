require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');

async function runMigration() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    multipleStatements: true  // Allow multiple SQL statements
  });

  console.log('✅ Connected to database');

  try {
    console.log('📝 Running migration...\n');

    // Run ALTER TABLE for businesses
    console.log('▶ Adding columns to businesses table...');
    try {
      await db.execute(`
        ALTER TABLE businesses
        ADD COLUMN booking_analyzed TINYINT(1) DEFAULT 0 COMMENT 'Processed by booking outreach worker',
        ADD COLUMN booking_analyzed_at TIMESTAMP NULL
      `);
      console.log('  ✅ Success');
    } catch (err) {
      if (err.message.includes('Duplicate column name')) {
        console.log('  ℹ️  Columns already exist, skipping');
      } else {
        throw err;
      }
    }

    // Run ALTER TABLE for business_analysis
    console.log('\n▶ Adding columns to business_analysis table...');
    try {
      await db.execute(`
        ALTER TABLE business_analysis
        ADD COLUMN booking_api_processed TINYINT(1) DEFAULT 0,
        ADD COLUMN booking_api_provider_id INT NULL,
        ADD COLUMN booking_api_provider_slug VARCHAR(255) NULL,
        ADD COLUMN booking_template_used VARCHAR(100) NULL COMMENT 'Which template was randomly selected'
      `);
      console.log('  ✅ Success');
    } catch (err) {
      if (err.message.includes('Duplicate column name')) {
        console.log('  ℹ️  Columns already exist, skipping');
      } else {
        throw err;
      }
    }

    // Create indexes
    console.log('\n▶ Creating index on businesses(booking_analyzed)...');
    try {
      await db.execute('CREATE INDEX idx_booking_analyzed ON businesses(booking_analyzed)');
      console.log('  ✅ Success');
    } catch (err) {
      if (err.message.includes('Duplicate key name')) {
        console.log('  ℹ️  Index already exists, skipping');
      } else {
        throw err;
      }
    }

    console.log('\n▶ Creating index on business_analysis(booking_api_processed)...');
    try {
      await db.execute('CREATE INDEX idx_booking_api_processed ON business_analysis(booking_api_processed)');
      console.log('  ✅ Success');
    } catch (err) {
      if (err.message.includes('Duplicate key name')) {
        console.log('  ℹ️  Index already exists, skipping');
      } else {
        throw err;
      }
    }

    console.log('\n✅ Migration completed successfully!');

    // Verify the changes
    console.log('\n📊 Verifying businesses table:');
    const [businessCols] = await db.execute('DESCRIBE businesses');
    const bookingCols = businessCols.filter(c => c.Field.includes('booking'));
    bookingCols.forEach(col => {
      console.log(`  - ${col.Field}: ${col.Type} (${col.Null === 'YES' ? 'nullable' : 'required'})`);
    });

    console.log('\n📊 Verifying business_analysis table:');
    const [analysisCols] = await db.execute('DESCRIBE business_analysis');
    const apiCols = analysisCols.filter(c => c.Field.includes('booking'));
    apiCols.forEach(col => {
      console.log(`  - ${col.Field}: ${col.Type} (${col.Null === 'YES' ? 'nullable' : 'required'})`);
    });

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error(error.stack);
  } finally {
    await db.end();
  }
}

runMigration();
