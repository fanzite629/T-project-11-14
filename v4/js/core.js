/* T计划 v4 core rules. Pure functions only: no DOM, storage or network access. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TPlanCore = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const VERSION = 1;
  const MAX_ACTIONS = 20;
  const MAX_STEPS = 12;
  const SPACE_COLORS = ['#E8825A', '#5B8DEF', '#4FA37A', '#B079D6', '#D9A441', '#4BA3B5'];

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const uid = (prefix) => prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sum = (list, pick) => list.reduce((n, x) => n + pick(x), 0);

  /* ---------- dates (local time, YYYY-MM-DD) ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const todayISO = (now = new Date()) => iso(now);
  function validDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T12:00:00');
    return !isNaN(d) && iso(d) === s;
  }
  function addDays(s, n) {
    const d = new Date(s + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return iso(d);
  }
  /* Monday of the week containing s. */
  function weekStart(s) {
    const d = new Date(s + 'T12:00:00');
    return addDays(s, -((d.getDay() + 6) % 7));
  }

  /* ---------- state ---------- */
  function emptyState() {
    const names = ['学习', '项目', '习惯与健康', '生活'];
    return {
      version: VERSION,
      spaces: names.map((name, i) => ({ id: 'space_' + (i + 1), name, color: SPACE_COLORS[i] })),
      tasks: [],
      habits: [],
      goals: [],
      sessions: [],
      messages: [],
      memory: [],
      timer: null,
      settings: {
        agent: { provider: 'openai', baseUrl: '', modelId: '' },
        prefs: { segment: 25, dailyMinutes: null, bestTime: null, onboarded: false },
      },
    };
  }

  /* Repairs missing fields so older or hand-edited exports still load. Rejects newer versions. */
  function normalize(raw) {
    if (!isObject(raw)) throw new Error('数据不是有效的对象');
    if ((raw.version || 0) > VERSION) throw new Error('这是更新版本的数据，请使用新版软件打开');
    const base = emptyState();
    const s = { ...base, ...raw, version: VERSION };
    for (const key of ['spaces', 'tasks', 'habits', 'goals', 'sessions', 'messages', 'memory']) if (!Array.isArray(s[key])) s[key] = base[key];
    s.settings = { ...base.settings, ...(isObject(raw.settings) ? raw.settings : {}) };
    s.settings.agent = { ...base.settings.agent, ...(isObject(s.settings.agent) ? s.settings.agent : {}) };
    s.settings.prefs = { ...base.settings.prefs, ...(isObject(s.settings.prefs) ? s.settings.prefs : {}) };
    const spaceIds = new Set(s.spaces.map((x) => x.id));
    const goalIds = new Set(s.goals.map((x) => x.id));
    for (const t of s.tasks) {
      if (!validDate(t.date)) t.date = null;
      if (!spaceIds.has(t.spaceId)) t.spaceId = null;
      if (!goalIds.has(t.goalId)) t.goalId = null;
      if (!Array.isArray(t.steps) || !t.steps.length) delete t.steps;
      t.done = !!t.done;
    }
    for (const h of s.habits) {
      if (!isObject(h.log)) h.log = {};
      if (!spaceIds.has(h.spaceId)) h.spaceId = null;
    }
    for (const g of s.goals) {
      if (!Array.isArray(g.milestones)) g.milestones = [];
      if (!spaceIds.has(g.spaceId)) g.spaceId = null;
    }
    if (s.timer && !s.tasks.some((t) => t.id === s.timer.taskId)) s.timer = null;
    return s;
  }

  /* ---------- small validators ---------- */
  function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, max);
  }
  function cleanMinutes(value, fallback, min = 1, max = 1440) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  }
  function spaceIdByName(state, name) {
    const wanted = cleanText(name, 40).toLowerCase();
    if (!wanted) return null;
    const hit = state.spaces.find((x) => x.name.toLowerCase() === wanted || x.id === name);
    return hit ? hit.id : null;
  }

  /* A task as the assistant may describe it. Steps are the timed segments of one sitting. */
  function taskFields(state, a, label = '任务') {
    const title = cleanText(a.title, 150);
    if (!title) throw new Error(label + '缺少标题');
    const out = { title, date: validDate(a.date) ? a.date : null, minutes: cleanMinutes(a.minutes, 30), spaceId: spaceIdByName(state, a.space) };
    if (a.spaceId && state.spaces.some((x) => x.id === a.spaceId)) out.spaceId = a.spaceId;
    if (Array.isArray(a.steps) && a.steps.length) {
      out.steps = a.steps.slice(0, MAX_STEPS).map((step) => {
        const stepTitle = cleanText(isObject(step) ? step.title : step, 100);
        if (!stepTitle) throw new Error(label + '的步骤缺少内容');
        return { title: stepTitle, minutes: cleanMinutes(isObject(step) ? step.minutes : null, 25, 1, 180) };
      });
      out.minutes = sum(out.steps, (x) => x.minutes);
    }
    return out;
  }

  /* ---------- assistant actions ----------
     The assistant can only propose these. Nothing changes until the user confirms the proposal. */
  function validateActions(state, rawActions) {
    const accepted = [];
    const rejected = [];
    const list = Array.isArray(rawActions) ? rawActions.slice(0, MAX_ACTIONS) : [];
    for (const raw of list) {
      try {
        accepted.push(validateAction(state, raw));
      } catch (error) {
        rejected.push(error.message);
      }
    }
    return { actions: accepted, rejected };
  }

  function validateAction(state, a) {
    if (!isObject(a)) throw new Error('操作格式无效');
    const existing = (id) => {
      const t = state.tasks.find((x) => x.id === id);
      if (!t) throw new Error('引用的任务不存在');
      return t;
    };
    switch (a.type) {
      case 'add_task':
        return { type: 'add_task', ...taskFields(state, a) };
      case 'update_task': {
        const t = existing(a.taskId);
        const out = { type: 'update_task', taskId: t.id };
        if (a.title !== undefined) {
          out.title = cleanText(a.title, 150);
          if (!out.title) throw new Error('任务标题不能为空');
        }
        if (a.date !== undefined) out.date = validDate(a.date) ? a.date : null;
        if (a.minutes !== undefined) out.minutes = cleanMinutes(a.minutes, t.minutes);
        if (Object.keys(out).length === 2) throw new Error('修改任务时没有给出新内容');
        return out;
      }
      case 'complete_task':
        return { type: 'complete_task', taskId: existing(a.taskId).id };
      case 'delete_task':
        return { type: 'delete_task', taskId: existing(a.taskId).id };
      case 'add_habit': {
        const title = cleanText(a.title, 80);
        if (!title) throw new Error('习惯缺少名称');
        const perWeek = Math.round(Number(a.perWeek));
        return { type: 'add_habit', title, perWeek: perWeek >= 1 && perWeek <= 7 ? perWeek : 7, spaceId: spaceIdByName(state, a.space) };
      }
      case 'add_goal': {
        const title = cleanText(a.title, 150);
        if (!title) throw new Error('目标缺少名称');
        const spaceId = spaceIdByName(state, a.space);
        let budget = 40;
        const milestones = (Array.isArray(a.milestones) ? a.milestones : []).slice(0, 12).map((m) => {
          const name = cleanText(isObject(m) ? m.title : '', 120);
          if (!name) throw new Error('目标的阶段缺少名称');
          const tasks = (Array.isArray(m.tasks) ? m.tasks : []).slice(0, Math.max(0, budget)).map((t) => {
            const fields = taskFields(state, t, '阶段任务');
            if (!fields.spaceId) fields.spaceId = spaceId;
            return fields;
          });
          budget -= tasks.length;
          return { title: name, due: validDate(m.due) ? m.due : null, tasks };
        });
        if (!milestones.length) throw new Error('目标至少需要一个阶段');
        return { type: 'add_goal', title, deadline: validDate(a.deadline) ? a.deadline : null, spaceId, milestones };
      }
      case 'remember': {
        const text = cleanText(a.text, 300);
        if (!text) throw new Error('记忆内容为空');
        return { type: 'remember', text };
      }
      default:
        throw new Error('不支持的操作类型');
    }
  }

  function newTask(fields, now, origin, extra) {
    const task = { id: uid('t'), title: fields.title, date: fields.date, minutes: fields.minutes, spaceId: fields.spaceId, done: false, doneAt: null, createdAt: now, origin, ...extra };
    if (fields.steps) task.steps = fields.steps.map((x) => ({ title: x.title, minutes: x.minutes, done: false }));
    return task;
  }

  function applyAction(s, a, now, origin, created) {
    if (a.type === 'add_task') {
      const task = newTask(a, now, origin);
      s.tasks.push(task);
      created.push(task.id);
    } else if (a.type === 'update_task') {
      const t = s.tasks.find((x) => x.id === a.taskId);
      for (const key of ['title', 'date', 'minutes']) if (a[key] !== undefined) t[key] = a[key];
    } else if (a.type === 'complete_task') {
      const t = s.tasks.find((x) => x.id === a.taskId);
      if (!t.done) { t.done = true; t.doneAt = now; }
    } else if (a.type === 'delete_task') {
      s.tasks = s.tasks.filter((x) => x.id !== a.taskId);
      if (s.timer && s.timer.taskId === a.taskId) s.timer = null;
    } else if (a.type === 'add_habit') {
      s.habits.push({ id: uid('h'), title: a.title, perWeek: a.perWeek, spaceId: a.spaceId, log: {}, createdAt: now });
    } else if (a.type === 'add_goal') {
      const goal = { id: uid('g'), title: a.title, deadline: a.deadline, spaceId: a.spaceId, createdAt: now, origin, milestones: a.milestones.map((m) => ({ title: m.title, due: m.due })) };
      s.goals.push(goal);
      a.milestones.forEach((m, index) => m.tasks.forEach((fields) => {
        const task = newTask(fields, now, origin, { goalId: goal.id, milestone: index });
        s.tasks.push(task);
        created.push(task.id);
      }));
    } else if (a.type === 'remember') {
      addMemory(s, a.text, now, origin);
    }
  }

  function addMemory(s, text, now, source) {
    const clean = cleanText(text, 300);
    if (!clean || s.memory.some((m) => m.text === clean)) return false;
    s.memory.push({ id: uid('m'), text: clean, at: now, source });
    if (s.memory.length > 80) s.memory = s.memory.slice(-80);
    return true;
  }

  /* Applies a pending proposal attached to a message. Returns a new state; the input is untouched.
     Actions are re-validated against current data, so a proposal that went stale fails as a whole. */
  function resolveProposal(state, messageId, accept, now = Date.now()) {
    const s = clone(state);
    const message = s.messages.find((m) => m.id === messageId);
    if (!message || !message.proposal) throw new Error('找不到这份提议');
    const p = message.proposal;
    if (p.status !== 'pending') return s;
    if (!accept) { p.status = 'dismissed'; p.resolvedAt = now; return s; }
    const checked = validateActions(s, p.actions);
    if (checked.rejected.length) throw new Error('提议里的任务已经变化：' + checked.rejected[0] + '。请让助手重新提议。');
    const created = [];
    for (const action of checked.actions) applyAction(s, action, now, p.source, created);
    p.status = 'accepted';
    p.resolvedAt = now;
    p.created = created;
    return s;
  }

  /* ---------- habits ---------- */
  function habitWeekCount(habit, anyDateInWeek) {
    const start = weekStart(anyDateInWeek);
    let count = 0;
    for (let i = 0; i < 7; i++) if (habit.log[addDays(start, i)]) count++;
    return count;
  }

  /* ---------- segmented timer ----------
     The timer walks through a task's steps one at a time. Time is derived from timestamps, so a
     reload or a sleeping tab never loses or invents minutes. Every finished step becomes a session:
     the factual record that the profile below is computed from. */
  function timerElapsed(timer, now) {
    return timer.acc + (timer.phase === 'running' ? Math.max(0, now - timer.lastAt) : 0);
  }
  function timerView(state, now) {
    const timer = state.timer;
    if (!timer) return null;
    const task = state.tasks.find((t) => t.id === timer.taskId);
    const step = task.steps[timer.step];
    const elapsedMs = timerElapsed(timer, now);
    const remainingMs = step.minutes * 60000 - elapsedMs;
    return { task, step, index: timer.step, total: task.steps.length, elapsedMs, remainingMs, due: remainingMs <= 0, running: timer.phase === 'running' };
  }
  function startTimer(state, taskId, now) {
    if (state.timer) throw new Error('已经有一个计时在进行，请先结束它');
    const s = clone(state);
    const task = s.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('任务已不存在');
    if (task.done) throw new Error('这个任务已经完成了');
    if (!task.date) task.date = todayISO(new Date(now)); // work started today belongs on today's list
    if (!task.steps) task.steps = [{ title: task.title, minutes: Math.min(180, task.minutes), done: false }];
    let index = task.steps.findIndex((x) => !x.done);
    if (index < 0) { task.steps.forEach((x) => { x.done = false; }); index = 0; }
    s.timer = { taskId, step: index, phase: 'running', acc: 0, lastAt: now, startedAt: now };
    return s;
  }
  function pauseTimer(state, now) {
    const s = clone(state);
    if (s.timer && s.timer.phase === 'running') { s.timer.acc = timerElapsed(s.timer, now); s.timer.phase = 'paused'; }
    return s;
  }
  function resumeTimer(state, now) {
    const s = clone(state);
    if (s.timer && s.timer.phase === 'paused') { s.timer.lastAt = now; s.timer.phase = 'running'; }
    return s;
  }
  function extendTimer(state, minutes = 5) {
    const s = clone(state);
    if (!s.timer) return s;
    const task = s.tasks.find((t) => t.id === s.timer.taskId);
    const step = task.steps[s.timer.step];
    step.minutes = Math.min(180, step.minutes + minutes);
    task.minutes = sum(task.steps, (x) => x.minutes);
    return s;
  }
  function recordSession(s, now, partial) {
    const view = timerView(s, now);
    const actual = Math.max(1, Math.round(view.elapsedMs / 60000));
    const session = {
      id: uid('s'), taskId: view.task.id, title: view.task.title, step: view.step.title, spaceId: view.task.spaceId,
      planned: view.step.minutes, actual, date: todayISO(new Date(now)), hour: new Date(now - view.elapsedMs).getHours(), endedAt: now, partial: !!partial,
    };
    s.sessions.push(session);
    return session;
  }
  /* Ends the current step and moves to the next one. The last step completes the task. */
  function finishStep(state, now) {
    if (!state.timer) throw new Error('没有正在进行的计时');
    const s = clone(state);
    // Under a minute means the step was skipped, not worked on: it is no evidence about the user's pace.
    const session = timerElapsed(s.timer, now) >= 60000 ? recordSession(s, now, false) : null;
    const task = s.tasks.find((t) => t.id === s.timer.taskId);
    task.steps[s.timer.step].done = true;
    const next = task.steps.findIndex((x) => !x.done);
    if (next >= 0) {
      s.timer = { ...s.timer, step: next, phase: 'running', acc: 0, lastAt: now };
      return { state: s, session, finishedTask: null };
    }
    task.done = true;
    task.doneAt = now;
    s.timer = null;
    return { state: s, session, finishedTask: task.id };
  }
  /* Stops without finishing the step. A minute or more of work is still recorded, marked partial. */
  function stopTimer(state, now) {
    const s = clone(state);
    if (!s.timer) return s;
    if (timerElapsed(s.timer, now) >= 60000) recordSession(s, now, true);
    s.timer = null;
    return s;
  }

  /* ---------- learner profile ----------
     Computed from recorded facts only (sessions, task dates, one-click feedback). A figure is left
     out until there is enough evidence for it, so the assistant never plans from one data point. */
  const DAY_BLOCKS = [['早上', 6, 12], ['下午', 12, 18], ['晚上', 18, 23]];
  const blockOf = (hour) => (DAY_BLOCKS.find(([, from, to]) => hour >= from && hour < to) || ['深夜'])[0];
  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  function buildProfile(state, today) {
    const sessions = state.sessions;
    const full = sessions.filter((x) => !x.partial);
    const profile = { sessionsRecorded: sessions.length };
    const ratio = (list) => Math.round((sum(list, (x) => x.actual) / sum(list, (x) => x.planned)) * 100) / 100;
    if (full.length >= 3) {
      profile.actualVsPlanned = ratio(full);
      const bySpace = {};
      for (const sp of state.spaces) {
        const list = full.filter((x) => x.spaceId === sp.id);
        if (list.length >= 3) bySpace[sp.name] = ratio(list);
      }
      if (Object.keys(bySpace).length) profile.actualVsPlannedBySpace = bySpace;
      profile.typicalFocusMinutes = median(full.map((x) => x.actual));
    }
    if (sessions.length >= 5) {
      const blocks = {};
      for (const x of sessions) blocks[blockOf(x.hour)] = (blocks[blockOf(x.hour)] || 0) + x.actual;
      profile.focusMinutesByTimeOfDay = blocks;
    }
    const days = new Set(sessions.map((x) => x.date));
    if (days.size >= 3) profile.focusMinutesPerActiveDay = Math.round(sum(sessions, (x) => x.actual) / days.size);
    const from = addDays(today, -14);
    const dated = state.tasks.filter((t) => t.date && t.date >= from && t.date < today);
    if (dated.length >= 5) profile.last14Days = { planned: dated.length, done: dated.filter((t) => t.done).length };
    const feels = { easy: 0, ok: 0, hard: 0 };
    for (const t of state.tasks) if (feels[t.feel] !== undefined) feels[t.feel]++;
    if (feels.easy + feels.ok + feels.hard) profile.difficultyFeedback = feels;
    profile.overdueOpenTasks = state.tasks.filter((t) => !t.done && t.date && t.date < today).length;
    return profile;
  }

  /* ---------- assistant context ---------- */
  /* Everything the model is allowed to see. Facts only; the model is told not to invent the rest. */
  function buildContext(state, today, text) {
    const spaceName = (id) => (state.spaces.find((x) => x.id === id) || {}).name || null;
    const toDay = (ms) => todayISO(new Date(ms));
    const recentCutoff = addDays(today, -14);
    return {
      today,
      weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(today + 'T12:00:00').getDay()],
      preferences: state.settings.prefs,
      profile: buildProfile(state, today),
      memory: state.memory.map((m) => m.text),
      spaces: state.spaces.map((x) => x.name),
      goals: state.goals.map((g) => {
        const tasks = state.tasks.filter((t) => t.goalId === g.id);
        return { title: g.title, deadline: g.deadline, milestones: g.milestones.map((m) => m.title), tasksDone: tasks.filter((t) => t.done).length, tasksTotal: tasks.length };
      }),
      openTasks: state.tasks.filter((t) => !t.done).slice(0, 200).map((t) => ({
        taskId: t.id, title: t.title, date: t.date, minutes: t.minutes, space: spaceName(t.spaceId),
        ...(t.steps ? { stepsDone: t.steps.filter((x) => x.done).length, stepsTotal: t.steps.length } : {}),
      })),
      recentlyDone: state.tasks.filter((t) => t.done && t.doneAt && toDay(t.doneAt) >= recentCutoff).slice(-60).map((t) => ({
        title: t.title, doneOn: toDay(t.doneAt), minutes: t.minutes, space: spaceName(t.spaceId), feel: t.feel || null,
      })),
      habits: state.habits.map((h) => ({ title: h.title, targetPerWeek: h.perWeek, doneThisWeek: habitWeekCount(h, today), doneToday: !!h.log[today] })),
      timerRunning: !!state.timer,
      history: state.messages.slice(-12).map((m) => ({ role: m.role, text: m.text.slice(0, 1500) })),
      message: text,
    };
  }

  /* Detailed records for the get_history tool. */
  function history(state, today, days) {
    const from = addDays(today, -Math.min(90, Math.max(1, Math.round(Number(days)) || 14)));
    return {
      from, to: today,
      sessions: state.sessions.filter((x) => x.date >= from).slice(-200).map((x) => ({ date: x.date, startHour: x.hour, task: x.title, step: x.step, planned: x.planned, actual: x.actual, partial: x.partial })),
      tasks: state.tasks.filter((t) => t.date && t.date >= from && t.date <= today).slice(-200).map((t) => ({ title: t.title, date: t.date, minutes: t.minutes, done: t.done, feel: t.feel || null })),
    };
  }

  /* ---------- offline fallback ---------- */
  const WEEKDAYS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  function parseLine(line, today) {
    let title = line;
    let date = null;
    let minutes = 30;
    const take = (re, fn) => {
      const m = title.match(re);
      if (m) { fn(m); title = title.replace(m[0], ' '); }
    };
    take(/(\d{4}-\d{2}-\d{2})/, (m) => { if (validDate(m[1])) date = m[1]; });
    take(/(\d{1,2})月(\d{1,2})[日号]/, (m) => {
      const year = Number(today.slice(0, 4));
      let d = year + '-' + pad(+m[1]) + '-' + pad(+m[2]);
      if (validDate(d) && d < today) d = year + 1 + d.slice(4);
      if (validDate(d)) date = d;
    });
    take(/(下)?(?:周|星期)([一二三四五六日天])/, (m) => {
      let d = addDays(weekStart(today), ((WEEKDAYS[m[2]] + 6) % 7) + (m[1] ? 7 : 0));
      if (!m[1] && d < today) d = addDays(d, 7);
      date = d;
    });
    take(/今天|明天|后天/, (m) => { date = addDays(today, { 今天: 0, 明天: 1, 后天: 2 }[m[0]]); });
    take(/(\d+(?:\.\d+)?)\s*(?:个)?(?:小时|h\b)/i, (m) => { minutes = cleanMinutes(Number(m[1]) * 60, 30); });
    take(/(\d+)\s*(?:分钟|min\b|m\b)/i, (m) => { minutes = cleanMinutes(m[1], 30); });
    title = cleanText(title.replace(/^[\s\-•·\d.、)]+/, '').replace(/[，,。；;]+$/, ''), 150);
    return title ? { type: 'add_task', title, date, minutes, space: null } : null;
  }

  /* Evenly sized segments for one sitting, used when no model is connected. */
  function splitIntoSteps(totalMinutes, segment) {
    const count = Math.min(MAX_STEPS, Math.max(1, Math.round(totalMinutes / segment)));
    const each = Math.round(totalMinutes / count);
    return Array.from({ length: count }, (_, i) => ({ title: i === count - 1 && count > 1 ? '回顾并记下卡住的地方' : '第 ' + (i + 1) + ' 段', minutes: each }));
  }

  function localReply(text, today, prefs = {}) {
    const lines = String(text).split(/\n+/).map((x) => x.trim()).filter(Boolean);
    const actions = [];
    for (const line of lines.slice(0, MAX_ACTIONS)) {
      const memo = line.match(/^(?:记住|请记住)[：:，,\s]*(.+)$/);
      if (memo) { actions.push({ type: 'remember', text: memo[1] }); continue; }
      const task = parseLine(line, today);
      if (!task) continue;
      if (task.minutes >= 45) {
        task.steps = splitIntoSteps(task.minutes, prefs.segment || 25);
        if (!task.date) task.date = today;
      }
      actions.push(task);
    }
    const planned = actions.find((a) => a.steps);
    return {
      reply: !actions.length
        ? '现在是本地模式，我只能把你写的每一行变成任务。连接 AI 模型后，我才能读课件、回答问题和帮你做计划。'
        : planned
          ? '现在是本地模式（没有连接 AI 模型），我按你习惯的 ' + (prefs.segment || 25) + ' 分钟把它分成了几段。连接模型后我可以根据课件内容来分。'
          : '现在是本地模式（没有连接 AI 模型），我把每一行当作一件事。请检查下面的提议。',
      actions,
      options: [],
      memory: [],
      startTimer: !!planned && lines.length === 1,
    };
  }

  return {
    VERSION, SPACE_COLORS,
    clone, uid, todayISO, validDate, addDays, weekStart,
    emptyState, normalize, validateActions, resolveProposal, addMemory,
    habitWeekCount, timerElapsed, timerView, startTimer, pauseTimer, resumeTimer, extendTimer, finishStep, stopTimer,
    buildProfile, buildContext, history, parseLine, splitIntoSteps, localReply,
  };
});
