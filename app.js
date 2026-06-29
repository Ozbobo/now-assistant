// app.js — the engine. NOW/next cards, today's tasks (+ carryover), and a
// 7-day calendar. A single in-memory instance map is the source of truth, so
// checking a task anywhere updates everywhere.
// Wrapped in an IIFE so its declarations don't collide with tasks.js globals.
(() => {
  'use strict';

  const { blocksForDay, tasksForDay, DAY_LABEL, TASK_BY_KEY } = window.NOW_DATA;
  const DB = window.NOW_DB;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const LONG_PRESS_MS = 500;

  // ── State ──────────────────────────────────────────────────────────────
  let today = new Date();          // current Date (refreshed on tick)
  let todayKey = '';               // 'YYYY-MM-DD' for today
  let weekStart = null;            // Monday of the displayed week (a Date)
  // instances: `${task_key}|${YYYY-MM-DD}` → { completed: bool, dismissed: bool }
  const instances = new Map();

  // ── Date helpers ───────────────────────────────────────────────────────
  function dateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const parseKey = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  function mondayOf(d) {
    const back = (d.getDay() + 6) % 7; // days since Monday (Mon=0 … Sun=6)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
  }
  const monthDay = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const minutesNow = (d) => d.getHours() * 60 + d.getMinutes();

  function fmt(mins) {
    mins = ((mins % 1440) + 1440) % 1440;
    let h = Math.floor(mins / 60);
    const m = mins % 60;
    const ampm = h < 12 ? 'AM' : 'PM';
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
  }
  const rangeLabel = (b) => `${fmt(b.start)} – ${fmt(b.end)}`;

  const instKey = (key, dKey) => `${key}|${dKey}`;
  const stateOf = (key, dKey) => instances.get(instKey(key, dKey)) || { completed: false, dismissed: false };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  const tagLabel = (t) => ({ tiktok: 'TikTok', meta: 'Meta', weekend: 'Weekend' }[t] || t);

  // ── NOW / UP NEXT cards ────────────────────────────────────────────────
  function computeBlocks(now) {
    const day = now.getDay();
    const mins = minutesNow(now);
    const blocks = blocksForDay(day);
    const idx = blocks.findIndex((b) => mins >= b.start && mins < b.end);
    const current = blocks[idx];
    const next = idx < blocks.length - 1 ? blocks[idx + 1] : blocksForDay((day + 1) % 7)[0];
    return { current, next, day };
  }

  function renderCards(now) {
    const { current, next, day } = computeBlocks(now);
    const card = document.getElementById('now-card');
    card.className = 'card now-card' + (current.kind ? ` kind-${current.kind}` : '');
    document.getElementById('now-tag').textContent = DAY_LABEL[day];
    document.getElementById('now-range').textContent = rangeLabel(current);
    document.getElementById('now-activity').textContent = current.activity;
    document.getElementById('now-note').textContent = current.note;
    document.getElementById('next-range').textContent = rangeLabel(next);
    document.getElementById('next-activity').textContent = next.activity;
    document.getElementById('next-note').textContent = next.note;
    document.getElementById('clock').textContent = fmt(minutesNow(now));
  }

  // ── Task row builder (shared by Today list + carryover) ────────────────
  // opts: { date, carriedFrom, allowDismiss, allowLongPress, interactive }
  function buildTaskRow(task, opts) {
    const { completed } = stateOf(task.key, opts.date);
    const row = document.createElement('div');
    row.className = 'task-row'
      + (completed ? ' done' : '')
      + (opts.carriedFrom ? ' carryover' : '');
    row.dataset.key = task.key;
    row.dataset.date = opts.date;

    const chip = opts.carriedFrom
      ? '<span class="tag tag-carried">Carried over</span>'
      : `<span class="tag tag-${task.tag}">${tagLabel(task.tag)}</span>`;

    const metaBits = [];
    if (task.note) metaBits.push(escapeHtml(task.note));
    if (opts.carriedFrom) metaBits.push(`from ${opts.carriedFrom}`);

    row.innerHTML = `
      <span class="checkbox" aria-hidden="true"></span>
      <span class="task-text">
        <span class="task-line">
          <span class="task-time">${fmt(task.time)}</span>
          <span class="task-title">${escapeHtml(task.title)}</span>
        </span>
        ${metaBits.length ? `<span class="task-meta">${metaBits.join(' · ')}</span>` : ''}
      </span>
      ${chip}
      ${opts.allowDismiss ? '<button class="dismiss" type="button" aria-label="Dismiss task">×</button>' : ''}
    `;
    wireRow(row, task.key, opts.date, opts);
    return row;
  }

  function wireRow(row, key, date, opts) {
    if (opts.allowDismiss) {
      row.querySelector('.dismiss').addEventListener('click', (e) => {
        e.stopPropagation();
        dismissTask(key, date);
      });
    }

    let timer = null;
    let longFired = false;
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

    if (opts.allowLongPress) {
      row.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.dismiss')) return;
        longFired = false;
        clearTimer();
        timer = setTimeout(() => { longFired = true; revealDismiss(row); }, LONG_PRESS_MS);
      });
      ['pointerup', 'pointermove', 'pointercancel', 'pointerleave'].forEach((ev) =>
        row.addEventListener(ev, clearTimer));
    }

    if (opts.interactive) {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.dismiss')) return;
        if (longFired) { longFired = false; return; } // long-press, not a tap
        toggleComplete(key, date);
      });
    }
  }

  // Add a ×, on the fly, to a today row revealed by long-press.
  function revealDismiss(row) {
    if (row.querySelector('.dismiss')) { row.classList.add('reveal-x'); return; }
    const btn = document.createElement('button');
    btn.className = 'dismiss';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Dismiss task');
    btn.textContent = '×';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissTask(row.dataset.key, row.dataset.date);
    });
    row.appendChild(btn);
    row.classList.add('reveal-x');
  }

  // ── Carryover derivation ───────────────────────────────────────────────
  function carryoverList() {
    const out = [];
    for (const [k, v] of instances) {
      const sep = k.lastIndexOf('|');
      const key = k.slice(0, sep);
      const date = k.slice(sep + 1);
      if (date < todayKey && !v.completed && !v.dismissed) {
        const def = TASK_BY_KEY[key];
        if (def) out.push({ ...def, key, date });
      }
    }
    out.sort((a, b) => (a.date === b.date ? a.time - b.time : (a.date < b.date ? -1 : 1)));
    return out;
  }

  // ── Render: Today section (carryover block + today's tasks) ────────────
  function renderTodaySection() {
    const carryBlock = document.getElementById('carryover-block');
    const carry = carryoverList();
    carryBlock.innerHTML = '';
    if (carry.length) {
      const head = document.createElement('h2');
      head.className = 'section-title carried-title';
      head.textContent = `Carried Over · ${carry.length}`;
      carryBlock.appendChild(head);
      for (const t of carry) {
        const d = parseKey(t.date);
        carryBlock.appendChild(buildTaskRow(t, {
          date: t.date,
          carriedFrom: `${DOW[d.getDay()]} ${monthDay(d)}`,
          allowDismiss: true,
          allowLongPress: false,
          interactive: true,
        }));
      }
    }

    const list = document.getElementById('task-list');
    list.innerHTML = '';
    for (const task of tasksForDay(today.getDay())) {
      if (stateOf(task.key, todayKey).dismissed) continue;
      list.appendChild(buildTaskRow(task, {
        date: todayKey,
        carriedFrom: null,
        allowDismiss: false,    // revealed on long-press instead
        allowLongPress: true,
        interactive: true,
      }));
    }
  }

  // ── Render: 7-day calendar (current week) ──────────────────────────────
  function renderCalendar() {
    const cal = document.getElementById('calendar');
    cal.innerHTML = '';

    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      const dKey = dateKey(d);
      const dDay = d.getDay();
      const when = dKey < todayKey ? 'past' : (dKey === todayKey ? 'today' : 'future');

      const tasks = tasksForDay(dDay).filter((t) => !stateOf(t.key, dKey).dismissed);
      let completedCount = 0;

      const card = document.createElement('section');
      card.className = `cal-day cal-${when}`;

      const rows = tasks.map((t) => {
        const { completed } = stateOf(t.key, dKey);
        if (completed) completedCount++;
        const interactive = when !== 'past';
        return `
          <div class="cal-row${completed ? ' done' : ''}${interactive ? ' tappable' : ''}"
               data-key="${t.key}" data-date="${dKey}">
            <span class="checkbox" aria-hidden="true"></span>
            <span class="cal-time">${fmt(t.time)}</span>
            <span class="cal-title">${escapeHtml(t.title)}</span>
            <span class="dot dot-${t.tag}" aria-hidden="true"></span>
          </div>`;
      }).join('');

      const totalForSummary = tasksForDay(dDay).length; // include dismissed in denominator
      const carried = tasks.length - completedCount;    // open (undismissed, uncompleted)
      const summary = when === 'past'
        ? `<div class="cal-summary">${completedCount} of ${totalForSummary} completed${carried ? ` · ${carried} carried forward` : ''}</div>`
        : '';

      card.innerHTML = `
        <header class="cal-head">
          <span class="cal-date">${DOW[dDay]} · ${monthDay(d)}${when === 'today' ? ' <span class="today-pill">TODAY</span>' : ''}</span>
          <span class="cal-tag">${DAY_LABEL[dDay]}</span>
        </header>
        <div class="cal-rows">${rows || '<div class="cal-empty">No tasks</div>'}</div>
        ${summary}
      `;
      cal.appendChild(card);
    }

    // Wire interactive (today + future) calendar rows.
    cal.querySelectorAll('.cal-row.tappable').forEach((row) => {
      row.addEventListener('click', () => toggleComplete(row.dataset.key, row.dataset.date));
    });
  }

  // ── Mutations (optimistic: update map + re-render, sync in background) ──
  function toggleComplete(key, date) {
    const cur = stateOf(key, date);
    const next = !cur.completed;
    instances.set(instKey(key, date), { ...cur, completed: next });
    renderTodaySection();
    renderCalendar();
    DB.setCompleted(key, date, next);
  }

  function dismissTask(key, date) {
    const cur = stateOf(key, date);
    instances.set(instKey(key, date), { ...cur, dismissed: true });
    renderTodaySection();
    renderCalendar();
    DB.setDismissed(key, date);
  }

  // ── Data load ──────────────────────────────────────────────────────────
  function mergeRows(rows) {
    if (!rows) return; // offline — keep whatever we have
    for (const r of rows) {
      instances.set(instKey(r.task_key, r.assigned_date), {
        completed: !!r.completed_at,
        dismissed: !!r.dismissed_at,
      });
    }
  }

  async function loadData() {
    const keys = tasksForDay(today.getDay()).map((t) => t.key);
    await DB.ensureInstances(keys, todayKey); // materialise today's rows first
    const weekEnd = dateKey(addDays(weekStart, 6));
    const [week, carry, todayRows] = await Promise.all([
      DB.fetchWeek(dateKey(weekStart), weekEnd),
      DB.fetchCarryover(todayKey),
      DB.fetchByDate(todayKey),
    ]);
    mergeRows(week);
    mergeRows(todayRows);
    // carryover rows are open by definition (task_key + assigned_date only)
    if (carry) for (const r of carry) {
      const k = instKey(r.task_key, r.assigned_date);
      if (!instances.has(k)) instances.set(k, { completed: false, dismissed: false });
    }
    renderTodaySection();
    renderCalendar();
  }

  // ── Orchestration ──────────────────────────────────────────────────────
  function recompute(now) {
    today = now;
    todayKey = dateKey(now);
    weekStart = mondayOf(now);
  }

  function renderAll(now) {
    renderCards(now);
    renderTodaySection();
    renderCalendar();
  }

  function tick() {
    const now = new Date();
    if (dateKey(now) !== todayKey) {
      recompute(now);   // midnight (or week) rolled over
      renderAll(now);
      loadData();
    } else {
      renderCards(now);
    }
  }

  function manualRefresh() {
    const now = new Date();
    recompute(now);
    renderAll(now);
    loadData();
    const btn = document.getElementById('refresh-btn');
    btn.classList.add('spin');
    setTimeout(() => btn.classList.remove('spin'), 600);
  }

  function start() {
    recompute(new Date());
    renderAll(today);           // instant render from static data, no spinner
    loadData();                 // fill in DB state in the background

    document.getElementById('refresh-btn').addEventListener('click', manualRefresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) manualRefresh(); });

    const msToNextMinute = (60 - new Date().getSeconds()) * 1000;
    setTimeout(() => { tick(); setInterval(tick, 60 * 1000); }, msToNextMinute);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
