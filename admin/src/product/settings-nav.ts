export interface SettingNavItem { key: string; label: string; group: string; desktop?: boolean }
export function visibleSettingItems<T extends SettingNavItem>(items: T[], query: string, desktop: boolean): T[] {
  const text = query.trim().toLowerCase();
  return items.filter(item => (desktop || !item.desktop || item.key === 'models') && (!text || item.label.toLowerCase().includes(text) || item.group.toLowerCase().includes(text)));
}
export function settingGroupNames(items: SettingNavItem[]): string[] {
  return [...new Set(items.map(item => item.group))];
}
export const SETTINGS_RETURN_KEY='pmbrain.settingsReturn';
function settingsTarget(target:string){
  const page=target.replace(/^#/,'').split('?')[0];
  return page==='settings'||page==='config'||page.startsWith('settings-');
}
export function nextSettingsOrigin(from:string,to:string,stored:string|null):string|null{
  return !settingsTarget(from)&&settingsTarget(to)?from:stored;
}
export function settingsReturnTarget(stored:string|null,creation:string|null):string{
  return [stored,creation].find(target=>target&&!settingsTarget(target)&&target!=='login')||'home';
}
