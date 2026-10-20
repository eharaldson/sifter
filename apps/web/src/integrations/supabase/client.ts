import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

// The archived shopping interface can be inspected without an auth project.
// Configure your own public URL and anon key to enable account features.
export const supabase = url && key ? createClient<Database>(url, key, {
  auth: { storage: localStorage, persistSession: true, autoRefreshToken: true },
}) : null;
