const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const createTables = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id         SERIAL PRIMARY KEY,
        username   VARCHAR(50)  UNIQUE NOT NULL,
        email      VARCHAR(100) UNIQUE NOT NULL,
        password   TEXT         NOT NULL,
        created_at TIMESTAMPTZ  DEFAULT NOW()
      );
    `);
    console.log('✅ Users table ready');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        room       VARCHAR(100) NOT NULL,
        content    TEXT         NOT NULL,
        is_deleted BOOLEAN      DEFAULT FALSE,
        is_edited  BOOLEAN      DEFAULT FALSE,
        created_at TIMESTAMPTZ  DEFAULT NOW()
      );
    `);
    console.log('✅ Messages table ready');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        token      TEXT         NOT NULL,
        created_at TIMESTAMPTZ  DEFAULT NOW()
      );
    `);
    console.log('✅ Refresh tokens table ready');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS reactions (
        id         SERIAL PRIMARY KEY,
        message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id)    ON DELETE CASCADE,
        emoji      VARCHAR(10) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (message_id, user_id, emoji)
      );
    `);
    console.log('✅ Reactions table ready');

    // Migrate existing tables
    await pool.query(`
      ALTER TABLE messages
        ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS is_edited  BOOLEAN DEFAULT FALSE;
    `);
    console.log('✅ Messages columns up to date');

    console.log('🎉 All tables ready!');
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await pool.end();
  }
};

createTables();