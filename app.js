// app.js — the engine. NOW/next cards, today's tasks (+ carryover), and a
// 7-day calendar. A single in-memory instance map is the source of truth, so
// checking a task anywhere updates everywhere.
// Wrapped in an IIFE so its declarations don't collide with tasks.js globals.
(() => {
  'use strict';

  const { blocksForDay, tasksForDay, DAY_LABEL, TASK_BY_KEY } = window.NOW_DATA;
  // Assigned in start(): the auth+data module (supabase.js) defines window.NOW_DB
  // and runs AFTER this classic script, so we can't read it at load time.
  let DB = null;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
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

    renderWeekBar(); // the compact dot strip tracks the same week
  }

  // ── Weekly stats: dot bar + history + rollup ───────────────────────────
  // Status of one day this week, from its scheduled count vs. completions.
  function weekDayStatus(d, dKey) {
    const scheduled = tasksForDay(d.getDay()).length;
    let completed = 0;
    for (const t of tasksForDay(d.getDay())) {
      if (stateOf(t.key, dKey).completed) completed++;
    }
    if (dKey > todayKey) return 'future';
    if (scheduled > 0 && completed >= scheduled) return 'complete';
    if (completed > 0) return 'partial';
    if (dKey < todayKey) return 'zero';  // a past day with nothing done
    return 'today';                      // today, nothing checked yet
  }

  // Compact Mon→Sun dot strip for the current week.
  function renderWeekBar() {
    const bar = document.getElementById('week-bar');
    if (!bar) return;
    const initials = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    let html = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      const dKey = dateKey(d);
      const status = weekDayStatus(d, dKey);
      html += `<div class="wb-day${dKey === todayKey ? ' wb-today' : ''}">
        <span class="wb-dot wb-${status}" aria-hidden="true"></span>
        <span class="wb-lbl">${initials[i]}</span>
      </div>`;
    }
    bar.innerHTML = html;
  }

  // Summarise a week's instance rows → percentage, day counts, and a 7-char
  // Mon..Sun status string (c|p|z|-) for the history dots.
  function computeWeekStats(rows, weekStartStr) {
    const start = parseKey(weekStartStr);
    const completedByDate = {};
    for (const r of rows || []) {
      if (r.completed_at) completedByDate[r.assigned_date] = (completedByDate[r.assigned_date] || 0) + 1;
    }
    let daysComplete = 0, daysPartial = 0, daysZero = 0, totalSched = 0, totalDone = 0, days = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      const scheduled = tasksForDay(d.getDay()).length;
      const completed = completedByDate[dateKey(d)] || 0;
      if (scheduled === 0) { days += '-'; continue; }
      totalSched += scheduled;
      totalDone += Math.min(completed, scheduled);
      if (completed >= scheduled) { daysComplete++; days += 'c'; }
      else if (completed > 0) { daysPartial++; days += 'p'; }
      else { daysZero++; days += 'z'; }
    }
    const percentage = totalSched > 0 ? Math.round((totalDone / totalSched) * 100) : 0;
    return { percentage, daysComplete, daysPartial, daysZero, days };
  }

  // Once per week boundary: roll last week into weekly_stats, then prune old
  // daily rows (keeps storage tiny; carryover therefore resets each Monday).
  async function rollupIfNeeded() {
    if (!DB || typeof DB.getWeeklyStat !== 'function') return;
    const lastMon = dateKey(addDays(weekStart, -7));
    if (await DB.getWeeklyStat(lastMon)) return;            // already rolled up
    const lastEnd = dateKey(addDays(parseKey(lastMon), 6));
    const rows = await DB.fetchWeek(lastMon, lastEnd);
    if (rows === null) return;                              // offline — try later
    if (!rows.length) return;                               // nothing happened last week
    const s = computeWeekStats(rows, lastMon);
    await DB.insertWeeklyStat({
      week_start_date: lastMon,
      completion_percentage: s.percentage,
      days_complete: s.daysComplete,
      days_partial: s.daysPartial,
      days_zero: s.daysZero,
      days: s.days,
    });
    await DB.deleteInstancesBefore(dateKey(weekStart));
  }

  // History list of past weeks (newest first).
  async function renderWeeklyStats() {
    const wrap = document.getElementById('weekly-stats');
    if (!wrap || !DB || typeof DB.getWeeklyStats !== 'function') return;
    const stats = await DB.getWeeklyStats(12);
    if (!stats || !stats.length) { wrap.innerHTML = ''; return; }
    const SUFFIX = { c: 'c', p: 'p', z: 'z', '-': 'none' };
    const dotFor = (ch) => `<span class="ws-dot ws-${SUFFIX[ch] || 'none'}" aria-hidden="true"></span>`;
    const rows = stats.map((st) => {
      const d = parseKey(st.week_start_date);
      const dots = (st.days || '-------').split('').map(dotFor).join('');
      return `<div class="ws-row">
        <span class="ws-week">Week of ${monthDay(d)}</span>
        <span class="ws-pct">${st.completion_percentage}%</span>
        <span class="ws-dots">${dots}</span>
      </div>`;
    }).join('');
    wrap.innerHTML = `<h2 class="section-title">Weekly Stats</h2><div class="ws-list">${rows}</div>`;
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

  // ── Toast ──────────────────────────────────────────────────────────────
  let toastTimer = null;
  function showToast(message, kind = 'info') {
    const wrap = document.getElementById('toast-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    wrap.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { if (el.parentNode) el.remove(); }, 250);
    }, 3600);
  }

  // ── Voice: check-off + queries, with spoken replies ────────────────────
  // Web Speech API transcribes → parse-voice Edge Function (Claude Haiku) →
  // { action, task_keys, reply }. Matched keys check off via toggleComplete;
  // the reply is spoken aloud (browser TTS) and shown as a toast.
  let recognition = null;
  let micState = 'idle'; // 'idle' | 'listening' | 'processing'
  let speechPrimed = false;

  function setMicState(s) {
    micState = s;
    const btn = document.getElementById('mic-btn');
    if (!btn) return;
    btn.classList.toggle('listening', s === 'listening');
    btn.classList.toggle('processing', s === 'processing');
  }

  // Everything currently checkable: today's undismissed tasks + carryover.
  // Map task_key → { label, time, instances:[{key,date}] } so one spoken key
  // resolves to the right (key,date) even when it's both today's and a week-old
  // carryover.
  function voiceCandidates() {
    const map = new Map();
    const add = (key, label, time, date) => {
      if (!map.has(key)) map.set(key, { label, time, instances: [] });
      map.get(key).instances.push({ key, date });
    };
    for (const t of tasksForDay(today.getDay())) {
      if (stateOf(t.key, todayKey).dismissed) continue;
      add(t.key, t.title, t.time, todayKey);
    }
    for (const t of carryoverList()) add(t.key, t.title, t.time, t.date);
    return map;
  }

  // The context the Edge Function hands to Claude: clock, current/next block,
  // and each task with its completion status.
  function voiceContext(now, candidates) {
    const { current, next, day } = computeBlocks(now);
    const fmtBlock = (b) => ({ title: b.activity, start: fmt(b.start), end: fmt(b.end), note: b.note || '' });
    const today_tasks = [...candidates].map(([task_key, v]) => ({
      task_key,
      label: v.label,
      suggested_time: fmt(v.time),
      completed: v.instances.every((i) => stateOf(i.key, i.date).completed),
    }));
    return {
      current_time: fmt(minutesNow(now)),
      current_day: DAY_NAMES[day],
      current_block: fmtBlock(current),
      next_block: fmtBlock(next),
      today_tasks,
    };
  }

  // Check ON the matched keys (never toggle an already-completed task off).
  function applyVoiceMatches(keys, candidates) {
    const done = [];
    for (const key of keys) {
      const c = candidates.get(key);
      if (!c) continue;
      for (const inst of c.instances) {
        if (!stateOf(inst.key, inst.date).completed) {
          toggleComplete(inst.key, inst.date);
          if (!done.includes(c.label)) done.push(c.label);
        }
      }
    }
    return done;
  }

  // Pick the most natural available voice. iOS ships free Premium/Enhanced
  // voices (Settings → Accessibility → Spoken Content → Voices) that sound far
  // better than the default — prefer those, then any English voice.
  function pickBestVoice() {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    const named = ['Ava (Premium)', 'Evan (Premium)', 'Zoe (Premium)', 'Nicky (Premium)', 'Tom (Premium)'];
    for (const name of named) {
      const v = voices.find((v) => v.name === name);
      if (v) return v;
    }
    return (
      voices.find((v) => v.name.includes('(Premium)') && v.lang.startsWith('en')) ||
      voices.find((v) => v.name.includes('(Enhanced)') && v.lang.startsWith('en')) ||
      voices.find((v) => v.lang === 'en-US') ||
      voices[0]
    );
  }

  // Speak a reply aloud (best-effort; silently no-ops if TTS is unavailable).
  function speak(text) {
    if (!text || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0; u.pitch = 1.0; u.lang = 'en-US';
      const v = pickBestVoice();
      if (v) u.voice = v;
      window.speechSynthesis.speak(u);
    } catch (_) { /* ignore */ }
  }

  // iOS only allows TTS after a user gesture — prime it (silently) on first tap.
  function primeSpeech() {
    if (speechPrimed || !('speechSynthesis' in window)) return;
    speechPrimed = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch (_) { /* ignore */ }
  }

  async function handleTranscript(transcript) {
    const candidates = voiceCandidates();
    setMicState('processing');
    const result = await DB.parseVoice(transcript, voiceContext(new Date(), candidates));
    setMicState('idle');

    if (!result) { showToast("Couldn't reach the voice service. Try again.", 'error'); return; }

    const done = Array.isArray(result.task_keys) && result.task_keys.length
      ? applyVoiceMatches(result.task_keys, candidates)
      : [];

    const reply = typeof result.reply === 'string' ? result.reply.trim() : '';
    if (reply) {
      speak(reply);
      showToast(reply, (done.length || result.action === 'complete') ? 'success' : 'info');
    } else if (done.length) {
      const msg = `Checked off: ${done.join(', ')}`;
      speak(msg);
      showToast(msg, 'success');
    } else {
      showToast(`No task matched "${transcript}".`, 'info');
    }
  }

  function setupVoice() {
    const btn = document.getElementById('mic-btn');
    if (!btn) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || typeof DB.parseVoice !== 'function') { btn.hidden = true; return; }
    btn.hidden = false;

    // Warm the TTS voice list (loads asynchronously in some browsers).
    if ('speechSynthesis' in window) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    }

    recognition = new SR();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    let gotResult = false;

    recognition.addEventListener('result', (e) => {
      gotResult = true;
      const transcript = (e.results[0][0].transcript || '').trim();
      if (transcript) handleTranscript(transcript);
      else { setMicState('idle'); showToast("Didn't catch that.", 'info'); }
    });

    recognition.addEventListener('end', () => {
      // Ended without a result and not mid-parse → back to idle.
      if (micState === 'listening' && !gotResult) setMicState('idle');
    });

    recognition.addEventListener('error', (e) => {
      setMicState('idle');
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        showToast('Microphone access denied. Enable it in settings.', 'error');
      } else if (e.error === 'no-speech') {
        showToast("Didn't hear anything. Try again.", 'info');
      } else if (e.error === 'network') {
        showToast('Speech recognition needs a connection.', 'error');
      } else if (e.error !== 'aborted') {
        showToast('Voice input failed. Try again.', 'error');
      }
    });

    btn.addEventListener('click', () => {
      if (micState === 'processing') return;
      if (micState === 'listening') { recognition.stop(); return; } // tap again to stop
      // Cancel any in-progress speech + prime TTS within this user gesture (iOS).
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      primeSpeech();
      gotResult = false;
      setMicState('listening');
      try { recognition.start(); }
      catch (_) { /* already started — ignore */ }
    });
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
      initData();       // re-check the weekly rollup at the boundary too
    } else {
      renderCards(now);
    }
  }

  function manualRefresh() {
    const now = new Date();
    recompute(now);
    renderAll(now);
    initData();
    const btn = document.getElementById('refresh-btn');
    btn.classList.add('spin');
    setTimeout(() => btn.classList.remove('spin'), 600);
  }

  // Background data sync: roll last week up first (may prune old rows), then
  // load current state, then refresh the weekly-stats history.
  async function initData() {
    await rollupIfNeeded();
    await loadData();
    renderWeeklyStats();
  }

  function start() {
    DB = window.NOW_DB;
    recompute(new Date());
    renderAll(today);           // instant render from static data, no spinner
    initData();                 // rollup + DB state + history in the background

    document.getElementById('refresh-btn').addEventListener('click', manualRefresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) manualRefresh(); });
    setupVoice();

    const msToNextMinute = (60 - new Date().getSeconds()) * 1000;
    setTimeout(() => { tick(); setInterval(tick, 60 * 1000); }, msToNextMinute);
  }

  // app.js no longer self-starts; the auth module (supabase.js) calls start()
  // once a session exists, and re-shows the login view on sign-out.
  window.NOW_APP = { start };
})();
