// supabase.js — thin REST wrapper for the task_completions table.
// Wrapped in an IIFE so nothing leaks to global scope except window.NOW_DB.
(() => {
  'use strict';

  // These two values are the ONLY things you ever need to edit here.
  // The anon / publishable key is safe to ship in frontend code — that's its
  // purpose. Access is constrained by the RLS policies in schema.sql.
  const SUPABASE_URL = 'https://zwzndwbcksggntlvgdag.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_PLn7duaO9t8etMfjbEMmWQ_e7vVvi9e';

  const REST = `${SUPABASE_URL}/rest/v1/task_completions`;

  // New-style publishable keys still ride on both headers for the REST API.
  const HEADERS = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  // Returns an array of task_key strings completed on `dateKey` (YYYY-MM-DD),
  // or null if the request failed (caller treats null as "offline, skip").
  async function fetchCompleted(dateKey) {
    try {
      const url = `${REST}?completion_date=eq.${dateKey}&select=task_key`;
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`GET ${res.status}`);
      const rows = await res.json();
      return rows.map((r) => r.task_key);
    } catch (err) {
      console.warn('[NOW] fetchCompleted failed — running local-only:', err.message);
      return null;
    }
  }

  // Upsert a completion. merge-duplicates makes re-checking idempotent so it
  // never errors on the (task_key, completion_date) unique constraint.
  async function saveCompletion(taskKey, dateKey) {
    try {
      const res = await fetch(`${REST}?on_conflict=task_key,completion_date`, {
        method: 'POST',
        headers: { ...HEADERS, Prefer: 'return=minimal,resolution=merge-duplicates' },
        body: JSON.stringify({ task_key: taskKey, completion_date: dateKey }),
      });
      if (!res.ok) throw new Error(`POST ${res.status}`);
      return true;
    } catch (err) {
      console.warn('[NOW] saveCompletion failed (kept locally):', err.message);
      return false;
    }
  }

  // Delete the matching completion row.
  async function removeCompletion(taskKey, dateKey) {
    try {
      const url = `${REST}?task_key=eq.${taskKey}&completion_date=eq.${dateKey}`;
      const res = await fetch(url, { method: 'DELETE', headers: HEADERS });
      if (!res.ok) throw new Error(`DELETE ${res.status}`);
      return true;
    } catch (err) {
      console.warn('[NOW] removeCompletion failed (kept locally):', err.message);
      return false;
    }
  }

  window.NOW_DB = { fetchCompleted, saveCompletion, removeCompletion };
})();
