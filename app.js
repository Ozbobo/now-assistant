// app.js — the engine. Computes "now", renders the UI, handles check-offs,
// the per-minute tick, and the midnight rollover.
// Wrapped in an IIFE so its declarations don't collide with the globals that
// schedule.js / supabase.js define (they share data only via window.NOW_*).
(() => {
  'use strict';

  const { blocksForDay, DAY_LABEL, TASKS_BY_DAY } = window.NOW_SCHEDULE;
  const DB = window.NOW_DB;

  // ── Module state ─────────────────────────────────────────────────────────
  let currentDateKey = null;       // 'YYYY-MM-DD' for the day on screen
  const completed = new Set();      // task_keys checked for the current day

  // ── Time / date helpers ──────────────────────────────────────────────────

  // Local date key (NOT UTC — toISOString would shift across midnight in ET).
  function dateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  const minutesNow = (d) => d.getHours() * 60 + d.getMinutes();

  // "5:30 AM" style label from minutes-from-midnight. 1440 wraps to 12:00 AM.
  function fmt(mins) {
    mins = mins % 1440;
    let h = Math.floor(mins / 60);
    const m = mins % 60;
    const ampm = h < 12 ? 'AM' : 'PM';
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  const range = (b) => `${fmt(b.start)} – ${fmt(b.end)}`;

  // Find the current block and the one after it. Handles the end-of-day wrap by
  // reaching into tomorrow's (possibly different) schedule for "up next".
  function computeBlocks(now) {
    const day = now.getDay();
    const mins = minutesNow(now);
    const blocks = blocksForDay(day);

    const idx = blocks.findIndex((b) => mins >= b.start && mins < b.end);
    const current = blocks[idx];

    let next;
    if (idx < blocks.length - 1) {
      next = blocks[idx + 1];
    } else {
      const tomorrow = (day + 1) % 7;
      next = blocksForDay(tomorrow)[0]; // first block of the next day
    }
    return { current, next, day };
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function renderCards(now) {
    const { current, next, day } = computeBlocks(now);

    const card = document.getElementById('now-card');
    card.className = 'card now-card' + (current.kind ? ` kind-${current.kind}` : '');

    document.getElementById('now-tag').textContent = DAY_LABEL[day];
    document.getElementById('now-range').textContent = range(current);
    document.getElementById('now-activity').textContent = current.activity;
    document.getElementById('now-note').textContent = current.note;

    document.getElementById('next-range').textContent = range(next);
    document.getElementById('next-activity').textContent = next.activity;
    document.getElementById('next-note').textContent = next.note;

    document.getElementById('clock').textContent = fmt(minutesNow(now));
  }

  function renderTasks(now) {
    const list = document.getElementById('task-list');
    const tasks = TASKS_BY_DAY[now.getDay()] || [];
    list.innerHTML = '';

    for (const task of tasks) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'task-row';
      row.dataset.key = task.key;
      if (completed.has(task.key)) row.classList.add('done');

      row.innerHTML = `
        <span class="checkbox" aria-hidden="true"></span>
        <span class="task-text">
          <span class="task-title">${escapeHtml(task.title)}</span>
          ${task.note ? `<span class="task-note">${escapeHtml(task.note)}</span>` : ''}
        </span>
        <span class="tag tag-${task.tag}">${tagLabel(task.tag)}</span>
      `;
      row.setAttribute('aria-pressed', completed.has(task.key) ? 'true' : 'false');
      row.addEventListener('click', () => toggleTask(task.key, row));
      list.appendChild(row);
    }
  }

  function tagLabel(tag) {
    return { tiktok: 'TikTok', meta: 'Meta', weekend: 'Weekend' }[tag] || tag;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ── Check-off behaviour ──────────────────────────────────────────────────
  // Optimistic: flip the UI immediately, sync to Supabase in the background.
  // If the DB is unreachable it fails silently and the box stays toggled locally.
  function toggleTask(key, row) {
    const nowChecked = !completed.has(key);
    if (nowChecked) completed.add(key);
    else completed.delete(key);

    row.classList.toggle('done', nowChecked);
    row.setAttribute('aria-pressed', nowChecked ? 'true' : 'false');

    if (nowChecked) DB.saveCompletion(key, currentDateKey);
    else DB.removeCompletion(key, currentDateKey);
  }

  // Pull today's completions and apply checked state to whatever is on screen.
  async function syncFromDb() {
    const keys = await DB.fetchCompleted(currentDateKey);
    if (keys === null) return; // offline — leave local state as-is

    completed.clear();
    keys.forEach((k) => completed.add(k));

    document.querySelectorAll('.task-row').forEach((row) => {
      const on = completed.has(row.dataset.key);
      row.classList.toggle('done', on);
      row.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // ── Render orchestration ──────────────────────────────────────────────-──

  // Full render for a (possibly new) day. Clears local state and re-syncs.
  function renderForDate(now) {
    currentDateKey = dateKey(now);
    completed.clear();
    renderCards(now);
    renderTasks(now);
    syncFromDb(); // background; UI already shown
  }

  // Per-minute tick: always refresh the cards; if the date rolled over, rebuild
  // the task list for the new day and re-fetch its completions.
  function tick() {
    const now = new Date();
    if (dateKey(now) !== currentDateKey) {
      renderForDate(now); // midnight crossed
    } else {
      renderCards(now);
    }
  }

  // Manual refresh button: recompute everything and re-pull from the DB.
  function manualRefresh() {
    const now = new Date();
    if (dateKey(now) !== currentDateKey) {
      renderForDate(now);
    } else {
      renderCards(now);
      renderTasks(now);
      syncFromDb();
    }
    flashRefresh();
  }

  function flashRefresh() {
    const btn = document.getElementById('refresh-btn');
    btn.classList.add('spin');
    setTimeout(() => btn.classList.remove('spin'), 600);
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function start() {
    renderForDate(new Date());
    document.getElementById('refresh-btn').addEventListener('click', manualRefresh);

    // Align the first tick to the next minute boundary, then run every minute.
    const msToNextMinute = (60 - new Date().getSeconds()) * 1000;
    setTimeout(() => {
      tick();
      setInterval(tick, 60 * 1000);
    }, msToNextMinute);

    // Recompute when returning to the tab (e.g. reopening the PWA after hours).
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) manualRefresh();
    });
  }

  // Boot now if the DOM is already parsed, otherwise wait for it. Guarding on
  // readyState means we render even if this script evaluates after the event.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
