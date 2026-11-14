/* T计划 v4 UI. State lives in one object; every change goes through commit(), which saves first
   and only then re-renders, so a failed save never leaves the screen ahead of the stored data. */
(function () {
  'use strict';

  const C = window.TPlanCore;
  const Agent = window.TPlanAgent;
  const Files = window.TPlanFiles;
  const platform = window.TPlanPlatform;
  const Providers = window.TPlanProviders;
  const $ = (selector) => document.querySelector(selector);

  let state = loadState();
  // Settings from the first v4 build are mapped onto the provider presets; its single key moves to that provider.
  state.settings.agent = Providers.migrate(state.settings.agent);
  try {
    const key = platform.loadKey(state.settings.agent.provider, state.settings.agent.provider);
    if (key) platform.saveKey(state.settings.agent.provider, key, state.settings.agent.provider);
  } catch { /* keys stay as they were */ }
  const ui = { view: 'chat', space: null, tab: 'today', busy: false, busyText: '', draft: '', attachments: [], parsing: 0 };
  const library = new Map(); // files read during this session, by name; kept out of saved state because they are large
  let pip = null; // floating timer window, when open
  let dueNotified = null;
  let editing = null; // the proposal step whose title is being edited: { message, action, step }
  const answers = new Map(); // unsent picks in question forms, by message id
  let lastChatKey = '';

  /* ---------- storage ---------- */
  function loadState() {
    try {
      const raw = platform.loadState();
      return raw ? C.normalize(JSON.parse(raw)) : C.emptyState();
    } catch (error) {
      alert('数据读取失败：' + error.message + '\n为了不覆盖原记录，本次不会保存任何修改。');
      platform.saveState = () => { throw new Error('数据读取失败，已停止保存'); };
      return C.emptyState();
    }
  }
  function commit(next) {
    try {
      platform.saveState(JSON.stringify(next));
    } catch (error) {
      toast('没有保存：' + error.message);
      return false;
    }
    state = next;
    render();
    return true;
  }
  /* Convenience for small edits: mutate a copy, then commit it. */
  function change(mutate) {
    const next = C.clone(state);
    mutate(next);
    return commit(next);
  }

  /* ---------- DOM helpers (text is always set as text, never as HTML) ---------- */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style') el.style.cssText = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key in el && key !== 'list') el[key] = value;
      else el.setAttribute(key, value);
    }
    for (const child of children.flat(Infinity)) if (child != null && child !== false) el.append(child);
    return el;
  }
  const ICONS = {
    gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-3.5c0-.5 0-.9-.1-1.3l2-1.5-2-3.4-2.3.9c-.7-.6-1.5-1-2.3-1.3L14.3 3h-4l-.4 2.4c-.8.3-1.6.7-2.3 1.3l-2.3-.9-2 3.4 2 1.5a8 8 0 0 0 0 2.6l-2 1.5 2 3.4 2.3-.9c.7.6 1.5 1 2.3 1.3l.4 2.4h4l.4-2.4c.8-.3 1.6-.7 2.3-1.3l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.3Z',
    plus: 'M12 5v14M5 12h14',
    send: 'M12 19V5M5 12l7-7 7 7',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    brain: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5v4l3 2',
    clip: 'M20 11.5l-8.2 8.2a5 5 0 0 1-7-7L13 4.400a3.300 3.300 0 0 1 4.700 4.700l-8.200 8.200a1.700 1.700 0 0 1-2.400-2.400L14.600 7.500',
    play: 'M8 5.500v13l10.500-6.500Z',
    pause: 'M8 5v14M16 5v14',
    close: 'M6 6l12 12M18 6L6 18',
    pop: 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    file: 'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7Zm0 0v4h4',
    minus: 'M6 12h12',
    up: 'M6 14l6-6 6 6',
    shrink: 'M5 19h14',
    grow: 'M8 4H4v4M16 20h4v-4M4 4l6 6M20 20l-6-6',
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }
  let toastTimer;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  /* ---------- formatting ---------- */
  const today = () => C.todayISO();
  const space = (id) => state.spaces.find((x) => x.id === id) || null;
  const plainDate = (date) => Number(date.slice(5, 7)) + '月' + Number(date.slice(8)) + '日';
  function dateLabel(date) {
    if (!date) return '未定日期';
    const t = today();
    if (date === t) return '今天';
    if (date === C.addDays(t, 1)) return '明天';
    if (date === C.addDays(t, -1)) return '昨天';
    return plainDate(date) + ' 周' + '日一二三四五六'[new Date(date + 'T12:00:00').getDay()];
  }
  const minutesLabel = (m) => (m >= 60 ? (m % 60 ? Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分' : m / 60 + ' 小时') : m + ' 分钟');
  const timeLabel = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const clock = (ms) => {
    const seconds = Math.floor(Math.abs(ms) / 1000);
    return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  };
  const modelName = () => {
    const a = state.settings.agent;
    return a.modelId && a.baseUrl ? a.modelId : null;
  };
  const say = (s, text, extra) => s.messages.push({ id: C.uid('msg'), role: 'assistant', at: Date.now(), source: 'local', text, ...extra });

  const fileChip = (f, onRemove) => h('span', { class: 'file-chip' + (f.thumb ? ' has-thumb' : '') },
    f.thumb ? h('img', { class: 'thumb', src: f.thumb, alt: '' }) : icon('file'),
    h('span', { class: 'file-name' }, f.name), h('span', { class: 'sub' }, f.kind + ' · ' + f.units),
    onRemove ? h('button', { class: 'chip-x', 'aria-label': '移除 ' + f.name, onclick: onRemove }, icon('close')) : null);

  /* ---------- first-run interview: three questions answered by clicking ---------- */
  const ONBOARDING = [
    { key: 'segment', text: '你好，我是你的规划助手。先问三个小问题，点一下就行。\n\n你一次能专注多久？', options: [['15 分钟', 15], ['25 分钟', 25], ['30 分钟', 30], ['45 分钟', 45]] },
    { key: 'dailyMinutes', text: '平时每天大约有多少时间可以自己安排（学习、项目）？', options: [['1 小时', 60], ['2 小时', 120], ['3 小时', 180], ['4 小时以上', 240]] },
    { key: 'bestTime', text: '一天中什么时候效率最高？', options: [['早上', '早上'], ['下午', '下午'], ['晚上', '晚上'], ['深夜', '深夜']] },
  ];
  const STARTERS = ['帮我规划今天', '我现在有 2 小时，想学习一份课件', '我有一个大目标，帮我拆开'];
  const askOnboarding = (s, index) => say(s, ONBOARDING[index].text, { options: ONBOARDING[index].options.map(([label, value]) => ({ label, pref: { index, value } })) });
  function answerOnboarding(option) {
    change((s) => {
      s.messages.push({ id: C.uid('msg'), role: 'user', text: option.label, at: Date.now() });
      s.settings.prefs[ONBOARDING[option.pref.index].key] = option.pref.value;
      if (option.pref.index + 1 < ONBOARDING.length) return askOnboarding(s, option.pref.index + 1);
      s.settings.prefs.onboarded = true;
      say(s, '好了，我记住了。以后我会根据你真实的计时记录慢慢调整安排。\n\n现在你可以把课件（PDF、PPT、Word、Excel）或代码文件拖进聊天框，告诉我你有多少时间，我来拆成一段一段并帮你计时。也可以直接点下面的选项。', { options: STARTERS.map((label) => ({ label })) });
    });
  }

  /* ---------- rail: spaces ---------- */
  function renderRail() {
    const item = (id, name, color, letter) =>
      h('button', { class: 'rail-item' + (ui.space === id ? ' active' : ''), onclick: () => { ui.space = id; render(); }, title: name },
        h('span', { class: 'avatar', style: 'background:' + color }, letter),
        h('span', { class: 'rail-label' }, name));
    $('#rail').replaceChildren(
      item(null, '全部', 'var(--ink)', '全'),
      h('div', { class: 'rail-rule' }),
      ...state.spaces.map((s) => item(s.id, s.name, s.color, s.name.slice(0, 1))),
      h('button', { class: 'rail-item', onclick: () => openSpaceDialog(null) },
        h('span', { class: 'avatar dashed' }, icon('plus')), h('span', { class: 'rail-label' }, '新分区')),
    );
  }

  /* ---------- list: tasks, habits, goals ---------- */
  function visibleTasks() {
    const t = today();
    const weekEnd = C.addDays(C.weekStart(t), 6);
    return state.tasks
      .filter((x) => !ui.space || x.spaceId === ui.space)
      .filter((x) => {
        if (ui.tab === 'today') return x.date && (x.date === t || (x.date < t && !x.done));
        if (ui.tab === 'week') return x.date && x.date > t && x.date <= weekEnd;
        return !x.date || x.date > weekEnd;
      })
      .sort((a, b) => a.done - b.done || (a.date || '9999').localeCompare(b.date || '9999') || a.createdAt - b.createdAt);
  }
  function taskRow(t) {
    const sp = space(t.spaceId);
    const overdue = !t.done && t.date && t.date < today();
    const timing = state.timer && state.timer.taskId === t.id;
    return h('div', { class: 'task' + (t.done ? ' done' : '') + (timing ? ' timing' : '') },
      h('button', {
        class: 'check', 'aria-label': t.done ? '标记为未完成' : '标记为完成', 'aria-pressed': String(t.done),
        onclick: () => change((s) => { const x = s.tasks.find((y) => y.id === t.id); x.done = !x.done; x.doneAt = x.done ? Date.now() : null; if (x.done && s.timer && s.timer.taskId === x.id) s.timer = null; }),
      }, t.done ? icon('check') : null),
      h('button', { class: 'task-body', onclick: () => openTaskDialog(t) },
        h('span', { class: 'task-title' }, t.title),
        h('span', { class: 'task-meta' },
          sp ? h('span', { class: 'dot', style: 'background:' + sp.color }) : null,
          h('span', { class: overdue ? 'overdue' : '' }, overdue ? '已过期 · ' + dateLabel(t.date) : dateLabel(t.date)),
          h('span', {}, '· ' + minutesLabel(t.minutes)),
          t.steps ? h('span', {}, '· ' + t.steps.filter((x) => x.done).length + '/' + t.steps.length + ' 段') : null)),
      !t.done && !state.timer ? h('button', { class: 'play', 'aria-label': '开始计时：' + t.title, title: '开始计时', onclick: () => beginTimer(t.id) }, icon('play')) : null);
  }
  function habitRow(habit) {
    const t = today();
    const count = C.habitWeekCount(habit, t);
    const done = !!habit.log[t];
    return h('div', { class: 'habit' },
      h('button', {
        class: 'check round' + (done ? ' on' : ''), 'aria-label': '今天' + (done ? '已完成' : '未完成') + '：' + habit.title, 'aria-pressed': String(done),
        onclick: () => change((s) => { const x = s.habits.find((y) => y.id === habit.id); if (x.log[t]) delete x.log[t]; else x.log[t] = true; }),
      }, done ? icon('check') : null),
      h('button', { class: 'task-body', onclick: () => openHabitDialog(habit) },
        h('span', { class: 'task-title' }, habit.title),
        h('span', { class: 'task-meta' }, '本周 ' + count + ' / ' + habit.perWeek)),
      h('span', { class: 'meter', 'aria-hidden': 'true' }, h('span', { style: 'width:' + Math.min(100, (count / habit.perWeek) * 100) + '%' })));
  }
  function goalCard(goal) {
    const tasks = state.tasks.filter((t) => t.goalId === goal.id);
    const done = tasks.filter((t) => t.done).length;
    return h('div', { class: 'goal' },
      h('div', { class: 'goal-head' },
        h('strong', {}, goal.title),
        h('button', { class: 'icon-btn small', 'aria-label': '删除目标', title: '删除目标', onclick: () => {
          if (confirm('删除目标「' + goal.title + '」？它的任务会保留。')) commit(C.normalize({ ...C.clone(state), goals: state.goals.filter((g) => g.id !== goal.id) }));
        } }, icon('trash'))),
      h('span', { class: 'task-meta' }, (goal.deadline ? '截止 ' + plainDate(goal.deadline) + ' · ' : '') + done + ' / ' + tasks.length + ' 项完成'),
      h('span', { class: 'meter wide', 'aria-hidden': 'true' }, h('span', { style: 'width:' + (tasks.length ? (done / tasks.length) * 100 : 0) + '%' })),
      h('ol', { class: 'milestones' }, goal.milestones.map((m, index) => {
        const mine = tasks.filter((t) => t.milestone === index);
        const finished = mine.length > 0 && mine.every((t) => t.done);
        return h('li', { class: finished ? 'done' : '' }, h('span', {}, m.title), h('span', { class: 'sub' }, mine.filter((t) => t.done).length + '/' + mine.length));
      })));
  }
  function renderList() {
    const tabs = [['today', '今天'], ['week', '本周'], ['later', '之后'], ['goals', '目标']];
    const current = space(ui.space);
    const inSpace = (x) => !ui.space || x.spaceId === ui.space;
    const tasks = ui.tab === 'goals' ? [] : visibleTasks();
    const habits = state.habits.filter(inSpace);
    const goals = state.goals.filter(inSpace);
    const open = state.tasks.filter((x) => inSpace(x) && !x.done && x.date && x.date <= today());
    const empty = { today: '今天还没有安排。告诉助手你想做什么，或者拖一份课件进来。', week: '本周后面几天还没有安排。', later: '没有以后的任务或未定日期的任务。' }[ui.tab];
    const body = ui.tab === 'goals'
      ? (goals.length ? goals.map(goalCard) : h('p', { class: 'empty' }, '还没有目标。在聊天里说「我想在 12 月底前学完单片机」，助手会拆成每周和每天的任务。'))
      : [tasks.length ? tasks.map(taskRow) : h('p', { class: 'empty' }, empty),
        ui.tab === 'today' && habits.length ? [h('h3', { class: 'group-title' }, '习惯'), ...habits.map(habitRow)] : null];
    $('#list').replaceChildren(
      h('header', { class: 'list-head' },
        h('div', {},
          h('h2', {}, current ? current.name : '全部安排'),
          h('p', { class: 'sub' }, '今天还有 ' + open.length + ' 项 · ' + minutesLabel(open.reduce((n, x) => n + x.minutes, 0)))),
        current ? h('button', { class: 'icon-btn', 'aria-label': '编辑分区', title: '编辑分区', onclick: () => openSpaceDialog(current) }, icon('gear')) : null),
      h('div', { class: 'segmented', role: 'tablist' }, tabs.map(([key, label]) =>
        h('button', { role: 'tab', 'aria-selected': String(ui.tab === key), class: ui.tab === key ? 'on' : '', onclick: () => { ui.tab = key; render(); } }, label))),
      h('div', { class: 'list-scroll' }, body),
      h('div', { class: 'list-foot' },
        h('button', { class: 'btn outline', onclick: () => openTaskDialog(null) }, icon('plus'), '新建任务'),
        h('button', { class: 'btn ghost', onclick: () => openHabitDialog(null) }, icon('plus'), '新习惯')));
  }

  /* ---------- chat ---------- */
  function taskSummary(a) {
    const sp = a.spaceId ? ' · ' + (space(a.spaceId) || {}).name : '';
    return dateLabel(a.date) + ' · ' + minutesLabel(a.minutes) + sp;
  }
  const stepList = (steps) => h('ol', { class: 'steps' }, steps.map((s, i) => h('li', {}, h('span', { class: 'num' }, i + 1 + '.'), h('span', { class: 'step-title' }, s.title), h('span', { class: 'sub' }, s.minutes + ' 分钟'))));
  /* The same list with controls: rename, change minutes, reorder, remove, add. */
  function editableSteps(message, index, a) {
    const steps = a.steps || [{ title: a.title, minutes: a.minutes }];
    const edit = (op) => { try { commit(C.editProposal(state, message.id, index, op)); } catch (error) { toast(error.message); } };
    const mini = (label, glyph, onclick, disabled) => h('button', { class: 'mini', 'aria-label': label, title: label, onclick, disabled }, icon(glyph));
    const isEditing = (i) => editing && editing.message === message.id && editing.action === index && editing.step === i;
    const titleInput = (s, i) => h('input', {
      class: 'step-input', value: s.title, maxLength: 100, 'aria-label': '第 ' + (i + 1) + ' 步的内容',
      onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { editing = null; render(); } },
      onblur: (e) => { if (!editing) return; editing = null; if (e.target.value.trim() && e.target.value.trim() !== s.title) edit({ kind: 'title', step: i, title: e.target.value }); else render(); },
    });
    return h('div', { class: 'steps-edit' },
      h('ol', { class: 'steps' }, steps.map((s, i) => h('li', {},
        h('span', { class: 'num' }, i + 1 + '.'),
        isEditing(i) ? titleInput(s, i) : h('button', { class: 'step-title editable', title: '点击修改', onclick: () => { editing = { message: message.id, action: index, step: i }; render(); } }, s.title),
        h('span', { class: 'step-tools' },
          mini('减少 5 分钟', 'minus', () => edit({ kind: 'minutes', step: i, delta: -5 }), s.minutes <= 5),
          h('span', { class: 'step-min' }, s.minutes + ' 分'),
          mini('增加 5 分钟', 'plus', () => edit({ kind: 'minutes', step: i, delta: 5 })),
          mini('上移', 'up', () => edit({ kind: 'move', step: i, dir: -1 }), i === 0),
          mini('删除这一步', 'close', () => edit({ kind: 'remove', step: i }), steps.length <= 1))))),
      h('div', { class: 'steps-foot' },
        h('button', { class: 'pill soft', onclick: () => edit({ kind: 'add' }) }, icon('plus'), '加一步'),
        h('span', { class: 'sub' }, '共 ' + minutesLabel(steps.reduce((n, s) => n + s.minutes, 0)) + ' · 点文字可以修改')));
  }
  function actionItem(a, index, message) {
    const name = (id) => (state.tasks.find((t) => t.id === id) || {}).title || '（任务已不存在）';
    const line = (kind, title, meta, extra) => h('li', {},
      h('div', { class: 'p-line' }, h('span', { class: 'tag t-' + a.type }, kind), h('span', { class: 'p-title' }, title), meta ? h('span', { class: 'sub' }, meta) : null), extra);
    if (a.type === 'add_task') return line('新任务', a.title, taskSummary(a), message.proposal.status === 'pending' ? editableSteps(message, index, a) : a.steps ? stepList(a.steps) : null);
    if (a.type === 'update_task') {
      const parts = [];
      if (a.title !== undefined) parts.push('改名为「' + a.title + '」');
      if (a.date !== undefined) parts.push('改到 ' + dateLabel(a.date));
      if (a.minutes !== undefined) parts.push('时长 ' + minutesLabel(a.minutes));
      return line('修改', name(a.taskId), parts.join(' · '));
    }
    if (a.type === 'complete_task') return line('完成', name(a.taskId));
    if (a.type === 'delete_task') return line('删除', name(a.taskId));
    if (a.type === 'add_habit') return line('新习惯', a.title, '每周 ' + a.perWeek + ' 次');
    if (a.type === 'add_goal') {
      return line('新目标', a.title, a.deadline ? '截止 ' + plainDate(a.deadline) : '', h('div', { class: 'goal-plan' }, a.milestones.map((m) => h('div', { class: 'milestone' },
        h('div', { class: 'milestone-title' }, m.title, m.due ? h('span', { class: 'sub' }, ' · ' + plainDate(m.due) + ' 前') : null),
        h('ul', {}, m.tasks.map((t) => h('li', {}, h('span', {}, t.title), h('span', { class: 'sub' }, taskSummary(t) + (t.steps ? ' · ' + t.steps.length + ' 段' : '')))))))));
    }
    if (a.type === 'add_reflection') {
      const pending = message.proposal.status === 'pending';
      return line('反思', a.date ? dateLabel(a.date) : '今天', pending ? '可以先改正识别错的字' : '', pending
        ? h('textarea', { class: 'reflection-edit', rows: Math.min(12, a.text.split('\n').length + 2), maxLength: 4000, value: a.text, 'aria-label': '反思内容',
          onchange: (e) => { try { commit(C.editProposal(state, message.id, index, { kind: 'text', text: e.target.value })); } catch (error) { toast(error.message); } } })
        : h('p', { class: 'reflection-text' }, a.text));
    }
    return line('记住', a.text);
  }
  function proposalCard(message) {
    const p = message.proposal;
    const status = { pending: '等待你确认 · 还没有写入', accepted: '已确认并写入', dismissed: '已放弃' }[p.status];
    const canTime = p.startTimer && !state.timer && p.actions.some((a) => a.type === 'add_task');
    const resolve = (accept, withTimer) => {
      try {
        let next = C.resolveProposal(state, message.id, accept);
        if (accept && withTimer) {
          const created = next.messages.find((m) => m.id === message.id).proposal.created.map((id) => next.tasks.find((t) => t.id === id));
          const first = created.find((t) => t.steps) || created[0];
          if (first) { next = C.startTimer(next, first.id, Date.now()); openFloating(); }
        }
        if (commit(next) && accept) toast(withTimer ? '已写入，计时开始' : '已写入');
      } catch (error) { toast(error.message); }
    };
    return h('div', { class: 'proposal ' + p.status },
      h('div', { class: 'proposal-head' }, h('strong', {}, '提议 · ' + p.actions.length + ' 项'), h('span', { class: 'sub' }, (p.edited ? '你修改过 · ' : '') + status)),
      h('ul', { class: 'p-list' }, p.actions.map((a, i) => actionItem(a, i, message))),
      p.status === 'pending' ? h('div', { class: 'proposal-actions' },
        canTime ? h('button', { class: 'btn dark', onclick: () => resolve(true, true) }, icon('play'), '确认并开始计时') : null,
        h('button', { class: canTime ? 'btn outline slim' : 'btn dark', onclick: () => resolve(true, false) }, canTime ? '只确认' : '确认写入'),
        h('button', { class: 'btn ghost', onclick: () => resolve(false) }, '放弃')) : null);
  }
  function chooseOption(option) {
    if (ui.busy) return;
    if (option.pref) return answerOnboarding(option);
    if (option.feel) {
      return change((s) => {
        const task = s.tasks.find((t) => t.id === option.feel.taskId);
        if (task) task.feel = option.feel.value;
        s.messages.push({ id: C.uid('msg'), role: 'user', text: option.label, at: Date.now() });
        say(s, { easy: '记下了。下次类似的内容我会安排得紧一些。', ok: '记下了，这个节奏适合你。', hard: '记下了。下次类似的内容我会拆得更小，时间留得更多。' }[option.feel.value]);
      });
    }
    send(option.label);
  }
  /* A form the assistant can ask with: pick options, optionally add a note, send once. */
  function questionCard(m, isLast) {
    const live = isLast && !m.answered && !ui.busy;
    if (!answers.has(m.id)) answers.set(m.id, { picks: m.questions.map(() => []), note: '' });
    const draft = answers.get(m.id);
    const ready = () => draft.picks.every((p) => p.length) || draft.note.trim();
    const submit = () => {
      if (!ready()) return toast('请先选择，或者写一句补充');
      const lines = m.questions.map((q, i) => (draft.picks[i].length ? q.question + ' ' + draft.picks[i].join('、') : null)).filter(Boolean);
      if (draft.note.trim()) lines.push(draft.note.trim());
      answers.delete(m.id);
      if (change((s) => { s.messages.find((x) => x.id === m.id).answered = true; })) send(lines.join('\n'));
    };
    return h('div', { class: 'ask' + (live ? '' : ' closed') },
      m.questions.map((q, i) => h('fieldset', { class: 'ask-q', disabled: !live },
        h('legend', {}, h('span', { class: 'num' }, i + 1 + '.'), q.question, q.multi ? h('span', { class: 'sub' }, ' 可多选') : null),
        h('div', { class: 'ask-options' }, q.options.map((option) => {
          const on = draft.picks[i].includes(option);
          return h('button', { class: 'pill pick' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: () => {
            draft.picks[i] = q.multi ? (on ? draft.picks[i].filter((x) => x !== option) : [...draft.picks[i], option]) : (on ? [] : [option]);
            render();
          } }, on ? icon('check') : null, option);
        })))),
      live ? h('div', { class: 'ask-foot' },
        h('input', { class: 'ask-note', placeholder: '想补充的话写在这里（可以不写）', maxLength: 300, value: draft.note,
          oninput: (e) => { draft.note = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) submit(); } }),
        h('button', { class: 'btn dark', onclick: submit }, '发送')) : h('span', { class: 'sub' }, m.answered ? '已回答' : '已跳过'));
  }
  function messageRow(m, isLast) {
    const mine = m.role === 'user';
    return h('div', { class: 'msg ' + (mine ? 'mine' : 'theirs') },
      h('div', { class: 'msg-meta' }, h('strong', {}, mine ? '你' : '规划助手'), h('span', {}, timeLabel(m.at)),
        m.source === 'local' && m.proposal ? h('span', { class: 'chip' }, '本地模式') : null,
        m.toolCalls ? h('span', { class: 'chip' }, '读取了 ' + m.toolCalls + ' 次资料') : null),
      m.attachments ? h('div', { class: 'files' }, m.attachments.map((f) => fileChip(f))) : null,
      m.text ? h('div', { class: 'bubble' + (m.error ? ' error' : '') }, m.text) : null,
      m.learned ? h('div', { class: 'learned' }, icon('brain'), '已记住：' + m.learned.join('；')) : null,
      m.proposal ? proposalCard(m) : null,
      m.questions ? questionCard(m, isLast) : null,
      isLast && m.options && !ui.busy ? h('div', { class: 'options' }, m.options.map((o) => h('button', { class: 'pill option', onclick: () => chooseOption(o) }, o.label))) : null);
  }
  function renderChat() {
    const model = modelName();
    const last = state.messages.length - 1;
    const previous = $('#chatScroll');
    const offset = previous ? previous.scrollTop : 0;
    const chatKey = state.messages.length + ':' + ui.busy + ':' + ui.busyText;
    const scroller = h('div', { class: 'chat-scroll', id: 'chatScroll' },
      state.messages.map((m, i) => messageRow(m, i === last)),
      ui.busy ? h('div', { class: 'msg theirs' }, h('div', { class: 'bubble typing', role: 'status' }, h('i'), h('i'), h('i'), ui.busyText ? h('span', { class: 'sub' }, ui.busyText) : null)) : null);
    const input = h('textarea', {
      id: 'composer', rows: 2, maxLength: 4000, value: ui.draft,
      placeholder: model ? '说说你想做什么，或把课件、图片、代码文件拖进来' : '本地模式：例如「单片机 2小时」。连接模型后可以读课件',
      oninput: (e) => { ui.draft = e.target.value; updateSend(); },
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } },
      onpaste: (e) => { const files = [...(e.clipboardData ? e.clipboardData.files : [])]; if (files.length) { e.preventDefault(); addFiles(files); } },
    });
    const picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { addFiles(e.target.files); e.target.value = ''; } });
    const main = $('#main');
    main.replaceChildren(
      h('header', { class: 'main-head' },
        h('div', {}, h('h2', {}, '规划助手'), h('p', { class: 'sub' }, model ? '模型：' + model : '本地模式 · 还没有连接 AI 模型')),
        h('div', { class: 'head-actions' },
          h('button', { class: 'pill soft', onclick: openMemoryDialog }, icon('brain'), h('span', {}, '记忆 ' + state.memory.length + ' 条')),
          !model ? h('button', { class: 'pill soft', onclick: () => openSettingsDialog() }, icon('plus'), h('span', {}, '连接模型')) : null)),
      scroller,
      h('div', { class: 'composer' },
        ui.attachments.length || ui.parsing ? h('div', { class: 'files' },
          ui.attachments.map((f) => fileChip(f, () => { ui.attachments = ui.attachments.filter((x) => x !== f); render(); })),
          ui.parsing ? h('span', { class: 'file-chip' }, '正在读取文件…') : null) : null,
        input,
        h('div', { class: 'composer-bar' },
          h('button', { class: 'icon-btn small', 'aria-label': '添加文件', title: '添加课件、图片或代码文件', onclick: () => picker.click() }, icon('clip')), picker,
          h('span', { class: 'sub grow' }, ui.space ? '当前分区：' + space(ui.space).name : '助手只会提议，你确认后才写入'),
          h('button', { class: 'send', id: 'send', 'aria-label': '发送', onclick: () => send() }, icon('send')))),
      h('div', { class: 'drop-hint' }, icon('file'), '松开，把文件交给助手'));
    updateSend();
    scroller.scrollTop = previous && chatKey === lastChatKey ? offset : scroller.scrollHeight;
    lastChatKey = chatKey;
    const stepInput = main.querySelector('.step-input');
    if (stepInput) { stepInput.focus(); stepInput.select(); }
  }
  function updateSend() {
    const button = $('#send');
    if (button) button.disabled = ui.busy || ui.parsing > 0 || !(ui.draft.trim() || ui.attachments.length);
  }

  async function addFiles(fileList) {
    const files = [...fileList].slice(0, 6);
    if (!files.length) return;
    if (ui.view !== 'chat') ui.view = 'chat';
    ui.parsing += files.length;
    render();
    for (const file of files) {
      try {
        const parsed = await Files.parseFile(file);
        if (!parsed.image) library.set(parsed.name, parsed);
        ui.attachments = ui.attachments.filter((x) => x.name !== parsed.name).concat(parsed);
      } catch (error) {
        toast(file.name + '：' + error.message);
      }
      ui.parsing--;
      render();
    }
    const box = $('#composer');
    if (box) box.focus();
  }

  const TOOL_LABELS = {
    read_attachment: (a) => '正在读取 ' + (a.name || '附件') + '…',
    read_path: (a) => '正在读取 ' + String(a.path || '文件').split(/[\\/]/).pop() + '…',
    list_dir: () => '正在查看文件夹…',
    get_history: () => '正在查看你的记录…',
  };
  async function send(preset) {
    const attachments = preset ? [] : ui.attachments;
    const pictures = attachments.filter((f) => f.image);
    const text = (preset || ui.draft).trim() || (pictures.length ? '请读一下图片里的内容，并帮我记录下来。' : attachments.length ? '请根据这些文件帮我安排学习。' : '');
    if (!text || ui.busy) return;
    if (pictures.length) {
      if (!modelName()) return toast('读图片需要先连接 AI 模型');
      if (!platform.canSeeImages) return toast('桌面版暂时不能发送图片');
      if (state.settings.agent.vision === false) return toast('测试时这个模型不能识图。请在设置里换一个能识图的模型。');
    }
    const context = C.buildContext(state, today(), text);
    if (ui.space) context.currentSpace = space(ui.space).name;
    const sent = { id: C.uid('msg'), role: 'user', text, at: Date.now() };
    if (attachments.length) sent.attachments = attachments.map((f) => ({ name: f.name, kind: f.kind, units: f.units, ...(f.thumb ? { thumb: f.thumb } : {}) }));
    if (!change((s) => s.messages.push(sent))) return;
    if (!preset) { ui.draft = ''; ui.attachments = []; }
    const useModel = !!modelName();
    let answer;
    let error = null;
    ui.busy = true;
    ui.busyText = '';
    render();
    try {
      if (useModel) {
        answer = await Agent.run({
          context, attachments, library,
          chat: (system, user, images) => platform.chat(state.settings.agent, system, user, images),
          tools: {
            read_path: async (a) => { const body = await platform.readPath(String(a.path)); return { path: a.path, totalChars: body.length, text: body.slice(0, 8000) }; },
            list_dir: async (a) => ({ path: a.path, entries: await platform.listDir(String(a.path)) }),
            get_history: (a) => C.history(state, today(), a.days),
          },
          onStep: (name, args) => { ui.busyText = (TOOL_LABELS[name] || (() => '正在查资料…'))(args); render(); },
        });
      } else {
        answer = C.localReply(text, today(), state.settings.prefs);
      }
    } catch (e) {
      error = e.message;
    }
    ui.busy = false;
    change((s) => {
      const now = Date.now();
      const message = { id: C.uid('msg'), role: 'assistant', at: now, source: useModel ? 'ai' : 'local', text: error || answer.reply };
      if (error) { message.error = true; s.messages.push(message); return; }
      const withSpace = answer.actions.map((a) => (a && a.type && a.space == null && ui.space ? { ...a, spaceId: ui.space } : a));
      const checked = C.validateActions(s, withSpace);
      // Memory notes are saved right away (they are easy to review and delete); everything else waits for confirmation.
      const notes = [...answer.memory, ...checked.actions.filter((a) => a.type === 'remember').map((a) => a.text)];
      const learned = notes.filter((note) => C.addMemory(s, note, now, message.source));
      if (learned.length) message.learned = learned;
      const actions = checked.actions.filter((a) => a.type !== 'remember');
      if (actions.length) message.proposal = { status: 'pending', source: message.source, actions, startTimer: answer.startTimer };
      if (checked.rejected.length) message.text += '\n（有 ' + checked.rejected.length + ' 项提议格式不对，已忽略。）';
      if (answer.questions.length) message.questions = answer.questions;
      else if (answer.options.length) message.options = answer.options.map((label) => ({ label }));
      if (answer.toolCalls) message.toolCalls = answer.toolCalls;
      s.messages.push(message);
      if (s.messages.length > 400) s.messages = s.messages.slice(-400);
    });
  }

  /* ---------- timer dock and floating window ---------- */
  function beginTimer(taskId) {
    try { if (commit(C.startTimer(state, taskId, Date.now()))) openFloating(); }
    catch (error) { toast(error.message); }
  }
  /* A real always-on-top window where the browser supports it; otherwise the dock stays in the page. */
  async function openFloating() {
    if (pip || !('documentPictureInPicture' in window)) return;
    try {
      const compact = state.settings.prefs.timerCompact;
      const win = await window.documentPictureInPicture.requestWindow({ width: compact ? 300 : 340, height: compact ? 84 : 250 });
      for (const link of document.querySelectorAll('link[rel=stylesheet]')) win.document.head.append(link.cloneNode());
      win.document.documentElement.className = 'light'; // the floating timer stays light whatever the system theme
      win.document.title = '计时';
      win.document.body.className = 'pip-body';
      win.addEventListener('pagehide', () => { pip = null; renderDock(); });
      pip = win;
      renderDock();
    } catch { /* the user or the browser declined; the in-page dock is still there */ }
  }
  function beep() {
    try {
      const audio = new AudioContext();
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      tone.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.8);
      tone.connect(gain).connect(audio.destination);
      tone.start();
      tone.stop(audio.currentTime + 0.8);
    } catch { /* sound is optional */ }
  }
  function finishCurrentStep() {
    const result = C.finishStep(state, Date.now());
    if (result.finishedTask) {
      const task = result.state.tasks.find((t) => t.id === result.finishedTask);
      const actual = result.state.sessions.filter((x) => x.taskId === task.id).reduce((n, x) => n + x.actual, 0);
      say(result.state, '完成了「' + task.title + '」。' + (actual ? '实际用时 ' + minutesLabel(actual) + '，计划 ' + minutesLabel(task.minutes) + '。' : '') + '\n感觉怎么样？点一下，我下次会安排得更合适。', {
        options: [['太简单', 'easy'], ['正好', 'ok'], ['太难', 'hard']].map(([label, value]) => ({ label, feel: { taskId: task.id, value } })),
      });
      if (pip) pip.close();
      ui.view = 'chat';
    }
    commit(result.state);
  }
  function renderDock() {
    const inPage = $('#dock');
    const view = C.timerView(state, Date.now());
    if (!view) { inPage.hidden = true; inPage.replaceChildren(); return; }
    const button = (label, cls, onclick, glyph) => h('button', { class: 'btn ' + cls, onclick }, glyph ? icon(glyph) : null, label);
    const last = view.index === view.total - 1;
    const compact = state.settings.prefs.timerCompact;
    const setCompact = (value) => {
      if (pip) { try { pip.resizeTo(value ? 300 : 340, value ? 84 + (pip.outerHeight - pip.innerHeight) : 250 + (pip.outerHeight - pip.innerHeight)); } catch { /* size stays as the user left it */ } }
      change((s) => { s.settings.prefs.timerCompact = value; });
    };
    const iconButton = (label, glyph, onclick, cls) => h('button', { class: 'icon-btn small ' + (cls || ''), 'aria-label': label, title: label, onclick }, icon(glyph));
    const content = compact ? h('div', { class: 'dock-card compact' },
      h('div', { class: 'dock-row' },
        h('div', { class: 'dock-time', id: 'dockTime' }),
        h('div', { class: 'dock-titles' }, h('span', { class: 'sub' }, '第 ' + (view.index + 1) + '/' + view.total + ' 段'), h('strong', { class: 'dock-step', title: view.step.title }, view.step.title)),
        view.running ? iconButton('暂停', 'pause', () => commit(C.pauseTimer(state, Date.now()))) : iconButton('继续', 'play', () => commit(C.resumeTimer(state, Date.now()))),
        iconButton(last ? '完成' : '下一段', 'check', finishCurrentStep, 'solid'),
        iconButton('展开', 'grow', () => setCompact(false))),
      h('div', { class: 'dock-dots', 'aria-hidden': 'true' }, view.task.steps.map((s, i) => h('span', { class: s.done ? 'done' : i === view.index ? 'now' : '', style: 'flex:' + s.minutes }, i === view.index ? h('i', { id: 'dockFill' }) : null))))
    : h('div', { class: 'dock-card' },
      h('div', { class: 'dock-head' },
        h('div', { class: 'dock-titles' },
          h('span', { class: 'sub' }, view.task.title + ' · 第 ' + (view.index + 1) + '/' + view.total + ' 段'),
          h('strong', { class: 'dock-step' }, view.step.title)),
        h('div', { class: 'dock-corner' },
          iconButton('最小化', 'shrink', () => setCompact(true)),
          !pip && 'documentPictureInPicture' in window ? iconButton('打开悬浮窗', 'pop', openFloating) : null)),
      h('div', { class: 'dock-time', id: 'dockTime' }),
      h('div', { class: 'dock-dots', 'aria-hidden': 'true' }, view.task.steps.map((s, i) => h('span', { class: s.done ? 'done' : i === view.index ? 'now' : '', style: 'flex:' + s.minutes }, i === view.index ? h('i', { id: 'dockFill' }) : null))),
      h('div', { class: 'dock-actions' },
        view.running ? button('暂停', 'outline slim', () => commit(C.pauseTimer(state, Date.now())), 'pause') : button('继续', 'outline slim', () => commit(C.resumeTimer(state, Date.now())), 'play'),
        button(last ? '完成' : '下一段', 'dark', finishCurrentStep, 'check'),
        button('+5 分', 'ghost', () => commit(C.extendTimer(state, 5))),
        button('结束', 'ghost', () => { if (pip) pip.close(); commit(C.stopTimer(state, Date.now())); })));
    // A running timer must stay visible: if the task column is closed and there is no floating window, open the column.
    if (!pip && state.settings.prefs.listWidth === 0) showListWidth(LIST.min);
    if (pip) { pip.document.body.replaceChildren(content); inPage.hidden = true; inPage.replaceChildren(); }
    else { inPage.replaceChildren(content); inPage.hidden = false; }
    tick();
  }
  /* Runs twice a second: updates the clock text only, and announces the end of a step once. */
  function tick() {
    const view = C.timerView(state, Date.now());
    if (!view) return;
    const doc = pip ? pip.document : document;
    const time = doc.getElementById('dockTime');
    if (!time) return;
    time.textContent = view.due ? '+' + clock(view.remainingMs) : clock(view.remainingMs);
    time.className = 'dock-time' + (view.due ? ' due' : '') + (view.running ? '' : ' paused');
    const fill = doc.getElementById('dockFill');
    if (fill) fill.style.width = Math.min(100, (view.elapsedMs / (view.step.minutes * 60000)) * 100) + '%';
    document.title = (view.due ? '到时间了 · ' : clock(view.remainingMs) + ' · ') + view.step.title;
    const key = view.task.id + ':' + view.index + ':' + view.step.minutes;
    if (view.due && view.running && dueNotified !== key) {
      dueNotified = key;
      beep();
      toast('「' + view.step.title + '」到时间了');
    }
  }
  setInterval(() => { if (state.timer) tick(); else if (document.title !== 'T计划') document.title = 'T计划'; }, 500);

  /* ---------- review ---------- */
  function profileLines() {
    const p = C.buildProfile(state, today());
    const prefs = state.settings.prefs;
    const lines = [];
    lines.push('你说：一次专注 ' + prefs.segment + ' 分钟' + (prefs.dailyMinutes ? '，每天可安排 ' + minutesLabel(prefs.dailyMinutes) : '') + (prefs.bestTime ? '，' + prefs.bestTime + '效率最高' : '') + '。');
    if (p.actualVsPlanned) lines.push('实际用时是计划的 ' + Math.round(p.actualVsPlanned * 100) + '%' + (p.actualVsPlanned > 1.15 ? '，你通常比计划慢，助手会把时间留多一些。' : p.actualVsPlanned < 0.85 ? '，你通常比计划快。' : '，估计比较准。'));
    if (p.typicalFocusMinutes) lines.push('你真实的一段专注大约 ' + p.typicalFocusMinutes + ' 分钟。');
    if (p.focusMinutesByTimeOfDay) {
      const [best, minutes] = Object.entries(p.focusMinutesByTimeOfDay).sort((a, b) => b[1] - a[1])[0];
      lines.push('记录里你在' + best + '专注得最多（' + minutesLabel(minutes) + '）。');
    }
    if (p.last14Days) lines.push('最近 14 天安排了 ' + p.last14Days.planned + ' 项，完成 ' + p.last14Days.done + ' 项。');
    if (p.difficultyFeedback) lines.push('你的反馈：太简单 ' + p.difficultyFeedback.easy + ' 次，正好 ' + p.difficultyFeedback.ok + ' 次，太难 ' + p.difficultyFeedback.hard + ' 次。');
    if (p.sessionsRecorded < 3) lines.push('计时记录还只有 ' + p.sessionsRecorded + ' 段。用计时完成 3 段以上，助手就能开始根据你的真实速度调整。');
    return lines;
  }
  function renderReview() {
    const t = today();
    const start = C.weekStart(t);
    const days = Array.from({ length: 7 }, (_, i) => C.addDays(start, i));
    const sessions = state.sessions.filter((x) => x.date >= start && x.date <= days[6]);
    const perDay = days.map((d) => sessions.filter((x) => x.date === d).reduce((n, x) => n + x.actual, 0));
    const max = Math.max(60, ...perDay);
    const doneWeek = state.tasks.filter((x) => x.done && x.doneAt && days.includes(C.todayISO(new Date(x.doneAt))));
    const planned = state.tasks.filter((x) => x.date && x.date >= start && x.date <= days[6]);
    const stat = (value, label) => h('div', { class: 'stat' }, h('strong', {}, value), h('span', { class: 'sub' }, label));
    $('#main').replaceChildren(
      h('header', { class: 'main-head' }, h('div', {}, h('h2', {}, '本周回看'), h('p', { class: 'sub' }, plainDate(days[0]) + ' 至 ' + plainDate(days[6]) + ' · 只显示已记录的事实'))),
      h('div', { class: 'review-scroll' },
        h('div', { class: 'stats' },
          stat(minutesLabel(perDay.reduce((a, b) => a + b, 0)), '本周计时的专注时间'),
          stat(String(sessions.length), '完成的计时段数'),
          stat(planned.filter((x) => x.done).length + ' / ' + planned.length, '本周安排的完成情况')),
        h('section', { class: 'card' }, h('h3', {}, '助手对你的了解'),
          h('ul', { class: 'plain' }, profileLines().map((line) => h('li', {}, line))),
          h('div', { class: 'row' }, h('button', { class: 'pill soft', onclick: openMemoryDialog }, icon('brain'), '查看和修改长期记忆（' + state.memory.length + ' 条）'))),
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', {}, '反思'), h('button', { class: 'pill soft', onclick: () => openReflectionDialog(null) }, icon('plus'), '写一条')),
          state.reflections.length ? h('div', { class: 'reflections' }, [...state.reflections].reverse().slice(0, 30).map((r) => h('article', { class: 'reflection' },
            h('header', {}, h('strong', {}, dateLabel(r.date)), h('span', { class: 'sub' }, r.source === 'user' ? '自己写的' : '助手记录的'),
              h('span', { class: 'grow' }),
              h('button', { class: 'icon-btn small', 'aria-label': '修改这条反思', title: '修改', onclick: () => openReflectionDialog(r) }, icon('gear'))),
            h('p', { class: 'reflection-text' }, r.text))))
            : h('p', { class: 'empty' }, '还没有反思。可以把写在本子上的反思拍照拖进聊天框，助手会读出文字并记录在这里。')),
        h('section', { class: 'card' }, h('h3', {}, '每天的专注时间'),
          h('div', { class: 'bars' }, days.map((d, i) => h('div', { class: 'bar' + (d === t ? ' today' : '') },
            h('span', { class: 'bar-value' }, perDay[i] ? String(perDay[i]) : ''),
            h('span', { class: 'bar-fill', style: 'height:' + (perDay[i] / max) * 100 + '%' }),
            h('span', { class: 'sub' }, '一二三四五六日'[i])))),
          h('p', { class: 'sub' }, '单位：分钟，来自计时记录。时间长短不代表学习效果。')),
        h('section', { class: 'card' }, h('h3', {}, '习惯'),
          state.habits.length ? h('div', { class: 'habit-grid' }, state.habits.map((habit) => h('div', { class: 'habit-line' },
            h('span', { class: 'task-title' }, habit.title),
            h('span', { class: 'cells' }, days.map((d) => h('span', { class: 'cell' + (habit.log[d] ? ' on' : ''), title: dateLabel(d) }))),
            h('span', { class: 'sub' }, C.habitWeekCount(habit, t) + ' / ' + habit.perWeek)))) : h('p', { class: 'empty' }, '还没有习惯。')),
        h('section', { class: 'card' }, h('h3', {}, '本周完成'),
          doneWeek.length ? h('ul', { class: 'plain' }, doneWeek.map((x) => h('li', {}, x.title, h('span', { class: 'sub' }, ' · ' + minutesLabel(x.minutes))))) : h('p', { class: 'empty' }, '本周还没有完成的任务。'))));
  }

  /* ---------- dialogs ---------- */
  function openDialog(title, fields, buttons) {
    const dialog = $('#dialog');
    const form = h('form', { method: 'dialog', onsubmit: (e) => e.preventDefault() }, h('h2', {}, title), ...fields, h('div', { class: 'dialog-actions' }, buttons));
    dialog.replaceChildren(form);
    if (!dialog.open) dialog.showModal();
    return form;
  }
  const closeDialog = () => $('#dialog').close();
  const field = (label, control) => h('label', { class: 'field' }, h('span', {}, label), control);
  const spaceSelect = (selected) => h('select', { name: 'space' }, h('option', { value: '' }, '不分区'),
    state.spaces.map((s) => h('option', { value: s.id, selected: s.id === selected }, s.name)));
  const cancelButton = () => h('button', { type: 'button', class: 'btn ghost', onclick: closeDialog }, '取消');

  function openTaskDialog(task) {
    const form = openDialog(task ? '编辑任务' : '新建任务', [
      field('要做什么', h('input', { name: 'title', maxLength: 150, required: true, value: task ? task.title : '' })),
      h('div', { class: 'row' },
        field('日期（可以留空）', h('input', { name: 'date', type: 'date', value: task ? task.date || '' : ui.tab === 'today' ? today() : '' })),
        field('预计分钟', h('input', { name: 'minutes', type: 'number', min: 1, max: 1440, value: task ? task.minutes : 30, disabled: !!(task && task.steps) }))),
      field('分区', spaceSelect(task ? task.spaceId : ui.space)),
      task && task.steps ? h('div', { class: 'field' }, h('span', {}, '分段（计时会按这个顺序进行）'),
        h('ol', { class: 'steps boxed' }, task.steps.map((s) => h('li', { class: s.done ? 'done' : '' }, h('span', {}, s.title), h('span', { class: 'sub' }, s.minutes + ' 分钟' + (s.done ? ' · 完成' : '')))))) : null,
    ], [
      task ? h('button', { type: 'button', class: 'btn danger', onclick: () => { if (confirm('删除这个任务？')) { change((s) => { s.tasks = s.tasks.filter((x) => x.id !== task.id); if (s.timer && s.timer.taskId === task.id) s.timer = null; }); closeDialog(); } } }, '删除') : null,
      h('span', { class: 'grow' }), cancelButton(),
      h('button', { class: 'btn dark', onclick: () => {
        const title = form.title.value.trim();
        const minutes = Math.round(Number(form.minutes.value));
        if (!title) return toast('请填写任务内容');
        if (!(minutes >= 1 && minutes <= 1440)) return toast('预计分钟请填 1–1440');
        const values = { title, minutes, date: C.validDate(form.date.value) ? form.date.value : null, spaceId: form.space.value || null };
        const ok = change((s) => {
          if (task) Object.assign(s.tasks.find((x) => x.id === task.id), values);
          else s.tasks.push({ id: C.uid('t'), ...values, done: false, doneAt: null, createdAt: Date.now(), origin: 'user' });
        });
        if (ok) closeDialog();
      } }, '保存'),
    ]);
    form.title.focus();
  }

  function openHabitDialog(habit) {
    const form = openDialog(habit ? '编辑习惯' : '新习惯', [
      field('习惯名称', h('input', { name: 'title', maxLength: 80, required: true, value: habit ? habit.title : '' })),
      h('div', { class: 'row' },
        field('每周几次', h('input', { name: 'perWeek', type: 'number', min: 1, max: 7, value: habit ? habit.perWeek : 3 })),
        field('分区', spaceSelect(habit ? habit.spaceId : ui.space))),
    ], [
      habit ? h('button', { type: 'button', class: 'btn danger', onclick: () => { if (confirm('删除这个习惯和它的打卡记录？')) { change((s) => { s.habits = s.habits.filter((x) => x.id !== habit.id); }); closeDialog(); } } }, '删除') : null,
      h('span', { class: 'grow' }), cancelButton(),
      h('button', { class: 'btn dark', onclick: () => {
        const title = form.title.value.trim();
        const perWeek = Math.round(Number(form.perWeek.value));
        if (!title) return toast('请填写习惯名称');
        if (!(perWeek >= 1 && perWeek <= 7)) return toast('每周次数请填 1–7');
        const values = { title, perWeek, spaceId: form.space.value || null };
        const ok = change((s) => {
          if (habit) Object.assign(s.habits.find((x) => x.id === habit.id), values);
          else s.habits.push({ id: C.uid('h'), ...values, log: {}, createdAt: Date.now() });
        });
        if (ok) closeDialog();
      } }, '保存'),
    ]);
    form.title.focus();
  }

  function openSpaceDialog(current) {
    let color = current ? current.color : C.SPACE_COLORS[state.spaces.length % C.SPACE_COLORS.length];
    const swatches = h('div', { class: 'swatches' }, C.SPACE_COLORS.map((c) =>
      h('button', { type: 'button', class: 'swatch' + (c === color ? ' on' : ''), style: 'background:' + c, 'aria-label': '颜色 ' + c,
        onclick: (e) => { color = c; swatches.querySelectorAll('.swatch').forEach((x) => x.classList.remove('on')); e.currentTarget.classList.add('on'); } })));
    const form = openDialog(current ? '编辑分区' : '新分区', [
      field('名称（例如一门课、一个项目）', h('input', { name: 'name', maxLength: 20, required: true, value: current ? current.name : '' })),
      field('颜色', swatches),
    ], [
      current ? h('button', { type: 'button', class: 'btn danger', onclick: () => {
        if (!confirm('删除分区「' + current.name + '」？里面的任务和习惯会保留，变成不分区。')) return;
        ui.space = null;
        commit(C.normalize({ ...C.clone(state), spaces: state.spaces.filter((x) => x.id !== current.id) }));
        closeDialog();
      } }, '删除') : null,
      h('span', { class: 'grow' }), cancelButton(),
      h('button', { class: 'btn dark', onclick: () => {
        const name = form.name.value.trim();
        if (!name) return toast('请填写分区名称');
        if (state.spaces.some((x) => x.name === name && x !== current)) return toast('已经有同名分区');
        const ok = change((s) => {
          if (current) Object.assign(s.spaces.find((x) => x.id === current.id), { name, color });
          else s.spaces.push({ id: C.uid('space'), name, color });
        });
        if (ok) closeDialog();
      } }, '保存'),
    ]);
    form.name.focus();
  }

  function openMemoryDialog() {
    const form = openDialog('长期记忆', [
      h('p', { class: 'sub' }, '助手每次回答前都会读这些内容。它在聊天中学到的事会自动记在这里，你可以随时删除或自己添加。'),
      state.memory.length ? h('ul', { class: 'memory' }, state.memory.map((m) => h('li', {},
        h('span', {}, m.text, h('span', { class: 'sub' }, m.source === 'user' ? ' · 你添加的' : ' · 助手记下的')),
        h('button', { type: 'button', class: 'icon-btn small', 'aria-label': '删除这条记忆', onclick: () => { change((s) => { s.memory = s.memory.filter((x) => x.id !== m.id); }); openMemoryDialog(); } }, icon('trash'))))) : h('p', { class: 'empty' }, '还没有记忆。例如：「我早上效率最高」「周三晚上有课」。'),
      field('添加一条', h('input', { name: 'text', maxLength: 300, placeholder: '写一条希望助手长期记住的事' })),
    ], [
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn ghost', onclick: closeDialog }, '关闭'),
      h('button', { class: 'btn dark', onclick: () => {
        if (!form.text.value.trim()) return;
        change((s) => C.addMemory(s, form.text.value, Date.now(), 'user'));
        openMemoryDialog();
      } }, '添加'),
    ]);
    form.text.focus();
  }

  function openReflectionDialog(current) {
    const form = openDialog(current ? '修改反思' : '写一条反思', [
      field('日期', h('input', { name: 'date', type: 'date', value: current ? current.date : today() })),
      field('内容', h('textarea', { name: 'text', rows: 8, maxLength: 4000, value: current ? current.text : '' })),
    ], [
      current ? h('button', { type: 'button', class: 'btn danger', onclick: () => { if (confirm('删除这条反思？')) { change((s) => { s.reflections = s.reflections.filter((x) => x.id !== current.id); }); closeDialog(); } } }, '删除') : null,
      h('span', { class: 'grow' }), cancelButton(),
      h('button', { class: 'btn dark', onclick: () => {
        const text = form.text.value.trim();
        const date = C.validDate(form.date.value) ? form.date.value : today();
        if (!text) return toast('请写一点内容');
        const ok = change((s) => {
          if (current) Object.assign(s.reflections.find((x) => x.id === current.id), { text, date });
          else s.reflections.push({ id: C.uid('r'), date, text, at: Date.now(), source: 'user' });
        });
        if (ok) closeDialog();
      } }, '保存'),
    ]);
    form.text.focus();
  }

  /* A tiny picture with digits in it, used to check whether a model can read images. */
  function probeImage() {
    const canvas = document.createElement('canvas');
    canvas.width = 240; canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 240, 96);
    ctx.fillStyle = '#111'; ctx.font = 'bold 56px sans-serif'; ctx.textBaseline = 'middle';
    ctx.fillText('4 2 7', 36, 50);
    return { mediaType: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.9).split(',')[1] };
  }

  /* Settings work on a draft. Choosing a provider fills in its address; pasting a key loads its models. */
  function openSettingsDialog(draft) {
    const d = draft && draft.provider ? draft : { ...state.settings.agent, key: '', status: [], busy: '', manual: false };
    const preset = Providers.find(d.provider);
    const prefs = state.settings.prefs;
    const savedKey = platform.loadKey(d.provider);
    const key = () => d.key || savedKey;
    const again = () => openSettingsDialog(d);
    const run = async (label, job) => {
      if (d.busy) return;
      d.busy = label; d.status = []; again();
      try { await job(); } catch (error) { d.status.push(['bad', error.message]); }
      d.busy = ''; again();
    };
    const loadModels = () => run('正在读取模型…', async () => {
      d.models = await platform.listModels(d, key());
      if (!d.models.length) throw new Error('服务商没有返回可用的模型，请手动填写模型名称。');
      if (!d.models.includes(d.modelId)) d.modelId = d.models[0];
      d.manual = false;
      d.status.push(['ok', '读到 ' + d.models.length + ' 个模型，请在下面选择。']);
    });
    const testConnection = () => run('正在测试…', async () => {
      const started = Date.now();
      const reply = await platform.chat(d, '你是连接测试。', '请只回复两个字：正常', [], key());
      d.status.push(['ok', '连接正常，用时 ' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒。模型回答：' + (reply.trim().slice(0, 40) || '（空）')]);
      if (!platform.canSeeImages) return;
      try {
        const seen = await platform.chat(d, '你是识图测试。', '图片里有三个数字，请只回复这三个数字。', [probeImage()], key());
        d.vision = /4\s*2\s*7/.test(seen);
        d.status.push(d.vision ? ['ok', '这个模型可以识图，可以把照片拖进聊天框。'] : ['warn', '这个模型没有读出测试图片里的数字，可能不能识图。']);
      } catch (error) {
        d.vision = false;
        d.status.push(['warn', '这个模型不能识图（' + error.message + '）。文字功能不受影响。']);
      }
    });
    const importInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const next = C.normalize(JSON.parse(await file.text()));
        next.settings.agent = Providers.migrate(next.settings.agent);
        if (!confirm('导入会替换现在的全部数据（' + next.tasks.length + ' 个任务，' + next.habits.length + ' 个习惯）。继续吗？')) return;
        if (commit(next)) { closeDialog(); toast('已导入'); }
      } catch (error) { toast('导入失败：' + error.message); }
    } });
    const useList = d.models.length && !d.manual;
    const modelControl = useList
      ? h('select', { name: 'modelId', onchange: (e) => { d.modelId = e.target.value; d.vision = null; } },
        (d.models.includes(d.modelId) || !d.modelId ? d.models : [d.modelId, ...d.models]).map((id) => h('option', { value: id, selected: id === d.modelId }, id)))
      : h('input', { name: 'modelId', value: d.modelId, placeholder: '填写模型名称，或者先读取模型列表', oninput: (e) => { d.modelId = e.target.value.trim(); d.vision = null; } });
    const form = openDialog('设置', [
      h('h3', {}, 'AI 模型'),
      field('服务商', h('select', { name: 'provider', onchange: (e) => {
        Object.assign(d, { provider: e.target.value, baseUrl: Providers.find(e.target.value).baseUrl, modelId: '', models: [], vision: null, key: '', status: [], manual: false });
        again();
      } }, Providers.PROVIDERS.map((p) => h('option', { value: p.id, selected: p.id === d.provider }, p.name)))),
      preset.note ? h('p', { class: 'sub' }, preset.note) : null,
      field('API 密钥', h('input', {
        name: 'key', type: 'password', autocomplete: 'off', value: d.key, placeholder: savedKey ? '已保存，留空表示不修改' : '粘贴密钥后会自动读取模型',
        oninput: (e) => { d.key = e.target.value.trim(); },
        onpaste: () => setTimeout(() => { if (d.key && d.baseUrl) loadModels(); }, 0),
      })),
      h('div', { class: 'field' }, h('span', {}, '模型'),
        h('div', { class: 'row tight' }, modelControl,
          h('button', { type: 'button', class: 'btn outline slim', disabled: !!d.busy, onclick: loadModels }, '读取模型'),
          d.models.length ? h('button', { type: 'button', class: 'btn ghost', onclick: () => { d.manual = !d.manual; again(); } }, d.manual ? '从列表选' : '手动填写') : null)),
      h('details', { class: 'advanced', open: d.provider === 'custom' }, h('summary', {}, '接口地址'),
        h('input', { name: 'baseUrl', value: d.baseUrl, placeholder: 'https://…/v1', 'aria-label': '接口地址', oninput: (e) => { d.baseUrl = e.target.value.trim(); } })),
      h('div', { class: 'row tight' },
        h('button', { type: 'button', class: 'btn outline slim', disabled: !!d.busy, onclick: testConnection }, '测试连接'),
        d.busy ? h('span', { class: 'sub', role: 'status' }, d.busy) : d.vision === true ? h('span', { class: 'sub' }, '可以识图') : d.vision === false ? h('span', { class: 'sub' }, '不能识图') : null),
      d.status.length ? h('ul', { class: 'status', role: 'status' }, d.status.map(([kind, text]) => h('li', { class: kind }, text))) : null,
      h('p', { class: 'sub' }, (platform.name === 'desktop' ? '密钥由 Windows 当前账户加密保存。' : '密钥只保存在这个浏览器里，每个服务商分开保存。') + '发送消息时，你的任务、习惯、计时统计、长期记忆、最近的对话，以及附上的文件和图片，会发给这个模型服务。'),
      h('h3', {}, '我的节奏'),
      h('div', { class: 'row' },
        field('一段专注（分钟）', h('input', { name: 'segment', type: 'number', min: 5, max: 90, value: prefs.segment })),
        field('每天可安排（分钟）', h('input', { name: 'daily', type: 'number', min: 0, max: 960, value: prefs.dailyMinutes || '' }))),
      h('h3', {}, '数据'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn outline slim', onclick: () => {
          const link = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })), download: 'tplan-' + today() + '.json' });
          link.click();
          URL.revokeObjectURL(link.href);
        } }, '导出 JSON'),
        h('button', { type: 'button', class: 'btn outline slim', onclick: () => importInput.click() }, '导入 JSON'), importInput,
        h('button', { type: 'button', class: 'btn ghost', onclick: () => { if (confirm('清空全部对话？任务、记录和记忆会保留。')) { change((s) => { s.messages = []; }); toast('对话已清空'); } } }, '清空对话')),
    ], [
      h('span', { class: 'grow' }), cancelButton(),
      h('button', { class: 'btn dark', onclick: () => {
        const segment = Math.round(Number(form.segment.value));
        const daily = Math.round(Number(form.daily.value));
        if (!(segment >= 5 && segment <= 90)) return toast('一段专注请填 5–90 分钟');
        if (d.modelId) { try { Providers.chatRequest(d, 'x', '', ''); } catch (error) { return toast(error.message); } }
        try { if (d.key) platform.saveKey(d.provider, d.key); } catch (error) { return toast('密钥没有保存：' + error.message); }
        const ok = change((s) => {
          s.settings.agent = { provider: d.provider, baseUrl: d.baseUrl, modelId: d.modelId, models: d.models, vision: d.vision };
          s.settings.prefs.segment = segment;
          s.settings.prefs.dailyMinutes = daily > 0 ? daily : null;
        });
        if (ok) { closeDialog(); toast('设置已保存'); }
      } }, '保存'),
    ]);
  }

  /* ---------- shell ---------- */
  function render() {
    document.querySelectorAll('.top-nav .pill').forEach((b) => b.classList.toggle('on', b.dataset.view === ui.view));
    renderRail();
    renderList();
    if (ui.view === 'chat') renderChat(); else renderReview();
    renderDock();
  }
  document.querySelectorAll('.top-nav .pill').forEach((b) => b.addEventListener('click', () => { ui.view = b.dataset.view; render(); }));
  $('#openSettings').append(icon('gear'));
  $('#openSettings').addEventListener('click', () => openSettingsDialog());
  $('#dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDialog(); });

  /* The task column can be dragged wider or narrower. Dragging it very narrow closes it; double-click restores the default. */
  const LIST = { min: 220, max: 640, standard: 320, closeBelow: 150 };
  const shell = $('#shell');
  const splitter = $('#splitter');
  function showListWidth(width) {
    shell.style.setProperty('--list-w', width + 'px');
    shell.classList.toggle('list-closed', width === 0);
    splitter.setAttribute('aria-valuenow', String(width));
  }
  function fitListWidth(raw) {
    if (raw < LIST.closeBelow) return 0;
    return Math.round(Math.min(LIST.max, Math.max(LIST.min, raw), shell.clientWidth - 96 - 420));
  }
  const saveListWidth = (width) => { if (width !== state.settings.prefs.listWidth) change((s) => { s.settings.prefs.listWidth = width; }); };
  splitter.setAttribute('aria-valuemin', '0');
  splitter.setAttribute('aria-valuemax', String(LIST.max));
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    const left = $('.list-col').getBoundingClientRect().left;
    let width = state.settings.prefs.listWidth;
    const move = (ev) => { width = fitListWidth(ev.clientX - left); showListWidth(width); };
    const stop = () => {
      splitter.removeEventListener('pointermove', move);
      splitter.classList.remove('dragging');
      document.body.classList.remove('resizing');
      saveListWidth(width);
    };
    splitter.classList.add('dragging');
    document.body.classList.add('resizing');
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', stop, { once: true });
    splitter.addEventListener('pointercancel', stop, { once: true });
  });
  splitter.addEventListener('dblclick', () => { showListWidth(LIST.standard); saveListWidth(LIST.standard); });
  splitter.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 60 : 20;
    const current = state.settings.prefs.listWidth;
    let next = null;
    if (e.key === 'ArrowLeft') next = current <= LIST.min ? 0 : fitListWidth(current - step);
    else if (e.key === 'ArrowRight') next = current === 0 ? LIST.min : fitListWidth(current + step);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = fitListWidth(LIST.max);
    else if (e.key === 'Enter') next = current === 0 ? LIST.standard : 0;
    if (next === null) return;
    e.preventDefault();
    showListWidth(next);
    saveListWidth(next);
    splitter.focus();
  });
  showListWidth(Number.isFinite(state.settings.prefs.listWidth) ? state.settings.prefs.listWidth : LIST.standard);

  /* Files can be dropped anywhere in the window. */
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    addFiles(e.dataTransfer.files);
  });

  if (!state.messages.length && !state.settings.prefs.onboarded) change((s) => askOnboarding(s, 0));
  else render();
})();
