import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

type SourceInfo = {
  path: string;
  source: string;
  origin: 'package' | 'top-level';
  scope: 'user' | 'project' | 'temporary';
  baseDir?: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeLabel(value: string): string | undefined {
  return /^[\p{L}\p{N}@_.\/-]+$/u.test(value) && value !== '.' && value !== '..'
    ? value
    : undefined;
}

function repositoryLabel(source: string): string | undefined {
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(source)) return undefined;
  let path: string;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(source)) {
    try {
      path = new URL(source).pathname;
    } catch {
      return undefined;
    }
  } else {
    const ssh = /^(?:[^@\s/]+@)?[^:\s/]+:(.+)$/.exec(source);
    if (ssh) {
      path = ssh[1] ?? '';
    } else if (/^[\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+$/u.test(source)) {
      path = source;
    } else {
      return undefined;
    }
  }
  const parts = path
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/');
  const repo = parts.pop();
  const owner = parts.pop();
  if (!repo) return undefined;
  return safeLabel(repo === 'skills' && owner ? `${owner}/${repo}` : repo);
}

function ancestors(path: string): string[] {
  const result: string[] = [];
  let current = resolve(path);
  for (;;) {
    result.push(current);
    const parent = dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

/**
 * createSourceResolver 返回不带方括号的来源标签，正式包元数据优先，其次为路径匹配的安装锁和真实路径上的 Git 元数据，无法可靠识别时返回 local。
 * 每个实例同步读取本地普通文件并按绝对路径缓存，包括缺失和失败结果，文件改变后应创建新实例。
 * 可处理的读取或格式失败仅向 warn 发送不含路径、原始内容和凭据的提示，文件不存在属于正常降级。
 * 本函数不创建后台任务、不访问网络或启动子进程，同步文件系统操作不提供取消能力，应在可信本地文件系统上调用。
 */
export function createSourceResolver(
  home: string,
  cwd: string,
  warn: (message: string) => void,
): (info: SourceInfo) => string {
  const textCache = new Map<string, string | undefined>();
  const realCache = new Map<string, string>();
  const jsonCache = new Map<string, unknown>();
  const resultCache = new Map<string, string>();
  const gitCache = new Map<string, string | undefined>();

  function missing(error: unknown): boolean {
    return (
      record(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    );
  }

  function real(path: string): string {
    const absolute = resolve(path);
    const cached = realCache.get(absolute);
    if (cached !== undefined) return cached;
    let value = absolute;
    try {
      value = realpathSync(absolute);
    } catch (error) {
      if (!missing(error)) warn('技能来源：无法解析本地真实路径。');
    }
    realCache.set(absolute, value);
    return value;
  }

  function text(path: string): string | undefined {
    const absolute = resolve(path);
    if (textCache.has(absolute)) return textCache.get(absolute);
    let value: string | undefined;
    try {
      // 仅接受普通文件，避免误读目录、设备或命名管道造成非预期阻塞。
      if (statSync(absolute).isFile()) value = readFileSync(absolute, 'utf8');
      else warn('技能来源：本地元数据不是普通文件。');
    } catch (error) {
      if (!missing(error)) warn('技能来源：无法读取本地元数据。');
    }
    textCache.set(absolute, value);
    return value;
  }

  function json(path: string): unknown {
    const absolute = resolve(path);
    if (jsonCache.has(absolute)) return jsonCache.get(absolute);
    const content = text(absolute);
    let value: unknown;
    if (content !== undefined) {
      try {
        value = JSON.parse(content);
        if (!record(value)) {
          warn('技能来源：JSON 元数据结构无效。');
          value = undefined;
        }
      } catch {
        warn('技能来源：JSON 元数据损坏。');
      }
    }
    jsonCache.set(absolute, value);
    return value;
  }

  function packageLabel(info: SourceInfo): string | undefined {
    if (info.origin !== 'package') return undefined;
    const scopeBase =
      info.scope === 'user'
        ? join(home, '.pi', 'agent')
        : info.scope === 'project'
          ? join(cwd, '.pi')
          : cwd;
    const localSource = info.source.startsWith('~/')
      ? join(home, info.source.slice(2))
      : resolve(scopeBase, info.source);
    const packageRoot = info.baseDir
      ? resolve(scopeBase, info.baseDir)
      : !info.source.startsWith('npm:') && !info.source.startsWith('git:')
        ? localSource
        : undefined;
    if (packageRoot) {
      const manifest = json(join(packageRoot, 'package.json'));
      if (record(manifest)) {
        if (typeof manifest.name === 'string') {
          const label = safeLabel(manifest.name);
          if (label) return label;
        }
        warn('技能来源：包名称缺失或无效。');
      }
    }
    if (info.source.startsWith('npm:')) {
      const match = /^(?:@([^/@\s]+)\/)?([^/@\s]+)(?:@[^\s]+)?$/.exec(
        info.source.slice(4),
      );
      if (!match) return undefined;
      const name = match[2];
      return name
        ? safeLabel(match[1] ? `@${match[1]}/${name}` : name)
        : undefined;
    }
    if (info.source.startsWith('git:')) {
      // Pi 的 git: 来源允许主机简写和 @ref，引用后缀不能进入显示标签。
      const source = info.source.slice(4);
      const scheme = source.indexOf('://');
      const pathStart =
        scheme >= 0
          ? source.indexOf('/', scheme + 3)
          : source.includes(':')
            ? source.indexOf(':') + 1
            : source.indexOf('/');
      const ref = pathStart >= 0 ? source.indexOf('@', pathStart) : -1;
      const unversioned = ref >= 0 ? source.slice(0, ref) : source;
      const remote =
        !unversioned.includes('://') && /^[^/:]+\.[^/:]+\//.test(unversioned)
          ? `https://${unversioned}`
          : unversioned;
      return repositoryLabel(remote);
    }
    return undefined;
  }

  // 锁文件的 skillPath 是源仓库路径，不是安装位置，只有锁旁的 skills/<键>/SKILL.md 能证明归属。
  function lockLabel(commandPath: string): string | undefined {
    const locks = new Set([
      ...ancestors(cwd).map((dir) => join(dir, '.agents', '.skill-lock.json')),
      join(home, '.agents', '.skill-lock.json'),
    ]);
    for (const lock of locks) {
      const value = json(lock);
      if (value === undefined) continue;
      if (!record(value) || !record(value.skills)) {
        warn('技能来源：安装锁结构无效。');
        continue;
      }
      for (const [name, entry] of Object.entries(value.skills)) {
        if (!name || name === '.' || name === '..' || /[\\/]/.test(name))
          continue;
        const installed = join(dirname(lock), 'skills', name, 'SKILL.md');
        if (
          resolve(commandPath) !== resolve(installed) &&
          real(commandPath) !== real(installed)
        )
          continue;
        if (!record(entry) || typeof entry.source !== 'string') {
          warn('技能来源：安装锁来源字段无效。');
          continue;
        }
        const label = repositoryLabel(entry.source);
        if (label) return label;
        warn('技能来源：安装锁来源无法识别。');
      }
    }
    return undefined;
  }

  function gitLabel(commandPath: string): string | undefined {
    const directory = dirname(real(commandPath));
    if (gitCache.has(directory)) return gitCache.get(directory);
    let label: string | undefined;
    for (const root of ancestors(directory)) {
      const marker = join(root, '.git');
      let gitDir: string;
      try {
        if (statSync(marker).isDirectory()) gitDir = marker;
        else {
          const pointer = text(marker);
          const match = pointer && /^gitdir:\s*(.+?)\s*$/u.exec(pointer);
          if (!match?.[1]) {
            warn('技能来源：Git 目录指针无效。');
            continue;
          }
          gitDir = resolve(root, match[1]);
        }
      } catch (error) {
        if (!missing(error)) warn('技能来源：无法读取 Git 目录。');
        continue;
      }
      const common = text(join(gitDir, 'commondir'))?.trim();
      const configDir = common ? resolve(gitDir, common) : gitDir;
      const config = text(join(configDir, 'config'));
      let remote: string | undefined;
      let origin: string | undefined;
      let section: string | undefined;
      for (const line of config?.split(/\r?\n/) ?? []) {
        const header = /^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/.exec(line);
        if (header) {
          section = /^remote\s+"([^"]+)"$/i.exec(header[1] ?? '')?.[1];
          continue;
        }
        const url = /^\s*url\s*=\s*(.*?)\s*$/i.exec(line)?.[1];
        if (!section || !url) continue;
        const unquoted =
          url.startsWith('"') && url.endsWith('"') ? url.slice(1, -1) : url;
        const candidate = repositoryLabel(unquoted);
        remote ??= candidate;
        if (section === 'origin') origin ??= candidate;
      }
      label = origin ?? remote ?? safeLabel(basename(root));
      break;
    }
    gitCache.set(directory, label);
    return label;
  }

  return (info) => {
    const key = JSON.stringify(info);
    const cached = resultCache.get(key);
    if (cached !== undefined) return cached;
    const commandPath = isAbsolute(info.path)
      ? info.path
      : resolve(cwd, info.path);
    const label =
      packageLabel(info) ??
      lockLabel(commandPath) ??
      gitLabel(commandPath) ??
      'local';
    resultCache.set(key, label);
    return label;
  };
}
