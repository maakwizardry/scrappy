-- Migration: Add booking outreach tracking columns
-- Date: 2026-07-17
-- Description: Adds columns to track booking page outreach processing

-- Add columns to businesses table
ALTER TABLE businesses
ADD COLUMN booking_analyzed TINYINT(1) DEFAULT 0 COMMENT 'Processed by booking outreach worker',
ADD COLUMN booking_analyzed_at TIMESTAMP NULL;

-- Add columns to business_analysis table
ALTER TABLE business_analysis
ADD COLUMN booking_api_processed TINYINT(1) DEFAULT 0,
ADD COLUMN booking_api_provider_id INT NULL,
ADD COLUMN booking_api_provider_slug VARCHAR(255) NULL,
ADD COLUMN booking_template_used VARCHAR(100) NULL COMMENT 'Which template was randomly selected';

-- Add index for efficient queries
CREATE INDEX idx_booking_analyzed ON businesses(booking_analyzed);
CREATE INDEX idx_booking_api_processed ON business_analysis(booking_api_processed);
