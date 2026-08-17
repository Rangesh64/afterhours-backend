const { Pool } = require('pg');
require('dotenv').config();

// Create PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Supabase cloud connection
  }
});

// Test Database Connection
pool.connect((err, client, release) => {
  if (err) {
    return console.error('Database connection error ❌:', err.stack);
  }
  console.log('Successfully connected to Supabase PostgreSQL Database ⚡');
  release();
});

module.exports = pool;
