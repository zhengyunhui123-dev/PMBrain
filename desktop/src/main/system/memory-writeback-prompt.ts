import type { MemoryWritebackStatus, MemoryWritebackUpdate } from '../../../../shared/contracts/brain.js';

export async function askWritebackOnce(opts: {
  shared: boolean;
  read: () => Promise<MemoryWritebackStatus>;
  save: (value: MemoryWritebackUpdate) => Promise<unknown>;
  choose: () => Promise<number>;
}): Promise<void> {
  if(opts.shared)return;
  const state=await opts.read();
  if(state.notice_shown||state.mode!=='off')return;
  const choice=await opts.choose();
  const modes=['off','salient','all'] as const;
  await opts.save(choice>=0&&choice<modes.length?{mode:modes[choice],notice_shown:true}:{notice_shown:true});
}
