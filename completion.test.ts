import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import type { AutocompleteProvider } from '@earendil-works/pi-tui';
import { withSkillSources } from './completion.ts';
import type { SkillEntry } from './completion.ts';

const skills: SkillEntry[] = [
  { name: 'skill:init', source: 'wisharness', description: '初始化' },
  { name: 'skill:runner', source: 'wisharness' },
  { name: 'skill:glab-migrate', source: 'ai-coding' },
  { name: 'skill:research', source: 'mattpocock/skills' },
];

function setup() {
  const native = new CombinedAutocompleteProvider(
    [
      { name: 'model', description: '选择模型' },
      {
        name: 'custom',
        getArgumentCompletions: () => [{ value: 'arg', label: 'arg' }],
      },
      ...skills,
    ],
    '/tmp',
  );
  return withSkillSources(native, () => skills);
}

async function suggest(
  provider: AutocompleteProvider,
  input: string,
  force = false,
) {
  return provider.getSuggestions([input], 0, input.length, {
    signal: new AbortController().signal,
    force,
  });
}

test('斜杠列表装饰技能，保留原命令和描述且不重复', async () => {
  const result = await suggest(setup(), '/');
  assert.ok(result);
  assert.deepEqual(
    result.items.find((item) => item.value === 'model'),
    {
      value: 'model',
      label: 'model',
      description: '选择模型',
    },
  );
  const skill = result.items.find((item) => item.value === 'skill:init');
  assert.deepEqual(skill, {
    value: 'skill:init',
    label: '[wisharness] /skill:init',
    description: '初始化',
  });
  assert.equal(result.items.length, 6);
});

test('按来源搜索忽略大小写，选中后插入原技能命令', async () => {
  const provider = setup();
  const result = await suggest(provider, '/WisHarness');
  assert.ok(result);
  assert.deepEqual(
    result.items.map((item) => item.value),
    ['skill:init', 'skill:runner'],
  );
  const selected = result.items[0];
  assert.ok(selected);
  assert.deepEqual(
    provider.applyCompletion(['/WisHarness'], 0, 11, selected, result.prefix),
    {
      lines: ['/skill:init '],
      cursorLine: 0,
      cursorCol: 12,
    },
  );
});

test('来源和技能名组合过滤且完整替换搜索文本', async () => {
  const provider = setup();
  const input = '  /wisharness ru';
  const result = await suggest(provider, input);
  assert.ok(result);
  assert.deepEqual(
    result.items.map((item) => item.value),
    ['skill:runner'],
  );
  const selected = result.items[0];
  assert.ok(selected);
  const output = provider.applyCompletion(
    [input + '保留尾部'],
    0,
    input.length,
    selected,
    result.prefix,
  );
  assert.equal(output.lines[0], '  /skill:runner 保留尾部');
});

test('拥有者和仓库的斜杠不被误判成文件路径', async () => {
  const provider = setup();
  const input = '/mattpocock/skills';
  const result = await suggest(provider, input);
  assert.ok(result);
  const item = result.items[0];
  assert.ok(item);
  assert.equal(
    provider.applyCompletion([input], 0, input.length, item, result.prefix)
      .lines[0],
    '/skill:research ',
  );
});

test('继续支持原生技能名称搜索和原生命令参数补全', async () => {
  const provider = setup();
  const result = await suggest(provider, '/glab');
  assert.ok(result);
  assert.equal(result.items[0]?.label, '[ai-coding] /skill:glab-migrate');
  const argument = await suggest(provider, '/custom a');
  assert.deepEqual(argument, {
    prefix: 'a',
    items: [{ value: 'arg', label: 'arg' }],
  });
  const item = argument?.items[0];
  assert.ok(item);
  assert.equal(
    provider.applyCompletion(['/custom a'], 0, 9, item, 'a').lines[0],
    '/custom arg',
  );
  assert.equal(await suggest(provider, '/skill:init wisharness'), null);
  assert.equal(await suggest(provider, '/unknown-source'), null);
});

test('Tab 强制补全仍支持来源和来源加技能名，不按路径插入', async () => {
  const provider = setup();
  for (const input of ['/wisharness', '/wisharness ru', '/mattpocock/skills']) {
    const result = await suggest(provider, input, true);
    assert.ok(result);
    const item = result.items[0];
    assert.ok(item);
    assert.equal(result.prefix, input);
    assert.equal(
      provider.applyCompletion([input], 0, input.length, item, result.prefix)
        .lines[0],
      `/${item.value} `,
    );
  }
});

test('同名来源不会覆盖原生命令参数补全，包括 Tab 强制补全', async () => {
  const native = new CombinedAutocompleteProvider(
    [
      ...skills,
      {
        name: 'wisharness',
        getArgumentCompletions: () => [{ value: 'inspect', label: 'inspect' }],
      },
    ],
    '/tmp',
  );
  const provider = withSkillSources(native, () => skills);
  for (const force of [false, true]) {
    const result = await suggest(provider, '/wisharness in', force);
    assert.deepEqual(result, {
      prefix: 'in',
      items: [{ value: 'inspect', label: 'inspect' }],
    });
    const item = result?.items[0];
    assert.ok(item);
    assert.equal(
      provider.applyCompletion(['/wisharness in'], 0, 14, item, 'in').lines[0],
      '/wisharness inspect',
    );
  }
});

test('宿主隐藏的技能不会因来源搜索重新暴露', async () => {
  const provider = withSkillSources(
    new CombinedAutocompleteProvider([{ name: 'model' }], '/tmp'),
    () => skills,
  );
  assert.equal(await suggest(provider, '/wisharness'), null);
  assert.equal(await suggest(provider, '/wisharness init'), null);
  const list = await suggest(provider, '/');
  assert.deepEqual(list?.items, [{ value: 'model', label: 'model' }]);
});

test('第二行不作为来源搜索处理', async () => {
  const native = new CombinedAutocompleteProvider(skills, '/tmp');
  const provider = withSkillSources(native, () => skills);
  const lines = ['正文', '/wisharness'];
  const options = { signal: new AbortController().signal };
  assert.deepEqual(
    await provider.getSuggestions(lines, 1, 11, options),
    await native.getSuggestions(lines, 1, 11, options),
  );
});

test('装饰项插入仍交给原提供者且保留原对象身份', async () => {
  const item = { value: 'skill:init', label: 'skill:init' };
  const native: AutocompleteProvider = {
    async getSuggestions() {
      return { prefix: '/', items: [item] };
    },
    applyCompletion(lines, cursorLine, cursorCol, selected) {
      assert.equal(selected, item);
      return { lines: ['由原提供者插入'], cursorLine, cursorCol };
    },
  };
  const provider = withSkillSources(native, () => skills);
  const result = await suggest(provider, '/');
  const selected = result?.items[0];
  assert.ok(selected);
  assert.equal(
    provider.applyCompletion(['/'], 0, 1, selected, '/').lines[0],
    '由原提供者插入',
  );
});

test('不读取磁盘库存，动态命令清单移除的技能立即消失', async () => {
  let active = skills;
  const native = new CombinedAutocompleteProvider(skills, '/tmp');
  const provider = withSkillSources(native, () => active);
  assert.equal((await suggest(provider, '/wisharness'))?.items.length, 2);
  active = [];
  assert.equal(await suggest(provider, '/wisharness'), null);
});

test('强制路径补全、取消、其他提供者和文件补全判断委托给宿主', async () => {
  const calls: string[] = [];
  const native: AutocompleteProvider = {
    triggerCharacters: ['#'],
    async getSuggestions(_lines, _line, _col, options) {
      calls.push(
        options.force ? 'force' : options.signal.aborted ? 'aborted' : 'normal',
      );
      return {
        prefix: 'file',
        items: [{ value: 'file.txt', label: 'file.txt' }],
      };
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      calls.push('apply');
      return { lines, cursorLine, cursorCol };
    },
    shouldTriggerFileCompletion() {
      calls.push('file');
      return false;
    },
  };
  const provider = withSkillSources(native, () => skills);
  assert.deepEqual(provider.triggerCharacters, ['#']);
  assert.deepEqual(await suggest(provider, '/wisharness', true), {
    prefix: 'file',
    items: [{ value: 'file.txt', label: 'file.txt' }],
  });
  const controller = new AbortController();
  controller.abort();
  await provider.getSuggestions(['/wisharness'], 0, 11, {
    signal: controller.signal,
  });
  await suggest(provider, '#123');
  provider.applyCompletion(
    ['file'],
    0,
    4,
    { value: 'file.txt', label: 'file.txt' },
    'file',
  );
  assert.equal(provider.shouldTriggerFileCompletion?.(['file'], 0, 4), false);
  assert.deepEqual(calls, [
    'normal',
    'force',
    'aborted',
    'normal',
    'apply',
    'file',
  ]);
});
