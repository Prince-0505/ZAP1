// ============================================================
// zapfood_supabase.js  — Supabase config shared across all files
// ============================================================

const SUPABASE_URL  = 'https://mpoimbacmyeywwmeiyyg.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1wb2ltYmFjbXlleXd3bWVpeXlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NjE1MTEsImV4cCI6MjA5ODQzNzUxMX0.Ly5ZWJ40AEy81zKQh5lD1PDv4gJZuW3_ko8g_MkF_vQ';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON);
