const test = require('node:test');
const assert = require('node:assert');
const C = require('./js/core.js');

const TODAY = '2026-11-14'; // a Saturday

function stateWithTask() {
  const s = C.emptyState();
  s.tasks.push({ id: 't1', title: 'Read chapter 3', date: TODAY, minutes: 40, spaceId: 'space_1', done: false, doneAt: null, createdAt: 1 });
  return s;
}
function withProposal(s, actions) {
  s.messages.push({ id: 'm1', role: 'assistant', text: 'ok', at: 1, proposal: { status: 'pending', source: 'ai', actions } });
  return s;
}

test('dates: week starts on Monday and addDays crosses months', () => {
  assert.equal(C.weekStart(TODAY), '2026-11-09');
  assert.equal(C.weekStart('2026-11-09'), '2026-11-09');
  assert.equal(C.addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(C.validDate('2026-02-30'), false);
});

test('normalize repairs missing fields and rejects newer data', () => {
  const s = C.normalize({ tasks: [{ id: 'a', title: 'x', date: 'bad', spaceId: 'gone' }] });
  assert.equal(s.tasks[0].date, null);
  assert.equal(s.tasks[0].spaceId, null);
  assert.equal(s.spaces.length, 4);
  assert.throws(() => C.normalize({ version: 99 }));
});

test('validateActions keeps good actions and reports bad ones', () => {
  const s = stateWithTask();
  const { actions, rejected } = C.validateActions(s, [
    { type: 'add_task', title: '  Write  outline ', date: 'tomorrow', minutes: 'x', space: '学习' },
    { type: 'update_task', taskId: 't1', date: '2026-11-15' },
    { type: 'update_task', taskId: 'missing', date: '2026-11-15' },
    { type: 'format_disk' },
    { type: 'add_habit', title: 'Run', perWeek: 30 },
  ]);
  assert.deepEqual(actions[0], { type: 'add_task', title: 'Write outline', date: null, minutes: 30, spaceId: 'space_1' });
  assert.deepEqual(actions[1], { type: 'update_task', taskId: 't1', date: '2026-11-15' });
  assert.equal(actions[2].perWeek, 7);
  assert.equal(rejected.length, 2);
});

test('nothing changes until a proposal is accepted, and accepting twice is a no-op', () => {
  const s = withProposal(stateWithTask(), [
    { type: 'add_task', title: 'New', date: null, minutes: 20, spaceId: null },
    { type: 'complete_task', taskId: 't1' },
    { type: 'remember', text: 'Works best in the morning' },
  ]);
  const before = JSON.stringify(s);
  const next = C.resolveProposal(s, 'm1', true, 1000);
  assert.equal(JSON.stringify(s), before, 'input state must not be mutated');
  assert.equal(next.tasks.length, 2);
  assert.equal(next.tasks[0].done, true);
  assert.equal(next.tasks[1].origin, 'ai');
  assert.equal(next.memory[0].text, 'Works best in the morning');
  const again = C.resolveProposal(next, 'm1', true, 2000);
  assert.equal(again.tasks.length, 2);
});

test('dismissing a proposal writes nothing', () => {
  const s = withProposal(stateWithTask(), [{ type: 'delete_task', taskId: 't1' }]);
  const next = C.resolveProposal(s, 'm1', false);
  assert.equal(next.tasks.length, 1);
  assert.equal(next.messages[0].proposal.status, 'dismissed');
});

test('a stale proposal fails as a whole', () => {
  const s = withProposal(stateWithTask(), [
    { type: 'add_task', title: 'New', date: null, minutes: 20, spaceId: null },
    { type: 'complete_task', taskId: 't1' },
  ]);
  s.tasks = [];
  assert.throws(() => C.resolveProposal(s, 'm1', true));
});

test('parseReply reads JSON, fenced JSON, and falls back to plain text', () => {
  assert.deepEqual(C.parseReply('{"reply":"hi","actions":[{"type":"remember","text":"a"}]}').actions.length, 1);
  assert.equal(C.parseReply('```json\n{"reply":"hi"}\n```').reply, 'hi');
  const plain = C.parseReply('Sure, here is my advice.');
  assert.equal(plain.reply, 'Sure, here is my advice.');
  assert.deepEqual(plain.actions, []);
});

test('local mode parses dates and durations from each line', () => {
  assert.deepEqual(C.parseLine('明天 复习第三章 45分钟', TODAY), { type: 'add_task', title: '复习第三章', date: '2026-11-15', minutes: 45, space: null });
  assert.equal(C.parseLine('周三 写报告 1.5小时', TODAY).date, '2026-11-18');
  assert.equal(C.parseLine('周三 写报告 1.5小时', TODAY).minutes, 90);
  assert.equal(C.parseLine('下周一 开会', TODAY).date, '2026-11-16');
  assert.equal(C.parseLine('12月3日 交作业', TODAY).date, '2026-12-03');
  const reply = C.localReply('买菜\n记住：我早上效率高', TODAY);
  assert.deepEqual(reply.actions.map((a) => a.type), ['add_task', 'remember']);
});

test('context gives the model facts only: open tasks, habits this week, memory', () => {
  const s = stateWithTask();
  s.habits.push({ id: 'h1', title: 'Run', perWeek: 3, spaceId: null, log: { '2026-11-10': true, [TODAY]: true, '2026-11-01': true } });
  s.memory.push({ id: 'm', text: 'Morning person', at: 1, source: 'user' });
  const ctx = C.buildContext(s, TODAY, 'plan my day');
  assert.equal(ctx.openTasks[0].taskId, 't1');
  assert.equal(ctx.openTasks[0].space, '学习');
  assert.deepEqual(ctx.habits[0], { title: 'Run', targetPerWeek: 3, doneThisWeek: 2, doneToday: true });
  assert.deepEqual(ctx.memory, ['Morning person']);
  assert.equal(ctx.weekday, '周六');
});
