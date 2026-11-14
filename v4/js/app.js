/* T计划 v4 UI. State lives in one object; every change goes through commit(), which saves first
   and only then re-renders, so a failed save never leaves the screen ahead of the stored data. */
(function () {
  'use strict';

  const C = window.TPlanCore;
  const platform = window.TPlanPlatform;
  const $ = (selector) => document.querySelector(selector);

  let state = loadState();
  const ui = { view: 'chat', space: null, tab: 'today', busy: false, draft: '' };

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
    for (const child of children.flat()) if (child != null && child !== false) el.append(child);
    return el;
  }
  const ICONS = {
    gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-3.5c0-.5 0-.9-.1-1.3l2-1.5-2-3.4-2.3.9c-.7-.6-1.5-1-2.3-1.3L14.3 3h-4l-.4 2.4c-.8.3-1.6.7-2.300 1.300l-2.300-.9-2 3.400 2 1.500a8 8 0 0 0 0 2.600l-2 1.500 2 3.400 2.300-.9c.7.6 1.500 1 2.300 1.300l.4 2.400h4l.4-2.400c.8-.3 1.600-.7 2.300-1.300l2.300.9 2-3.400-2-1.500c.1-.4.1-.8.1-1.300Z',
    plus: 'M12 5v14M5 12h14',
    send: 'M12 19V5M5 12l7-7 7 7',
    check: 'M5 12.5l4.5 4.5L19 7.500',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    brain: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5v4l3 2',
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
  function dateLabel(date) {
    if (!date) return '未定日期';
    const t = today();
    if (date === t) return '今天';
    if (date === C.addDays(t, 1)) return '明天';
    if (date === C.addDays(t, -1)) return '昨天';
    const d = new Date(date + 'T12:00:00');
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + '日一二三四五六'[d.getDay()];
  }
  const plainDate = (date) => Number(date.slice(5, 7)) + '月' + Number(date.slice(8)) + '日';
  const minutesLabel = (m) => (m >= 60 ? (m % 60 ? Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分' : m / 60 + ' 小时') : m + ' 分钟');
  const timeLabel = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const modelName = () => {
    const a = state.settings.agent;
    return a.modelId && (a.provider === 'anthropic' || a.baseUrl) ? a.modelId : null;
  };

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

  /* ---------- list: tasks and habits ---------- */
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
    return h('div', { class: 'task' + (t.done ? ' done' : '') },
      h('button', {
        class: 'check', 'aria-label': t.done ? '标记为未完成' : '标记为完成', 'aria-pressed': String(t.done),
        onclick: () => change((s) => { const x = s.tasks.find((y) => y.id === t.id); x.done = !x.done; x.doneAt = x.done ? Date.now() : null; }),
      }, t.done ? icon('check') : null),
      h('button', { class: 'task-body', onclick: () => openTaskDialog(t) },
        h('span', { class: 'task-title' }, t.title),
        h('span', { class: 'task-meta' },
          sp ? h('span', { class: 'dot', style: 'background:' + sp.color }) : null,
          h('span', { class: overdue ? 'overdue' : '' }, overdue ? '已过期 · ' + dateLabel(t.date) : dateLabel(t.date)),
          h('span', {}, '· ' + minutesLabel(t.minutes)))));
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
  function renderList() {
    const tabs = [['today', '今天'], ['week', '本周'], ['later', '之后']];
    const tasks = visibleTasks();
    const habits = state.habits.filter((x) => !ui.space || x.spaceId === ui.space);
    const open = tasks.filter((x) => !x.done);
    const current = space(ui.space);
    const empty = { today: '今天还没有安排。可以告诉助手你想做什么。', week: '本周后面几天还没有安排。', later: '没有以后的任务或未定日期的任务。' }[ui.tab];
    $('#list').replaceChildren(
      h('header', { class: 'list-head' },
        h('div', {},
          h('h2', {}, current ? current.name : '全部安排'),
          h('p', { class: 'sub' }, open.length + ' 项未完成 · ' + minutesLabel(open.reduce((n, x) => n + x.minutes, 0) || 0))),
        current ? h('button', { class: 'icon-btn', 'aria-label': '编辑分区', title: '编辑分区', onclick: () => openSpaceDialog(current) }, icon('gear')) : null),
      h('div', { class: 'segmented', role: 'tablist' }, tabs.map(([key, label]) =>
        h('button', { role: 'tab', 'aria-selected': String(ui.tab === key), class: ui.tab === key ? 'on' : '', onclick: () => { ui.tab = key; render(); } }, label))),
      h('div', { class: 'list-scroll' },
        tasks.length ? tasks.map(taskRow) : h('p', { class: 'empty' }, empty),
        ui.tab === 'today' && habits.length ? [h('h3', { class: 'group-title' }, '习惯'), ...habits.map(habitRow)] : null),
      h('div', { class: 'list-foot' },
        h('button', { class: 'btn outline', onclick: () => openTaskDialog(null) }, icon('plus'), '新建任务'),
        h('button', { class: 'btn ghost', onclick: () => openHabitDialog(null) }, icon('plus'), '新习惯')));
  }

  /* ---------- chat ---------- */
  function actionLine(a) {
    const name = (id) => (state.tasks.find((t) => t.id === id) || {}).title || '（任务已不存在）';
    const sp = a.spaceId ? ' · ' + (space(a.spaceId) || {}).name : '';
    if (a.type === 'add_task') return ['新任务', a.title, dateLabel(a.date) + ' · ' + minutesLabel(a.minutes) + sp];
    if (a.type === 'update_task') {
      const parts = [];
      if (a.title !== undefined) parts.push('改名为「' + a.title + '」');
      if (a.date !== undefined) parts.push('改到 ' + dateLabel(a.date));
      if (a.minutes !== undefined) parts.push('时长 ' + minutesLabel(a.minutes));
      return ['修改', name(a.taskId), parts.join(' · ')];
    }
    if (a.type === 'complete_task') return ['完成', name(a.taskId), ''];
    if (a.type === 'delete_task') return ['删除', name(a.taskId), ''];
    if (a.type === 'add_habit') return ['新习惯', a.title, '每周 ' + a.perWeek + ' 次' + sp];
    return ['记住', a.text, '保存到长期记忆'];
  }
  function proposalCard(message) {
    const p = message.proposal;
    const status = { pending: '等待你确认 · 还没有写入', accepted: '已确认并写入', dismissed: '已放弃' }[p.status];
    const resolve = (accept) => {
      try { commit(C.resolveProposal(state, message.id, accept)); if (accept) toast('已写入 ' + p.actions.length + ' 项'); }
      catch (error) { toast(error.message); }
    };
    return h('div', { class: 'proposal ' + p.status },
      h('div', { class: 'proposal-head' }, h('strong', {}, '提议 · ' + p.actions.length + ' 项修改'), h('span', { class: 'sub' }, status)),
      h('ul', {}, p.actions.map((a) => {
        const [kind, title, meta] = actionLine(a);
        return h('li', {}, h('span', { class: 'tag t-' + a.type }, kind), h('span', { class: 'p-title' }, title), meta ? h('span', { class: 'sub' }, meta) : null);
      })),
      p.status === 'pending' ? h('div', { class: 'proposal-actions' },
        h('button', { class: 'btn dark', onclick: () => resolve(true) }, '确认写入'),
        h('button', { class: 'btn ghost', onclick: () => resolve(false) }, '放弃')) : null);
  }
  function messageRow(m) {
    const mine = m.role === 'user';
    return h('div', { class: 'msg ' + (mine ? 'mine' : 'theirs') },
      h('div', { class: 'msg-meta' }, h('strong', {}, mine ? '你' : '规划助手'), h('span', {}, timeLabel(m.at)), m.source === 'local' ? h('span', { class: 'chip' }, '本地模式') : null),
      h('div', { class: 'bubble' + (m.error ? ' error' : '') }, m.text),
      m.proposal ? proposalCard(m) : null);
  }
  function renderChat() {
    const model = modelName();
    const starters = ['帮我安排今天', '这周我完成了什么？', '我想每周运动三次', '下周五要交报告，帮我拆成几步'];
    const scroller = h('div', { class: 'chat-scroll', id: 'chatScroll' },
      state.messages.length ? state.messages.map(messageRow) : h('div', { class: 'welcome' },
        h('h3', {}, '今天想推进什么？'),
        h('p', { class: 'sub' }, '告诉我你的任务、目标或者困难。我会先看你的安排和记录，再提出修改，你确认之后才会写入。'),
        h('div', { class: 'starters' }, starters.map((text) => h('button', { class: 'pill soft', onclick: () => { ui.draft = text; render(); $('#composer').focus(); } }, text)))),
      ui.busy ? h('div', { class: 'msg theirs' }, h('div', { class: 'bubble typing', 'aria-label': '助手正在思考' }, h('i'), h('i'), h('i'))) : null);
    const input = h('textarea', {
      id: 'composer', rows: 2, maxLength: 4000, value: ui.draft,
      placeholder: model ? '告诉助手你想做什么，Enter 发送，Shift+Enter 换行' : '本地模式：每行写一件事，例如「明天 复习第三章 45分钟」',
      oninput: (e) => { ui.draft = e.target.value; $('#send').disabled = !ui.draft.trim() || ui.busy; },
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } },
    });
    $('#main').replaceChildren(
      h('header', { class: 'main-head' },
        h('div', {}, h('h2', {}, '规划助手'), h('p', { class: 'sub' }, model ? '模型：' + model : '本地模式 · 还没有连接 AI 模型')),
        h('div', { class: 'head-actions' },
          h('button', { class: 'pill soft', onclick: openMemoryDialog }, icon('brain'), '记忆 ' + state.memory.length + ' 条'),
          !model ? h('button', { class: 'pill soft', onclick: openSettingsDialog }, icon('plus'), '连接模型') : null)),
      scroller,
      h('div', { class: 'composer' }, input,
        h('div', { class: 'composer-bar' },
          h('span', { class: 'sub' }, ui.space ? '当前分区：' + space(ui.space).name : '助手只会提议，你确认后才写入'),
          h('button', { class: 'send', id: 'send', 'aria-label': '发送', disabled: !ui.draft.trim() || ui.busy, onclick: send }, icon('send')))));
    scroller.scrollTop = scroller.scrollHeight;
  }

  async function send() {
    const text = ui.draft.trim();
    if (!text || ui.busy) return;
    const context = C.buildContext(state, today(), text);
    if (ui.space) context.currentSpace = space(ui.space).name;
    ui.draft = '';
    if (!change((s) => s.messages.push({ id: C.uid('msg'), role: 'user', text, at: Date.now() }))) { ui.draft = text; return; }
    const useModel = !!modelName();
    let answer;
    let error = null;
    ui.busy = true;
    render();
    try {
      answer = useModel
        ? C.parseReply(await platform.chat(state.settings.agent, C.SYSTEM_PROMPT, JSON.stringify(context)))
        : C.localReply(text, today());
    } catch (e) {
      error = e.message;
    }
    ui.busy = false;
    change((s) => {
      const message = { id: C.uid('msg'), role: 'assistant', at: Date.now(), source: useModel ? 'ai' : 'local', text: error || answer.reply };
      if (error) message.error = true;
      else {
        const checked = C.validateActions(s, answer.actions.map((a) => (a.type && a.space == null && ui.space ? { ...a, space: ui.space } : a)));
        if (checked.actions.length) message.proposal = { status: 'pending', source: message.source, actions: checked.actions };
        if (checked.rejected.length) message.text += '\n（有 ' + checked.rejected.length + ' 项提议格式不对，已忽略。）';
      }
      s.messages.push(message);
      if (s.messages.length > 400) s.messages = s.messages.slice(-400);
    });
  }

  /* ---------- review ---------- */
  function renderReview() {
    const t = today();
    const start = C.weekStart(t);
    const days = Array.from({ length: 7 }, (_, i) => C.addDays(start, i));
    const doneOn = (d) => state.tasks.filter((x) => x.done && x.doneAt && C.todayISO(new Date(x.doneAt)) === d);
    const perDay = days.map((d) => doneOn(d).reduce((n, x) => n + x.minutes, 0));
    const max = Math.max(60, ...perDay);
    const doneWeek = days.flatMap(doneOn);
    const planned = state.tasks.filter((x) => x.date && x.date >= start && x.date <= days[6]);
    const stat = (value, label) => h('div', { class: 'stat' }, h('strong', {}, value), h('span', { class: 'sub' }, label));
    $('#main').replaceChildren(
      h('header', { class: 'main-head' }, h('div', {}, h('h2', {}, '本周回看'), h('p', { class: 'sub' }, plainDate(days[0]) + ' 至 ' + plainDate(days[6]) + ' · 只显示已记录的事实'))),
      h('div', { class: 'review-scroll' },
        h('div', { class: 'stats' },
          stat(String(doneWeek.length), '本周完成的任务'),
          stat(minutesLabel(doneWeek.reduce((n, x) => n + x.minutes, 0) || 0), '完成任务的计划时长'),
          stat(planned.filter((x) => x.done).length + ' / ' + planned.length, '本周安排的完成情况')),
        h('section', { class: 'card' }, h('h3', {}, '每天完成的计划时长'),
          h('div', { class: 'bars' }, days.map((d, i) => h('div', { class: 'bar' + (d === t ? ' today' : '') },
            h('span', { class: 'bar-value' }, perDay[i] ? String(perDay[i]) : ''),
            h('span', { class: 'bar-fill', style: 'height:' + (perDay[i] / max) * 100 + '%' }),
            h('span', { class: 'sub' }, '一二三四五六日'[i])))),
          h('p', { class: 'sub' }, '单位：分钟。这是任务的计划时长，不是实际用时，也不代表学习效果。')),
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
        field('预计分钟', h('input', { name: 'minutes', type: 'number', min: 1, max: 1440, value: task ? task.minutes : 30 }))),
      field('分区', spaceSelect(task ? task.spaceId : ui.space)),
    ], [
      task ? h('button', { type: 'button', class: 'btn danger', onclick: () => { if (confirm('删除这个任务？')) { change((s) => { s.tasks = s.tasks.filter((x) => x.id !== task.id); }); closeDialog(); } } }, '删除') : null,
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
      h('p', { class: 'sub' }, '助手每次回答前都会读这些内容。你可以自己添加，也可以删除助手记下的内容。'),
      state.memory.length ? h('ul', { class: 'memory' }, state.memory.map((m) => h('li', {},
        h('span', {}, m.text),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': '删除这条记忆', onclick: () => { change((s) => { s.memory = s.memory.filter((x) => x.id !== m.id); }); openMemoryDialog(); } }, icon('trash'))))) : h('p', { class: 'empty' }, '还没有记忆。例如：「我早上效率最高」「周三晚上有课」。'),
      field('添加一条', h('input', { name: 'text', maxLength: 300, placeholder: '写一条希望助手长期记住的事' })),
    ], [
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn ghost', onclick: closeDialog }, '关闭'),
      h('button', { class: 'btn dark', onclick: () => {
        const text = form.text.value.trim();
        if (!text) return;
        change((s) => s.memory.push({ id: C.uid('m'), text, at: Date.now(), source: 'user' }));
        openMemoryDialog();
      } }, '添加'),
    ]);
    form.text.focus();
  }

  function openSettingsDialog() {
    const a = state.settings.agent;
    const baseField = field('接口地址（OpenAI 兼容）', h('input', { name: 'baseUrl', value: a.baseUrl, placeholder: '例如 https://api.deepseek.com' }));
    const provider = h('select', { name: 'provider', onchange: () => { baseField.hidden = provider.value === 'anthropic'; } },
      h('option', { value: 'openai', selected: a.provider !== 'anthropic' }, 'OpenAI 兼容接口（DeepSeek、OpenAI、本机模型等）'),
      h('option', { value: 'anthropic', selected: a.provider === 'anthropic' }, 'Anthropic（Claude）'));
    baseField.hidden = a.provider === 'anthropic';
    const importInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const next = C.normalize(JSON.parse(await file.text()));
        if (!confirm('导入会替换现在的全部数据（' + next.tasks.length + ' 个任务，' + next.habits.length + ' 个习惯）。继续吗？')) return;
        if (commit(next)) { closeDialog(); toast('已导入'); }
      } catch (error) { toast('导入失败：' + error.message); }
    } });
    const form = openDialog('设置', [
      h('h3', {}, 'AI 模型'),
      field('服务商', provider), baseField,
      field('模型名称', h('input', { name: 'modelId', value: a.modelId, placeholder: '填写服务商提供的模型名称' })),
      field('API 密钥', h('input', { name: 'key', type: 'password', autocomplete: 'off', placeholder: platform.loadSecret() ? '已保存，留空表示不修改' : '只保存在这台电脑上' })),
      h('p', { class: 'sub' }, platform.name === 'desktop' ? '密钥由 Windows 当前账户加密保存。' : '浏览器预览模式：密钥保存在这个浏览器里。正式使用请用 Windows 桌面版。'),
      h('p', { class: 'sub' }, '发送消息时，你的任务、习惯、长期记忆和最近的对话会发给这个模型服务。'),
      h('h3', {}, '数据'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn outline', onclick: () => {
          const link = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })), download: 'tplan-' + today() + '.json' });
          link.click();
          URL.revokeObjectURL(link.href);
        } }, '导出 JSON'),
        h('button', { type: 'button', class: 'btn outline', onclick: () => importInput.click() }, '导入 JSON'), importInput,
        h('button', { type: 'button', class: 'btn ghost', onclick: () => { if (confirm('清空全部对话？任务和记忆会保留。')) { change((s) => { s.messages = []; }); toast('对话已清空'); } } }, '清空对话')),
    ], [
      h('span', { class: 'grow' }), cancelButton(),
      h('button', { class: 'btn dark', onclick: () => {
        const baseUrl = form.baseUrl.value.trim();
        if (provider.value === 'openai' && baseUrl && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(baseUrl)) return toast('接口地址需要 https，本机模型可以用 http://localhost');
        try { if (form.key.value) platform.saveSecret(form.key.value); } catch (error) { return toast('密钥没有保存：' + error.message); }
        if (change((s) => { s.settings.agent = { provider: provider.value, baseUrl, modelId: form.modelId.value.trim() }; })) { closeDialog(); toast('设置已保存'); }
      } }, '保存'),
    ]);
  }

  /* ---------- shell ---------- */
  function render() {
    document.querySelectorAll('.top-nav .pill').forEach((b) => b.classList.toggle('on', b.dataset.view === ui.view));
    renderRail();
    renderList();
    if (ui.view === 'chat') renderChat(); else renderReview();
  }
  document.querySelectorAll('.top-nav .pill').forEach((b) => b.addEventListener('click', () => { ui.view = b.dataset.view; render(); }));
  $('#openSettings').append(icon('gear'));
  $('#openSettings').addEventListener('click', openSettingsDialog);
  $('#dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDialog(); });
  render();
})();
