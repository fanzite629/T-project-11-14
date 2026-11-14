const test = require('node:test');
const assert = require('node:assert');
const C = require('./js/core.js');
const Agent = require('./js/agent.js');

const TODAY = '2026-11-14'; // a Saturday
const MIN = 60000;

function stateWithTask() {
  const s = C.emptyState();
  s.tasks.push({ id: 't1', title: 'Read chapter 3', date: TODAY, minutes: 40, spaceId: 'space_1', done: false, doneAt: null, createdAt: 1 });
  return s;
}
function withProposal(s, actions) {
  s.messages.push({ id: 'm1', role: 'assistant', text: 'ok', at: 1, proposal: { status: 'pending', source: 'ai', actions: C.validateActions(s, actions).actions } });
  return s;
}

test('dates: week starts on Monday and addDays crosses months', () => {
  assert.equal(C.weekStart(TODAY), '2026-11-09');
  assert.equal(C.addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(C.validDate('2026-02-30'), false);
});

test('normalize repairs missing fields and rejects newer data', () => {
  const s = C.normalize({ tasks: [{ id: 'a', title: 'x', date: 'bad', spaceId: 'gone', goalId: 'gone' }], timer: { taskId: 'nope' } });
  assert.equal(s.tasks[0].date, null);
  assert.equal(s.tasks[0].spaceId, null);
  assert.equal(s.tasks[0].goalId, null);
  assert.equal(s.timer, null);
  assert.equal(s.settings.prefs.segment, 25);
  assert.throws(() => C.normalize({ version: 99 }));
});

test('validateActions keeps good actions and reports bad ones', () => {
  const s = stateWithTask();
  const { actions, rejected } = C.validateActions(s, [
    { type: 'add_task', title: '  Write  outline ', date: 'tomorrow', minutes: 'x', space: '学习' },
    { type: 'update_task', taskId: 'missing', date: '2026-11-15' },
    { type: 'format_disk' },
    { type: 'add_habit', title: 'Run', perWeek: 30 },
  ]);
  assert.deepEqual(actions[0], { type: 'add_task', title: 'Write outline', date: null, minutes: 30, spaceId: 'space_1' });
  assert.equal(actions[1].perWeek, 7);
  assert.equal(rejected.length, 2);
});

test('a task with steps takes its length from the steps', () => {
  const { actions } = C.validateActions(C.emptyState(), [{ type: 'add_task', title: 'MCU', minutes: 5, steps: [{ title: 'Read p1-10', minutes: 30 }, { title: 'Timer lab', minutes: 45 }, 'Review'] }]);
  assert.equal(actions[0].minutes, 100);
  assert.deepEqual(actions[0].steps[2], { title: 'Review', minutes: 25 });
});

test('nothing changes until a proposal is accepted, and accepting twice is a no-op', () => {
  const s = withProposal(stateWithTask(), [
    { type: 'add_task', title: 'New', minutes: 20 },
    { type: 'complete_task', taskId: 't1' },
  ]);
  const before = JSON.stringify(s);
  const next = C.resolveProposal(s, 'm1', true, 1000);
  assert.equal(JSON.stringify(s), before, 'input state must not be mutated');
  assert.equal(next.tasks.length, 2);
  assert.equal(next.tasks[0].done, true);
  assert.equal(next.messages[0].proposal.created.length, 1);
  assert.equal(C.resolveProposal(next, 'm1', true, 2000).tasks.length, 2);
});

test('dismissing writes nothing; a stale proposal fails as a whole', () => {
  const s = withProposal(stateWithTask(), [{ type: 'add_task', title: 'New' }, { type: 'delete_task', taskId: 't1' }]);
  assert.equal(C.resolveProposal(s, 'm1', false).tasks.length, 1);
  s.tasks = [];
  assert.throws(() => C.resolveProposal(s, 'm1', true));
});

test('a goal becomes milestones with linked tasks', () => {
  const s = withProposal(C.emptyState(), [{
    type: 'add_goal', title: 'Finish MCU course', deadline: '2026-12-31', space: '学习',
    milestones: [
      { title: 'Week 1: GPIO', due: '2026-11-22', tasks: [{ title: 'Read ch1', date: '2026-11-16', minutes: 60, steps: [{ title: 'p1-20', minutes: 30 }, { title: 'p21-40', minutes: 30 }] }, { title: 'LED lab', date: '2026-11-17', minutes: 45 }] },
      { title: 'Week 2: Timers', tasks: [{ title: 'Read ch2' }] },
    ],
  }]);
  const next = C.resolveProposal(s, 'm1', true);
  assert.equal(next.goals.length, 1);
  assert.deepEqual(next.goals[0].milestones.map((m) => m.title), ['Week 1: GPIO', 'Week 2: Timers']);
  assert.equal(next.tasks.length, 3);
  assert.ok(next.tasks.every((t) => t.goalId === next.goals[0].id && t.spaceId === 'space_1'));
  assert.equal(next.tasks[2].milestone, 1);
  assert.equal(next.tasks[0].steps.length, 2);
});

test('timer walks the steps, records real minutes, and completes the task', () => {
  let s = C.emptyState();
  s.tasks.push({ id: 't', title: 'MCU', date: TODAY, minutes: 50, spaceId: 'space_1', done: false, steps: [{ title: 'A', minutes: 20, done: false }, { title: 'B', minutes: 30, done: false }] });
  const t0 = new Date(TODAY + 'T09:00:00').getTime();
  s = C.startTimer(s, 't', t0);
  assert.throws(() => C.startTimer(s, 't', t0));
  assert.equal(C.timerView(s, t0 + 5 * MIN).remainingMs, 15 * MIN);
  s = C.pauseTimer(s, t0 + 5 * MIN);
  s = C.resumeTimer(s, t0 + 15 * MIN); // a ten-minute pause is not counted
  assert.equal(C.timerView(s, t0 + 20 * MIN).elapsedMs, 10 * MIN);
  assert.equal(C.timerView(s, t0 + 40 * MIN).due, true);
  s = C.extendTimer(s, 5);
  assert.equal(s.tasks[0].minutes, 55);
  let r = C.finishStep(s, t0 + 38 * MIN); // 28 working minutes
  assert.equal(r.session.actual, 28);
  assert.equal(r.session.planned, 25);
  assert.equal(r.session.hour, 9);
  assert.equal(r.finishedTask, null);
  assert.equal(r.state.timer.step, 1);
  r = C.finishStep(r.state, t0 + 68 * MIN);
  assert.equal(r.finishedTask, 't');
  assert.equal(r.state.timer, null);
  assert.equal(r.state.tasks[0].done, true);
  assert.equal(r.state.sessions.length, 2);
  const skipped = C.finishStep(C.startTimer(stateWithTask(), 't1', 0), 20000);
  assert.equal(skipped.session, null, 'a step skipped within a minute leaves no record');
  assert.equal(skipped.state.tasks[0].done, true);
});

test('stopping early records a partial session only after a minute', () => {
  let s = stateWithTask();
  s = C.startTimer(s, 't1', 0);
  assert.equal(s.tasks[0].steps.length, 1, 'a task without steps is timed as one step');
  assert.equal(C.stopTimer(s, 30000).sessions.length, 0);
  const stopped = C.stopTimer(s, 12 * MIN);
  assert.equal(stopped.sessions[0].partial, true);
  assert.equal(stopped.sessions[0].actual, 12);
  assert.equal(stopped.tasks[0].done, false);
});

test('profile reports a figure only when there is enough evidence', () => {
  const s = C.emptyState();
  const session = (planned, actual, hour, date) => ({ id: C.uid('s'), taskId: 't', title: 'x', step: 'y', spaceId: 'space_1', planned, actual, date, hour, partial: false });
  s.sessions.push(session(25, 30, 9, '2026-11-10'), session(25, 35, 10, '2026-11-11'));
  let p = C.buildProfile(s, TODAY);
  assert.equal(p.actualVsPlanned, undefined);
  assert.equal(p.sessionsRecorded, 2);
  s.sessions.push(session(30, 39, 9, '2026-11-12'), session(20, 20, 20, '2026-11-12'), session(20, 20, 21, '2026-11-13'));
  s.tasks.push({ id: 'f', title: 'x', date: null, minutes: 1, done: true, feel: 'hard' });
  p = C.buildProfile(s, TODAY);
  assert.equal(p.actualVsPlanned, 1.2);
  assert.equal(p.actualVsPlannedBySpace['学习'], 1.2);
  assert.equal(p.typicalFocusMinutes, 30);
  assert.deepEqual(p.focusMinutesByTimeOfDay, { 早上: 104, 晚上: 40 });
  assert.equal(p.focusMinutesPerActiveDay, 36);
  assert.deepEqual(p.difficultyFeedback, { easy: 0, ok: 0, hard: 1 });
});

test('memory notes are de-duplicated', () => {
  const s = C.emptyState();
  assert.equal(C.addMemory(s, ' Morning  person ', 1, 'ai'), true);
  assert.equal(C.addMemory(s, 'Morning person', 2, 'ai'), false);
  assert.equal(s.memory.length, 1);
});

test('local mode parses dates and splits a long sitting into segments', () => {
  assert.deepEqual(C.parseLine('明天 复习第三章 45分钟', TODAY), { type: 'add_task', title: '复习第三章', date: '2026-11-15', minutes: 45, space: null });
  assert.equal(C.parseLine('周三 写报告 1.5小时', TODAY).date, '2026-11-18');
  assert.equal(C.parseLine('下周一 开会', TODAY).date, '2026-11-16');
  const plan = C.localReply('学习单片机 2小时', TODAY, { segment: 30 });
  assert.equal(plan.actions[0].steps.length, 4);
  assert.equal(plan.actions[0].date, TODAY);
  assert.equal(plan.startTimer, true);
  assert.deepEqual(C.localReply('买菜\n记住：我早上效率高', TODAY).actions.map((a) => a.type), ['add_task', 'remember']);
});

test('context carries facts, preferences and profile', () => {
  const s = stateWithTask();
  s.habits.push({ id: 'h1', title: 'Run', perWeek: 3, spaceId: null, log: { '2026-11-10': true, [TODAY]: true, '2026-11-01': true } });
  s.memory.push({ id: 'm', text: 'Morning person', at: 1, source: 'user' });
  const ctx = C.buildContext(s, TODAY, 'plan my day');
  assert.equal(ctx.openTasks[0].taskId, 't1');
  assert.deepEqual(ctx.habits[0], { title: 'Run', targetPerWeek: 3, doneThisWeek: 2, doneToday: true });
  assert.deepEqual(ctx.memory, ['Morning person']);
  assert.equal(ctx.preferences.segment, 25);
  assert.equal(ctx.profile.sessionsRecorded, 0);
});

test('parseReply reads final answers, tool calls, fenced JSON and plain text', () => {
  const final = Agent.parseReply('{"reply":"hi","actions":[{"type":"remember","text":"a"}],"options":["好","  "],"startTimer":true}');
  assert.equal(final.actions.length, 1);
  assert.deepEqual(final.options, ['好']);
  assert.equal(final.startTimer, true);
  assert.deepEqual(Agent.parseReply('{"tool":{"name":"get_history","args":{"days":7}}}').tool, { name: 'get_history', args: { days: 7 } });
  assert.equal(Agent.parseReply('```json\n{"reply":"hi"}\n```').reply, 'hi');
  assert.equal(Agent.parseReply('Sure, here is my advice.').reply, 'Sure, here is my advice.');
});

test('agent loop runs tools, feeds results back, and stops at the limit', async () => {
  const library = new Map([['slides.pdf', { name: 'slides.pdf', kind: 'PDF', text: 'A'.repeat(7000) + 'TIMER CHAPTER' }]]);
  const seen = [];
  const replies = [
    '{"tool":{"name":"read_attachment","args":{"name":"slides.pdf","offset":6000}}}',
    '{"tool":{"name":"nope","args":{}}}',
    '{"reply":"done","actions":[],"options":[]}',
  ];
  const steps = [];
  const result = await Agent.run({
    context: { message: 'plan' }, attachments: [library.get('slides.pdf')], library,
    chat: async (system, user) => { seen.push(JSON.parse(user)); return replies.shift(); },
    onStep: (name) => steps.push(name),
  });
  assert.equal(result.reply, 'done');
  assert.equal(result.toolCalls, 2);
  assert.deepEqual(steps, ['read_attachment', 'nope']);
  assert.equal(seen[0].attachments[0].excerpt.length, 6000);
  assert.ok(seen[1].toolResults[0].result.text.endsWith('TIMER CHAPTER'));
  assert.ok(seen[2].toolResults[1].result.error);

  let calls = 0;
  const looping = await Agent.run({ context: {}, chat: async () => { calls++; return '{"tool":{"name":"get_history","args":{}}}'; }, tools: { get_history: () => ({}) } });
  assert.equal(calls, Agent.MAX_TOOL_STEPS + 1);
  assert.equal(looping.actions.length, 0);
});
