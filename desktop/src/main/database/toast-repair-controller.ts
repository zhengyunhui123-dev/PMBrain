import type { CliRuntime } from '../cli-runner.js';
import type { SetupInfo } from '../config-manager.js';

export interface DesktopToastDiagnoseResult {
  status: string;
  stagingPath: string;
  productionPath: string | null;
  canAutoRepair: boolean;
  table?: string;
  column?: string;
  repairability?: string;
  recommendedAction?: string;
  row?: Record<string, unknown>;
  error?: string;
}

export interface DesktopToastRepairResult {
  status: 'replaced' | 'refused' | 'needs-confirm';
  stagingPath?: string;
  preservedPath?: string;
  pages?: number;
  chunks?: number;
  facts?: number;
  diagnose?: DesktopToastDiagnoseResult;
  error?: string;
}

interface StartupProgress {
  visible: boolean;
  stage: 'database' | 'migration' | 'sidecar' | 'health';
  title: string;
  message: string;
}

export interface ToastRepairControllerDependencies {
  setupInfo: () => SetupInfo;
  runtime: () => CliRuntime;
  runCliChecked: (runtime: CliRuntime, args: string[]) => Promise<{ stdout: string }>;
  sendStartupProgress: (progress: StartupProgress) => void;
  hideStartupProgress: () => void;
  stopSidecar: () => Promise<void>;
  log: (message: string) => void;
}

function parseJsonObject<T>(text: string, errorMessage: string): T {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(errorMessage);
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch (error) {
    throw new Error(errorMessage, { cause: error });
  }
}

function parseJsonFromCli<T extends { status?: string }>(
  text: string,
  allowed: string[],
  errorMessage: string,
): T {
  try {
    return parseJsonObject<T>(text, errorMessage);
  } catch (error) {
    const recovered = parseJsonObject<T>(
      error instanceof Error ? error.message : String(error),
      errorMessage,
    );
    if (!allowed.includes(recovered.status ?? '')) throw error instanceof Error ? error : new Error(errorMessage);
    return recovered;
  }
}

export class ToastRepairController {
  constructor(private readonly dependencies: ToastRepairControllerDependencies) {}

  async diagnose(): Promise<DesktopToastDiagnoseResult> {
    const setup = this.dependencies.setupInfo();
    if (setup.needsSetup || setup.current.engine !== 'pglite') {
      throw new Error('大字段修复仅适用于本机 PGLite 知识库。');
    }
    this.dependencies.sendStartupProgress({
      visible: true,
      stage: 'database',
      title: '正在诊断数据库大字段',
      message: '正在复制一份知识库到临时目录并只读检查。当前正式库不会被修改。',
    });
    await this.dependencies.stopSidecar();
    try {
      const completed = await this.runRepair([
        'repair', 'toast-diagnose',
        '--path', setup.current.databasePath ?? setup.defaults.databasePath,
        '--json',
      ]);
      const raw = parseJsonFromCli<{
        status?: string;
        stagingPath?: string;
        productionPath?: string | null;
        baseTable?: { name?: string };
        column?: string;
        repairability?: string;
        recommendedAction?: string;
        row?: Record<string, unknown>;
        error?: string;
      }>(completed.stdout, ['located', 'toast-table-located', 'open-failed', 'healthy'], '大字段诊断返回格式无效。');
      const canAutoRepair = raw.status !== 'open-failed'
        && raw.status !== 'healthy'
        && raw.repairability !== 'canonical-page'
        && raw.repairability !== 'fact'
        && (raw.baseTable?.name === 'content_chunks'
          || raw.repairability === 'derived'
          || raw.repairability === 'rebuildable-chunk');
      const result: DesktopToastDiagnoseResult = {
        status: raw.status ?? 'open-failed',
        stagingPath: raw.stagingPath ?? '',
        productionPath: raw.productionPath ?? setup.current.databasePath ?? null,
        canAutoRepair,
        table: raw.baseTable?.name,
        column: raw.column,
        repairability: raw.repairability,
        recommendedAction: raw.recommendedAction,
        row: raw.row,
        error: raw.error,
      };
      this.dependencies.log(`PGLite toast diagnose ${result.status} staging=${result.stagingPath}`);
      return result;
    } finally {
      this.dependencies.hideStartupProgress();
    }
  }

  async applyAndReplace(stagingPath: string): Promise<DesktopToastRepairResult> {
    const setup = this.dependencies.setupInfo();
    if (setup.needsSetup || setup.current.engine !== 'pglite') {
      throw new Error('大字段修复仅适用于本机 PGLite 知识库。');
    }
    if (!stagingPath) throw new Error('缺少修复副本路径。');
    await this.dependencies.stopSidecar();
    const databasePath = setup.current.databasePath ?? setup.defaults.databasePath;
    this.dependencies.sendStartupProgress({
      visible: true,
      stage: 'database',
      title: '正在修复副本',
      message: '只处理没有对应知识页的搜索分块。知识页、Wiki、Facts 和原始资料不会删除。',
    });
    const applyCompleted = await this.runRepair([
      'repair', 'toast',
      '--staging', stagingPath,
      '--path', databasePath,
      '--apply',
      '--orphan-chunks',
      '--json',
    ]);
    const applied = parseJsonFromCli<{ status?: string; error?: string }>(
      applyCompleted.stdout,
      ['applied', 'dry-run', 'refused'],
      '大字段修复返回格式无效。',
    );
    if (applied.status === 'refused') {
      return { status: 'refused', stagingPath, error: applied.error ?? '副本修复被拒绝。' };
    }
    this.dependencies.sendStartupProgress({
      visible: true,
      stage: 'database',
      title: '正在替换当前数据库',
      message: '当前库会先改名留底，再用修复副本替换。失败会自动退回原库。',
    });
    const replacedCompleted = await this.runRepair([
      'repair', 'toast-replace',
      '--staging', stagingPath,
      '--path', databasePath,
      '--yes',
      '--json',
    ]);
    const replaced = parseJsonFromCli<{
      status?: string;
      stagingPath?: string;
      productionPath?: string;
      preservedPath?: string;
      pages?: number;
      chunks?: number;
      facts?: number;
    }>(replacedCompleted.stdout, ['replaced'], '数据库替换返回格式无效。');
    this.dependencies.log(`PGLite toast replace preserved=${replaced.preservedPath}`);
    return {
      status: 'replaced',
      stagingPath: replaced.stagingPath ?? stagingPath,
      preservedPath: replaced.preservedPath,
      pages: replaced.pages,
      chunks: replaced.chunks,
      facts: replaced.facts,
    };
  }

  private async runRepair(args: string[]): Promise<{ stdout: string }> {
    try {
      return await this.dependencies.runCliChecked(this.dependencies.runtime(), args);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      try {
        const recovered = parseJsonObject<Record<string, unknown>>(text, 'not-json');
        if (typeof recovered.status === 'string' && recovered.status !== 'error' && recovered.status !== 'refused') {
          this.dependencies.log(`PGLite toast CLI exited non-zero but returned ${recovered.status}; continuing.`);
          return { stdout: JSON.stringify(recovered) };
        }
      } catch {
        // keep original CLI error
      }
      throw error;
    }
  }
}
