import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// The /api/vote proxy endpoint and Google Sheets integration were removed
// because votes are now stored directly in Supabase. Keep a simple
// informational endpoint for health checks.
app.post('/api/vote', async (req, res) => {
  res.status(410).json({ success: false, error: 'Removed: use Supabase direct API via client' });
});

// Serve runtime config for the frontend. This allows the hosting environment
// to provide Supabase values at runtime (instead of build time) by setting
// environment variables on the server. The frontend will read this JSON and
// populate window.__PALPORRO_CONFIG so the client can initialize Supabase.
app.get('/palporro-config.json', (req, res) => {
  const config = {
    VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL || null,
    VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY || null,
    VITE_ENVIRONMENT: process.env.VITE_ENVIRONMENT || null
  };

  // Note: returning the anon key to the browser exposes it publicly. This is
  // the expected behaviour for Supabase client-side usage (anon keys are
  // intended for public use) but make sure you understand the security model.
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(config));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});