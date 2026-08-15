// Supabase connection for the web app.
// These two values are SAFE to be public:
//   - the URL is not a secret
//   - the "publishable" (anon) key is designed for browsers; Row Level Security + login
//     are what actually protect the data. The SECRET key is NEVER used here.
window.VC_CONFIG = {
  SUPABASE_URL: 'https://lxeuvxkhieszizdclivg.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4ZXV2eGtoaWVzeml6ZGNsaXZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3NjUxNjQsImV4cCI6MjEwMjM0MTE2NH0.XEJ7Kc7IR-0suBeHFiLWhq_4PTgAXoVIIvFB9o2DkjU',
};
