import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createSourceResolver } from './sources.ts';

// 每个场景拥有独立的真实文件树，测试结束后回收，避免依赖用户环境或执行顺序。
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'pi-sources-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const cwd = join(root, 'project', 'child');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const warnings: string[] = [];
  const resolver = createSourceResolver(home, cwd, (message) =>
    warnings.push(message),
  );
  const put = (path: string, content = '') => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  const skill = (path: string) => put(path, '# 技能');
  const lock = (directory: string, skills: unknown) =>
    put(
      join(directory, '.agents', '.skill-lock.json'),
      JSON.stringify({ version: 1, skills }),
    );
  const info = (path: string) =>
    ({
      path,
      source: 'user',
      origin: 'top-level',
      scope: 'user',
    }) satisfies Parameters<typeof resolver>[0];
  return { root, home, cwd, warnings, resolver, put, skill, lock, info };
}

test('复制安装的技能按锁的安装路径归属，忽略源仓库 skillPath', (t) => {
  const f = fixture(t);
  const migrate = f.skill(join(f.home, '.agents/skills/glab-migrate/SKILL.md'));
  const setup = f.skill(join(f.home, '.agents/skills/glab-setup/SKILL.md'));
  const tdd = f.skill(join(f.home, '.agents/skills/tdd/SKILL.md'));
  f.lock(f.home, {
    'glab-migrate': {
      source: 'https://wisgit.qihoo.net/wd/ai-coding.git',
      skillPath: 'skills/glab-migrate/SKILL.md',
    },
    'glab-setup': { source: 'https://wisgit.qihoo.net/wd/ai-coding.git' },
    tdd: {
      source: 'mattpocock/skills',
      skillPath: 'skills/engineering/tdd/SKILL.md',
    },
  });
  assert.equal(f.resolver(f.info(migrate)), 'ai-coding');
  assert.equal(f.resolver(f.info(setup)), 'ai-coding');
  assert.equal(f.resolver(f.info(tdd)), 'mattpocock/skills');
  assert.deepEqual(f.warnings, []);
});

test('同名技能和锁键路径穿越不得误归属', (t) => {
  const f = fixture(t);
  f.lock(f.home, {
    demo: { source: 'owner/wrong' },
    '../outside': { source: 'owner/wrong' },
  });
  const path = f.skill(join(f.cwd, 'demo/SKILL.md'));
  assert.equal(f.resolver(f.info(path)), 'local');
  assert.equal(
    f.resolver(f.info(f.skill(join(f.home, '.agents/outside/SKILL.md')))),
    'local',
  );
});

test('项目祖先安装锁匹配实际路径，相邻项目不继承名称归属', (t) => {
  const f = fixture(t);
  const project = dirname(f.cwd);
  f.lock(project, { demo: { source: 'team/project-skills' } });
  const path = f.skill(join(project, '.agents/skills/demo/SKILL.md'));
  assert.equal(
    f.resolver({ ...f.info(path), scope: 'project' }),
    'project-skills',
  );
  assert.equal(
    f.resolver(f.info(f.skill(join(f.cwd, '.agents/skills/demo/SKILL.md')))),
    'local',
  );
});

test('锁安装目录的 symlink 和真实 command path 可以相互匹配', (t) => {
  const f = fixture(t);
  const path = f.skill(join(f.root, 'checkout/skills/helper-ip/SKILL.md'));
  mkdirSync(join(f.home, '.agents/skills'), { recursive: true });
  symlinkSync(dirname(path), join(f.home, '.agents/skills/helper-ip'), 'dir');
  f.lock(f.home, {
    'helper-ip': { source: 'https://wisgit.qihoo.net/wd/ai-coding.git' },
  });
  assert.equal(f.resolver(f.info(path)), 'ai-coding');
  assert.equal(
    f.resolver(f.info(join(f.home, '.agents/skills/helper-ip/SKILL.md'))),
    'ai-coding',
  );
});

test('无锁时沿真实 symlink 路径查 Git，origin 优先且凭据不会输出', (t) => {
  const f = fixture(t);
  const path = f.skill(join(f.root, 'checkout/skills/helper-ip/SKILL.md'));
  f.put(
    join(f.root, 'checkout/.git/config'),
    '[remote "upstream"]\n url = https://example.test/team/wrong.git\n[remote "origin"]\n url = https://token:SECRET@example.test/wd/ai-coding.git\n',
  );
  const link = join(f.home, 'linked');
  symlinkSync(dirname(path), link, 'dir');
  assert.equal(f.resolver(f.info(join(link, 'SKILL.md'))), 'ai-coding');
  assert.ok(!f.warnings.join('').includes('SECRET'));
});

test('Git worktree 的相对 gitdir 和 commondir 指向共享配置', (t) => {
  const f = fixture(t);
  const worktree = join(f.root, 'worktree');
  const path = f.skill(join(worktree, 'skills/test/SKILL.md'));
  f.put(
    join(worktree, '.git'),
    'gitdir: ../repository/.git/worktrees/branch\n',
  );
  f.put(join(f.root, 'repository/.git/worktrees/branch/commondir'), '../..\n');
  f.put(
    join(f.root, 'repository/.git/config'),
    '[remote "origin"]\n url = git@github.com:mattpocock/skills.git\n',
  );
  assert.equal(f.resolver(f.info(path)), 'mattpocock/skills');
});

test('Git 独立 gitdir 使用绝对路径，无 remote 时使用仓库根名', (t) => {
  const f = fixture(t);
  const path = f.skill(join(f.root, 'standalone/sub/SKILL.md'));
  const gitDir = join(f.root, 'metadata');
  f.put(join(f.root, 'standalone/.git'), `gitdir: ${gitDir}\n`);
  f.put(join(gitDir, 'config'), '[core]\n bare = false\n');
  assert.equal(f.resolver(f.info(path)), 'standalone');
  assert.deepEqual(f.warnings, []);
});

test('正式 npm 和 git 包来源优先于安装锁并处理 scope 与版本', (t) => {
  const f = fixture(t);
  const path = f.skill(join(f.home, '.agents/skills/demo/SKILL.md'));
  f.lock(f.home, { demo: { source: 'owner/wrong' } });
  for (const scope of ['user', 'project', 'temporary']) {
    if (scope !== 'user' && scope !== 'project' && scope !== 'temporary')
      continue;
    assert.equal(
      f.resolver({
        ...f.info(path),
        origin: 'package',
        scope,
        source: 'npm:@example/pi-tools@1.0.0',
      }),
      '@example/pi-tools',
    );
    assert.equal(
      f.resolver({
        ...f.info(path),
        origin: 'package',
        scope,
        source: 'npm:pi-tools@latest',
      }),
      'pi-tools',
    );
    for (const source of [
      'git:github.com/owner/tools@v1',
      'git:https://user:SECRET@example.test/owner/tools.git@feature/branch',
      'git:git@example.test:owner/tools.git@feature/branch',
    ]) {
      assert.equal(
        f.resolver({ ...f.info(path), origin: 'package', scope, source }),
        'tools',
      );
    }
  }
});

test('本地 ZIP 包通过 baseDir 的 package.json 确认正式包名', (t) => {
  const f = fixture(t);
  const packageRoot = join(f.root, 'zip/releases/v1/plugin');
  const path = f.skill(join(packageRoot, 'skills/init/SKILL.md'));
  f.put(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'wisharness' }),
  );
  assert.equal(
    f.resolver({
      ...f.info(path),
      origin: 'package',
      source: packageRoot,
      baseDir: packageRoot,
    }),
    'wisharness',
  );
});

test('本地包相对路径依据 user、project、temporary scope 解析', (t) => {
  const f = fixture(t);
  const path = f.skill(join(f.root, 'external/SKILL.md'));
  f.put(join(f.home, '.pi/agent/pkg/package.json'), '{"name":"user-package"}');
  f.put(join(f.cwd, '.pi/pkg/package.json'), '{"name":"project-package"}');
  f.put(join(f.cwd, 'pkg/package.json'), '{"name":"temporary-package"}');
  assert.equal(
    f.resolver({ ...f.info(path), origin: 'package', source: './pkg' }),
    'user-package',
  );
  assert.equal(
    f.resolver({
      ...f.info(path),
      origin: 'package',
      source: './pkg',
      scope: 'project',
    }),
    'project-package',
  );
  assert.equal(
    f.resolver({
      ...f.info(path),
      origin: 'package',
      source: './pkg',
      scope: 'temporary',
    }),
    'temporary-package',
  );
});

test('缺少可靠元数据时为 local，不从目录或技能名称猜测', (t) => {
  const f = fixture(t);
  const path = f.skill(join(f.cwd, 'ai-coding/skills/glab-migrate/SKILL.md'));
  assert.equal(f.resolver(f.info(path)), 'local');
  assert.equal(
    f.resolver({
      ...f.info(path),
      origin: 'package',
      source: join(f.root, 'wisharness'),
    }),
    'local',
  );
  assert.deepEqual(f.warnings, []);
});

test('损坏锁只警告一次且不泄露原文，仍可降级到 Git', (t) => {
  const f = fixture(t);
  const path = f.skill(join(f.cwd, 'demo/SKILL.md'));
  f.put(join(f.home, '.agents/.skill-lock.json'), '{SECRET');
  f.put(
    join(f.cwd, '.git/config'),
    '[remote "origin"]\n url = https://user:SECRET@example.test/team/real.git\n',
  );
  assert.equal(f.resolver(f.info(path)), 'real');
  assert.equal(f.resolver(f.info(path)), 'real');
  assert.equal(f.warnings.length, 1);
  assert.ok(!f.warnings.join('').includes('SECRET'));
});

test('JSON 类型、来源字段及包名经过验证，不接受控制字符标签', (t) => {
  const f = fixture(t);
  const path = f.skill(join(f.home, '.agents/skills/demo/SKILL.md'));
  f.lock(f.home, { demo: { source: 'owner/evil\u001b[31m' } });
  const packageRoot = join(f.root, 'package');
  f.put(join(packageRoot, 'package.json'), '{"name":42}');
  assert.equal(
    f.resolver({ ...f.info(path), origin: 'package', source: packageRoot }),
    'local',
  );
  assert.ok(f.warnings.length >= 2);
  for (const content of [
    '[]',
    'null',
    '{"skills":[]}',
    '{"skills":{"demo":{"source":42}}}',
  ]) {
    f.put(join(f.home, '.agents/.skill-lock.json'), content);
    const warnings: string[] = [];
    const resolver = createSourceResolver(f.home, f.cwd, (message) =>
      warnings.push(message),
    );
    assert.equal(resolver(f.info(path)), 'local');
    assert.ok(warnings.length > 0);
  }
});

test('元数据非普通文件的可测读取失败会警告并降级', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, '.agents/.skill-lock.json'), { recursive: true });
  assert.equal(
    f.resolver(f.info(f.skill(join(f.cwd, 'demo/SKILL.md')))),
    'local',
  );
  assert.equal(f.warnings.length, 1);
});

test('不可读锁的权限错误正常降级，测试后恢复权限以便清理', (t) => {
  if (process.getuid?.() === 0) return t.skip('root 不受普通文件权限限制。');
  const f = fixture(t);
  const lockPath = f.lock(f.home, {});
  chmodSync(lockPath, 0);
  try {
    assert.equal(
      f.resolver(f.info(f.skill(join(f.cwd, 'demo/SKILL.md')))),
      'local',
    );
    assert.equal(f.warnings.length, 1);
  } finally {
    chmodSync(lockPath, 0o600);
  }
});

test('解析器缓存文件快照，新实例可观察后续修改', (t) => {
  const f = fixture(t);
  const first = f.skill(join(f.home, '.agents/skills/one/SKILL.md'));
  const second = f.skill(join(f.home, '.agents/skills/two/SKILL.md'));
  f.lock(f.home, {
    one: { source: 'owner/initial' },
    two: { source: 'owner/initial' },
  });
  assert.equal(f.resolver(f.info(first)), 'initial');
  f.lock(f.home, {
    one: { source: 'owner/changed' },
    two: { source: 'owner/changed' },
  });
  assert.equal(f.resolver(f.info(second)), 'initial');
  assert.equal(
    createSourceResolver(f.home, f.cwd, () => {})(f.info(second)),
    'changed',
  );
});
