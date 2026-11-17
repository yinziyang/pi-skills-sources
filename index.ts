import { homedir } from 'node:os';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { withSkillSources } from './completion.ts';
import { createSourceResolver } from './sources.ts';

/** 在交互式 Pi 中安装来源补全，不修改技能文件、命令注册和模型提示词。 */
export default function skillSources(pi: ExtensionAPI): void {
  let installed = false;
  let resolveSource: ReturnType<typeof createSourceResolver>;
  pi.on('session_start', (_event, ctx) => {
    resolveSource = createSourceResolver(homedir(), ctx.cwd, (message) => {
      ctx.ui.notify(`pi-skills-sources：${message}`, 'warning');
    });
    if (ctx.mode !== 'tui' || installed) return;
    // 同一实例只注册一次，避免重复堆叠补全包装器。
    // 会话切换和 /reload 时 Pi 重新调用扩展工厂并重建补全链，生命周期由宿主负责。
    installed = true;
    ctx.ui.addAutocompleteProvider((current) =>
      withSkillSources(current, () =>
        pi
          .getCommands()
          .filter((command) => command.source === 'skill')
          .map((command) => ({
            name: command.name,
            description: command.description,
            source: resolveSource(command.sourceInfo),
          })),
      ),
    );
  });
}
