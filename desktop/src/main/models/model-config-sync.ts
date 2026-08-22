import { getSetupInfo, syncChatModelDefaultsInConfig } from '../config-manager.js';
import { runCli, runCliChecked, type CliRuntime } from '../cli-runner.js';

export async function syncModelDefaultsToConfigFile(
  runtime: CliRuntime,
  options: { resetAdvanced?: boolean } = {},
): Promise<void> {
  const chatModel = getSetupInfo().current.chatModel?.trim();
  if (!chatModel) return;
  if (options.resetAdvanced) {
    await runCliChecked(runtime, ['config', 'unset', '--pattern', 'models.tier.']);
    await runCliChecked(runtime, ['config', 'unset', '--pattern', 'models.dream.']);
    for (const key of ['models.propose_takes', 'models.grade_takes', 'models.calibration_profile']) {
      const result = await runCli(runtime, ['config', 'unset', key]);
      const message = `${result.stderr}\n${result.stdout}`;
      if (result.code !== 0 && !/Config key not found:/i.test(message)) {
        throw new Error(message.trim() || `无法清理 Dream 阶段模型覆盖：${key}`);
      }
    }
  }
  syncChatModelDefaultsInConfig(chatModel);
}
