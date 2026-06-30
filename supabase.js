// supabase.js — auth + data layer (v7). Loaded as a `<script type="module">`,
// so it runs AFTER the classic tasks.js/app.js have defined window.NOW_DATA and
// window.NOW_APP. It:
//   1. creates the authed Supabase client (publishable key + the user's JWT),
//   2. exposes the same window.NOW_DB interface app.js already uses (now
//      user-scoped via RLS) plus weekly-stats helpers,
//   3. gates the app behind a 6-digit email-code login and starts app.js once a
//      session exists.
//
// The publishable key is public by design; RLS (auth.uid() = user_id) isolates
// each account's rows. The Anthropic key still lives only in the Edge Function.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://zwzndwbcksggntlvgdag.supabase.co';
const SUPABASE_KEY = 'sb_publishable_PLn7duaO9t8etMfjbEMmWQ_e7vVvi9e';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

let currentUser = null;
const uid = () => (currentUser ? currentUser.id : null);

// ── Data layer (same NOW_DB contract: reads → rows|null, writes → bool) ─────
async function ensureInstances(taskKeys, dateKey) {
  if (!taskKeys.length || !uid()) return true;
  const rows = taskKeys.map((task_key) => ({ user_id: uid(), task_key, assigned_date: dateKey }));
  const { error } = await sb
    .from('task_instances')
    .upsert(rows, { onConflict: 'user_id,task_key,assigned_date', ignoreDuplicates: true });
  if (error) { console.warn('[NOW] ensureInstances:', error.message); return false; }
  return true;
}

async function fetchByDate(dateKey) {
  const { data, error } = await sb
    .from('task_instances')
    .select('task_key,assigned_date,completed_at,dismissed_at')
    .eq('assigned_date', dateKey);
  if (error) { console.warn('[NOW] fetchByDate:', error.message); return null; }
  return data;
}

async function fetchCarryover(dateKey) {
  const { data, error } = await sb
    .from('task_instances')
    .select('task_key,assigned_date')
    .lt('assigned_date', dateKey)
    .is('completed_at', null)
    .is('dismissed_at', null);
  if (error) { console.warn('[NOW] fetchCarryover:', error.message); return null; }
  return data;
}

async function fetchWeek(startKey, endKey) {
  const { data, error } = await sb
    .from('task_instances')
    .select('task_key,assigned_date,completed_at,dismissed_at')
    .gte('assigned_date', startKey)
    .lte('assigned_date', endKey);
  if (error) { console.warn('[NOW] fetchWeek:', error.message); return null; }
  return data;
}

// Upsert only the provided columns (PostgREST merge), so completing never
// clobbers a dismissal and vice-versa.
async function setCompleted(taskKey, dateKey, completed) {
  if (!uid()) return false;
  const { error } = await sb.from('task_instances').upsert(
    { user_id: uid(), task_key: taskKey, assigned_date: dateKey, completed_at: completed ? new Date().toISOString() : null },
    { onConflict: 'user_id,task_key,assigned_date' },
  );
  if (error) { console.warn('[NOW] setCompleted:', error.message); return false; }
  return true;
}

async function setDismissed(taskKey, dateKey) {
  if (!uid()) return false;
  const { error } = await sb.from('task_instances').upsert(
    { user_id: uid(), task_key: taskKey, assigned_date: dateKey, dismissed_at: new Date().toISOString() },
    { onConflict: 'user_id,task_key,assigned_date' },
  );
  if (error) { console.warn('[NOW] setDismissed:', error.message); return false; }
  return true;
}

// Voice — same contract as before: returns { action, task_keys, reply } or null.
async function parseVoice(transcript, context) {
  try {
    const { data, error } = await sb.functions.invoke('parse-voice', { body: { transcript, context } });
    if (error) throw error;
    if (data && (Array.isArray(data.task_keys) || typeof data.reply === 'string')) return data;
    return null;
  } catch (err) {
    console.warn('[NOW] parseVoice failed:', err.message || err);
    return null;
  }
}

// ── Weekly stats ────────────────────────────────────────────────────────────
async function getWeeklyStats(limit = 12) {
  const { data, error } = await sb
    .from('weekly_stats')
    .select('week_start_date,completion_percentage,days')
    .order('week_start_date', { ascending: false })
    .limit(limit);
  if (error) { console.warn('[NOW] getWeeklyStats:', error.message); return null; }
  return data;
}

async function getWeeklyStat(weekStart) {
  const { data, error } = await sb
    .from('weekly_stats')
    .select('id')
    .eq('week_start_date', weekStart)
    .maybeSingle();
  if (error) { console.warn('[NOW] getWeeklyStat:', error.message); return null; }
  return data; // null when not yet rolled up
}

async function insertWeeklyStat(row) {
  if (!uid()) return false;
  const { error } = await sb.from('weekly_stats').insert({ ...row, user_id: uid() });
  if (error) { console.warn('[NOW] insertWeeklyStat:', error.message); return false; }
  return true;
}

async function deleteInstancesBefore(dateKey) {
  if (!uid()) return false;
  const { error } = await sb.from('task_instances').delete().lt('assigned_date', dateKey);
  if (error) { console.warn('[NOW] deleteInstancesBefore:', error.message); return false; }
  return true;
}

window.NOW_DB = {
  ensureInstances, fetchByDate, fetchCarryover, fetchWeek, setCompleted, setDismissed, parseVoice,
  getWeeklyStats, getWeeklyStat, insertWeeklyStat, deleteInstancesBefore,
};

// ── Auth gate + login UI ────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
let started = false;

function showLogin() {
  const app = $('app-wrap'); if (app) app.hidden = true;
  const login = $('login-view'); if (login) login.hidden = false;
}

function enterApp(user) {
  currentUser = user;
  const login = $('login-view'); if (login) login.hidden = true;
  const app = $('app-wrap'); if (app) app.hidden = false;
  if (!started && window.NOW_APP && typeof window.NOW_APP.start === 'function') {
    started = true;
    window.NOW_APP.start(user);
  }
}

async function signOut() {
  try { await sb.auth.signOut(); } catch (_) { /* ignore */ }
  location.reload(); // simplest reset of all in-memory state
}
window.NOW_AUTH = { signOut };

function wireLogin() {
  const emailInput = $('login-email');
  const codeInput = $('login-code');
  const sendBtn = $('login-send');
  const verifyBtn = $('login-verify');
  const codeRow = $('login-code-row');
  const status = $('login-status');
  if (!emailInput || !sendBtn) return;

  let pendingEmail = '';
  const setStatus = (msg, kind = '') => {
    if (!status) return;
    status.textContent = msg;
    status.className = 'login-status' + (kind ? ' ' + kind : '');
  };

  sendBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    if (!email) { setStatus('Enter your email.', 'err'); return; }
    sendBtn.disabled = true;
    setStatus('Sending code…');
    const { error } = await sb.auth.signInWithOtp({ email });
    sendBtn.disabled = false;
    if (error) { setStatus("Couldn't send the code. Try again.", 'err'); return; }
    pendingEmail = email;
    if (codeRow) codeRow.hidden = false;
    if (codeInput) codeInput.focus();
    setStatus('Check your email for a 6-digit code.', 'ok');
  });

  const verify = async () => {
    const token = (codeInput && codeInput.value || '').trim();
    if (!pendingEmail) { setStatus('Send a code first.', 'err'); return; }
    if (!token) { setStatus('Enter the code from your email.', 'err'); return; }
    if (verifyBtn) verifyBtn.disabled = true;
    setStatus('Verifying…');
    const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token, type: 'email' });
    if (verifyBtn) verifyBtn.disabled = false;
    if (error) { setStatus('That code didn’t work. Try again.', 'err'); return; }
    // The SIGNED_IN handler takes over from here.
  };

  if (verifyBtn) verifyBtn.addEventListener('click', verify);
  if (codeInput) codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(); });
  emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendBtn.click(); });
}

sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' && session) enterApp(session.user);
  else if (event === 'SIGNED_OUT') currentUser = null;
});

async function boot() {
  wireLogin();
  const signoutBtn = $('signout-btn');
  if (signoutBtn) signoutBtn.addEventListener('click', signOut);
  const { data: { session } } = await sb.auth.getSession();
  if (session) enterApp(session.user);
  else showLogin();
}

boot();
