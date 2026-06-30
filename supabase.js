// supabase.js — thin REST wrapper for the task_instances table.
// Wrapped in an IIFE so nothing leaks to global scope except window.NOW_DB.
// Every call fails silently (logs + returns null/false) so the UI keeps working
// offline or if Supabase is unreachable.
(() => {
  'use strict';

  // The only values you ever edit. The anon / publishable key is meant to be
  // public; access is constrained by the RLS policies in schema.sql.
  const SUPABASE_URL = 'https://zwzndwbcksggntlvgdag.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_PLn7duaO9t8etMfjbEMmWQ_e7vVvi9e';

  const REST = `${SUPABASE_URL}/rest/v1/task_instances`;
  const HEADERS = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  async function getJson(query, label) {
    try {
      const res = await fetch(`${REST}?${query}`, { headers: HEADERS });
      if (!res.ok) throw new Error(`GET ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn(`[NOW] ${label} failed — running local-only:`, err.message);
      return null;
    }
  }

  // Upsert (merge) a partial row, keyed on the unique (task_key, assigned_date).
  // Only the provided columns are written, so completing doesn't clobber a
  // dismissal and vice versa.
  async function upsert(body, prefer, label) {
    try {
      const res = await fetch(`${REST}?on_conflict=task_key,assigned_date`, {
        method: 'POST',
        headers: { ...HEADERS, Prefer: prefer },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`POST ${res.status}`);
      return true;
    } catch (err) {
      console.warn(`[NOW] ${label} failed (kept locally):`, err.message);
      return false;
    }
  }

  // Materialise a row for each of today's tasks (no-op if it already exists),
  // so untouched tasks still become carryover candidates tomorrow.
  function ensureInstances(taskKeys, dateKey) {
    if (!taskKeys.length) return Promise.resolve(true);
    const rows = taskKeys.map((task_key) => ({ task_key, assigned_date: dateKey }));
    return upsert(rows, 'return=minimal,resolution=ignore-duplicates', 'ensureInstances');
  }

  // Instances for one day → today's checked / dismissed state. Includes
  // dismissed_at so a task dismissed earlier today stays hidden after reload.
  function fetchByDate(dateKey) {
    return getJson(
      `assigned_date=eq.${dateKey}&select=task_key,assigned_date,completed_at,dismissed_at`,
      'fetchByDate'
    );
  }

  // Open instances from earlier days → the carryover list.
  function fetchCarryover(dateKey) {
    return getJson(
      `assigned_date=lt.${dateKey}&completed_at=is.null&dismissed_at=is.null&select=task_key,assigned_date`,
      'fetchCarryover'
    );
  }

  // Instances across a date range → calendar completion / dismissal state.
  function fetchWeek(startKey, endKey) {
    return getJson(
      `assigned_date=gte.${startKey}&assigned_date=lte.${endKey}&select=task_key,assigned_date,completed_at,dismissed_at`,
      'fetchWeek'
    );
  }

  // Mark complete / uncomplete. completed=false writes null (re-opens the task).
  function setCompleted(taskKey, dateKey, completed) {
    return upsert(
      { task_key: taskKey, assigned_date: dateKey, completed_at: completed ? new Date().toISOString() : null },
      'return=minimal,resolution=merge-duplicates',
      'setCompleted'
    );
  }

  // Skip a task without completing it.
  function setDismissed(taskKey, dateKey) {
    return upsert(
      { task_key: taskKey, assigned_date: dateKey, dismissed_at: new Date().toISOString() },
      'return=minimal,resolution=merge-duplicates',
      'setDismissed'
    );
  }

  // Voice — send a spoken transcript + the day's context (current/next block,
  // task status) to the parse-voice Edge Function, which calls Claude (Haiku)
  // server-side. Returns { action, task_keys, reply }, or null if the function
  // is unreachable (so the UI can tell "service down" from a real reply). The
  // function's own friendly error replies (which carry `reply`) are passed
  // through so they still get spoken/shown.
  async function parseVoice(transcript, context) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/parse-voice`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ transcript, context }),
      });
      const data = await res.json().catch(() => null);
      if (data && (Array.isArray(data.task_keys) || typeof data.reply === 'string')) return data;
      return res.ok ? data : null;
    } catch (err) {
      console.warn('[NOW] parseVoice failed:', err.message);
      return null;
    }
  }

  window.NOW_DB = {
    ensureInstances, fetchByDate, fetchCarryover, fetchWeek, setCompleted, setDismissed, parseVoice,
  };
})();
