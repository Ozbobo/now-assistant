// tasks.js — pure data. The single source of truth for the day: time blocks,
// per-day tasks (with suggested times), and a flat key→task lookup.
// Wrapped in an IIFE so nothing leaks to global scope except window.NOW_DATA.
//
// Block times AND task suggested-times are minutes-from-midnight (6:15 AM = 375)
// so comparisons and sorting are trivial numeric ops.
//
// block.kind drives the NOW card background:
//   undefined → default dark ink   |   'sleep' → deep navy   |   'rest' → sand
(() => {
  'use strict';

  const H = (h, m = 0) => h * 60 + m;

  // ── Weekday time blocks (Mon–Fri) ───────────────────────────────────────
  // Only the 10:00–13:00 training block changes per day → '__TRAINING__'.
  const WEEKDAY_BLOCKS = [
    { start: H(0),      end: H(5, 30),  activity: 'Sleep',                     note: 'Lights off. Back at 5:30.',                          kind: 'sleep' },
    { start: H(5, 30),  end: H(6, 15),  activity: 'Wake, coffee, breakfast',   note: 'Ease in. No screens. Set the mindset.' },
    { start: H(6, 15),  end: H(9),      activity: 'Morning creative block',    note: 'Batched: 15 min ideas → 30 min Nano Banana → overlays.' },
    { start: H(9),      end: H(10),     activity: 'Open Meta — start watch',   note: 'Get eyes on the campaigns. Plan adjustments.' },
    { start: H(10),     end: H(13),     activity: '__TRAINING__',              note: 'Push it. Build athleticism back.' },
    { start: H(13),     end: H(14),     activity: 'Shower + eat',              note: "Reset. Don't skip the food." },
    { start: H(14),     end: H(17),     activity: 'Competitor + media tasks',  note: 'Spy ads, optimize, handle the back half of the day.' },
    { start: H(17),     end: H(18, 30), activity: 'Power nap + coffee reset',  note: "20–30 min nap. Coffee. Don't push through tired." },
    { start: H(18, 30), end: H(21),     activity: 'Light TikTok Shop wrap',    note: 'Loose ends. Schedule, check, wind down.' },
    { start: H(21),     end: H(24),     activity: 'Bed',                       note: 'Nine to five-thirty is non-negotiable.',              kind: 'sleep' },
  ];

  // ── Weekend time blocks (Sat & Sun) ─────────────────────────────────────
  const WEEKEND_BLOCKS = [
    { start: H(0),  end: H(7),  activity: 'Sleep',             note: 'Sleep in a bit.',                                          kind: 'sleep' },
    { start: H(7),  end: H(9),  activity: 'Slow morning',      note: 'Coffee. Breathe. No grind.' },
    { start: H(9),  end: H(12), activity: 'Weekly setup block', note: 'Schedule posts, prep Meta, optimize listings. Week starts here.' },
    { start: H(12), end: H(21), activity: 'Off the clock',     note: 'Recover. No gym, no training. Reset for the week.',         kind: 'rest' },
    { start: H(21), end: H(24), activity: 'Bed',               note: 'Back to 5:30 tomorrow.',                                    kind: 'sleep' },
  ];

  const TRAINING_BY_DAY = { 1: 'Athletic training', 2: 'Gym', 3: 'Gym', 4: 'Gym', 5: 'Athletic training' };

  // Tag shown on the NOW card. Indexed by getDay() (0=Sun).
  const DAY_LABEL = {
    0: 'Rest + Setup', 1: 'Athletic Training', 2: 'Gym', 3: 'Gym',
    4: 'Gym', 5: 'Athletic Training', 6: 'Rest + Setup',
  };

  // ── Daily tasks (indexed by getDay()) ───────────────────────────────────
  // Each task: { key, title, note, tag, time } where time = minutes-from-midnight.
  // Lists are authored already sorted by time; tasksForDay() re-sorts defensively.
  // tag is purely for color-coding: 'tiktok' | 'meta' | 'weekend'.
  const TASKS_BY_DAY = {
    1: [ // Monday
      { key: 'mon-morning-creative', title: 'Morning creative block', note: 'Ideas → Nano Banana → overlays.', tag: 'tiktok', time: H(6, 15) },
      { key: 'mon-monitor-meta', title: 'Monitor Meta campaigns', note: '9–5 active watch.', tag: 'meta', time: H(9) },
      { key: 'mon-launch-meta-batch', title: 'Launch new Meta batch', note: 'Kick off the week.', tag: 'meta', time: H(9, 30) },
      { key: 'mon-creator-outreach', title: 'Creator outreach + messaging', note: 'New collabs, reply to inbound.', tag: 'tiktok', time: H(18, 30) },
    ],
    2: [ // Tuesday
      { key: 'tue-morning-creative', title: 'Morning creative block', note: '', tag: 'tiktok', time: H(6, 15) },
      { key: 'tue-schedule-posts', title: 'Schedule TikTok posts', note: 'Post day. Batch a few days out.', tag: 'tiktok', time: H(8) },
      { key: 'tue-monitor-meta', title: 'Monitor Meta campaigns', note: '', tag: 'meta', time: H(9) },
      { key: 'tue-track-performance', title: 'Track creative performance', note: "Mid-week pulse on what's converting.", tag: 'tiktok', time: H(14) },
      { key: 'tue-competitor-check', title: 'Competitor check + update tracker', note: 'Spy ads, update the sheet.', tag: 'meta', time: H(14, 30) },
      { key: 'tue-creator-outreach', title: 'Creator outreach + messaging', note: '', tag: 'tiktok', time: H(18, 30) },
    ],
    3: [ // Wednesday
      { key: 'wed-morning-creative', title: 'Morning creative block', note: '', tag: 'tiktok', time: H(6, 15) },
      { key: 'wed-monitor-meta', title: 'Monitor Meta campaigns', note: '', tag: 'meta', time: H(9) },
      { key: 'wed-launch-meta-batch', title: 'Launch new Meta batch', note: 'Two days since last launch.', tag: 'meta', time: H(9, 30) },
      { key: 'wed-creator-outreach', title: 'Creator outreach + messaging', note: '', tag: 'tiktok', time: H(18, 30) },
    ],
    4: [ // Thursday
      { key: 'thu-morning-creative', title: 'Morning creative block', note: '', tag: 'tiktok', time: H(6, 15) },
      { key: 'thu-monitor-meta', title: 'Monitor Meta campaigns', note: '', tag: 'meta', time: H(9) },
      { key: 'thu-creator-outreach', title: 'Creator outreach + messaging', note: '', tag: 'tiktok', time: H(18, 30) },
    ],
    5: [ // Friday
      { key: 'fri-morning-creative', title: 'Morning creative block', note: '', tag: 'tiktok', time: H(6, 15) },
      { key: 'fri-monitor-meta', title: 'Monitor Meta campaigns', note: '', tag: 'meta', time: H(9) },
      { key: 'fri-launch-meta-batch', title: 'Launch new Meta batch', note: 'Close the week with a fresh batch.', tag: 'meta', time: H(9, 30) },
      { key: 'fri-track-performance', title: 'Track creative performance', note: 'End-of-week read. What carries over?', tag: 'tiktok', time: H(14) },
      { key: 'fri-competitor-check', title: 'Competitor check + update tracker', note: '', tag: 'meta', time: H(14, 30) },
      { key: 'fri-creator-outreach', title: 'Creator outreach + messaging', note: '', tag: 'tiktok', time: H(18, 30) },
    ],
    6: [ // Saturday
      { key: 'sat-optimize-listings', title: 'Optimize product listings', note: 'Weekly checkup. Competitor moves. Refresh stale items.', tag: 'weekend', time: H(9) },
      { key: 'sat-prep-meta', title: "Prep next week's Meta campaigns", note: 'Line up launches so Monday is plug-and-play.', tag: 'weekend', time: H(10, 30) },
    ],
    0: [ // Sunday
      { key: 'sun-schedule-posts', title: 'Schedule TikTok posts', note: 'Post day. Batch the front half of the week.', tag: 'weekend', time: H(9, 30) },
      { key: 'sun-catchup', title: "Finish anything Saturday didn't", note: 'Listings, prep, loose ends.', tag: 'weekend', time: H(11) },
    ],
  };

  const IS_WEEKEND = (day) => day === 0 || day === 6;

  // Blocks for a getDay() index, training placeholder filled, fresh copies.
  function blocksForDay(day) {
    if (IS_WEEKEND(day)) return WEEKEND_BLOCKS.map((b) => ({ ...b }));
    const training = TRAINING_BY_DAY[day];
    return WEEKDAY_BLOCKS.map((b) => ({
      ...b,
      activity: b.activity === '__TRAINING__' ? training : b.activity,
    }));
  }

  // Tasks for a getDay() index, sorted by suggested time, as fresh copies.
  function tasksForDay(day) {
    return (TASKS_BY_DAY[day] || []).slice().sort((a, b) => a.time - b.time).map((t) => ({ ...t }));
  }

  // Flat lookup: task_key → { ...task, day }. Lets carryover rows (which only
  // know their key) recover title/note/tag/time and the weekday they belong to.
  const TASK_BY_KEY = {};
  for (const day of Object.keys(TASKS_BY_DAY)) {
    for (const t of TASKS_BY_DAY[day]) TASK_BY_KEY[t.key] = { ...t, day: Number(day) };
  }

  window.NOW_DATA = { blocksForDay, tasksForDay, DAY_LABEL, TASK_BY_KEY, IS_WEEKEND };
})();
