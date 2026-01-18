-- Add expires_at column to integrations table
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS expires_at timestamptz;