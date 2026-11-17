import type {
  AutocompleteItem,
  AutocompleteProvider,
} from '@earendil-works/pi-tui';

/** 仅传入 Pi 当前已加载的技能，name 保留原生的 skill: 前缀。 */
export interface SkillEntry {
  name: string;
  source: string;
  description?: string;
}

/** 包装补全显示和来源搜索，不注册命令，也不改变原技能的执行名称。 */
export function withSkillSources(
  current: AutocompleteProvider,
  getSkills: () => readonly SkillEntry[],
): AutocompleteProvider {
  const ownedItems = new WeakSet<AutocompleteItem>();
  const originalItems = new WeakMap<AutocompleteItem, AutocompleteItem>();
  function ownItem(skill: SkillEntry): AutocompleteItem {
    const item = toItem(skill);
    ownedItems.add(item);
    return item;
  }
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, line, col, options) {
      const beforeCursor = (lines[line] ?? '').slice(0, col);
      const commandText = beforeCursor.trimStart();
      if (
        line !== 0 ||
        !commandText.startsWith('/') ||
        options.signal.aborted
      ) {
        return current.getSuggestions(lines, line, col, options);
      }
      const query = commandText.slice(1).toLowerCase();
      const separator = query.search(/\s/);
      // getCommands 不考虑 enableSkillCommands，必须用原生斜杠菜单限制可见技能。
      // 这里只探测补全，不读取未受信任项目的配置，也不重新暴露其他扩展隐藏的技能。
      const menu = await current.getSuggestions(['/'], 0, 1, {
        ...options,
        force: false,
      });
      if (options.signal.aborted) return null;
      const visible = new Set(menu?.items.map((item) => item.value));
      const skills = getSkills().filter((skill) => visible.has(skill.name));
      const byName = new Map(skills.map((skill) => [skill.name, skill]));
      const sourceToken = separator === -1 ? query : query.slice(0, separator);
      const exactSource = skills.some(
        (skill) => skill.source.toLowerCase() === sourceToken,
      );
      // Tab 会对含空格的来源搜索使用 force，已知来源仍应补全技能，其余保留强制路径补全。
      if (options.force && !exactSource) {
        return current.getSuggestions(lines, line, col, options);
      }
      const original =
        commandText === '/' && !options.force
          ? menu
          : await current.getSuggestions(
              lines,
              line,
              col,
              exactSource ? { ...options, force: false } : options,
            );
      if (options.signal.aborted) return original;
      if (separator !== -1) {
        // 只有完整来源名后面的词才作为搜索条件，原生命令的参数补全优先。
        if (original || byName.has(query.slice(0, separator))) return original;
        const source = query.slice(0, separator);
        const terms = query
          .slice(separator)
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const matches = skills.filter(
          (skill) =>
            skill.source.toLowerCase() === source &&
            terms.every((term) => skill.name.toLowerCase().includes(term)),
        );
        return matches.length
          ? { prefix: commandText, items: matches.map(ownItem) }
          : null;
      }
      // 保留原生排序和其他扩展的条目，只装饰技能项并追加来源匹配项。
      const items = (options.force ? [] : (original?.items ?? [])).map(
        (item) => {
          const skill = byName.get(item.value);
          if (!skill) return item;
          const decorated = {
            ...item,
            label: `[${skill.source}] /${skill.name}`,
          };
          originalItems.set(decorated, item);
          return decorated;
        },
      );
      const seen = new Set(items.map((item) => item.value));
      for (const skill of skills) {
        if (
          query &&
          skill.source.toLowerCase().includes(query) &&
          !seen.has(skill.name)
        ) {
          items.push(ownItem(skill));
          seen.add(skill.name);
        }
      }
      return items.length
        ? {
            prefix: options.force
              ? commandText
              : (original?.prefix ?? commandText),
            items,
          }
        : original;
    },
    applyCompletion(lines, line, col, item, prefix) {
      const beforeCursor = (lines[line] ?? '').slice(0, col);
      if (
        ownedItems.has(item) &&
        prefix.startsWith('/') &&
        beforeCursor.trimStart() === prefix
      ) {
        // 来源可包含斜杠，不能交给原生补全误判为文件路径。
        const text = lines[line] ?? '';
        const start = col - prefix.length;
        const replacement = `/${item.value} `;
        const result = [...lines];
        result[line] = text.slice(0, start) + replacement + text.slice(col);
        return {
          lines: result,
          cursorLine: line,
          cursorCol: start + replacement.length,
        };
      }
      return current.applyCompletion(
        lines,
        line,
        col,
        originalItems.get(item) ?? item,
        prefix,
      );
    },
    shouldTriggerFileCompletion(lines, line, col) {
      return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
    },
  };
}

function toItem(skill: SkillEntry): AutocompleteItem {
  return {
    value: skill.name,
    label: `[${skill.source}] /${skill.name}`,
    description: skill.description,
  };
}
