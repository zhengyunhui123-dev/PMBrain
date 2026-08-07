/**
 * Curated PMBrain documentation index used to generate llms.txt and
 * llms-full.txt. Keep this list small: an AI should read the project map and
 * then follow only the call chain relevant to its task.
 */

export type DocEntry = {
  title: string;
  description: string;
  path: string;
  includeInFull?: boolean;
};

export type DocSection = {
  heading: string;
  optional?: boolean;
  entries: DocEntry[];
};

export const PROJECT = {
  name: "PMBrain",
  summary:
    "PMBrain is a local-first project and personal knowledge brain with multiple Sources, hybrid retrieval, Dream cycles, CLI, MCP, Admin Console, and a Windows desktop application.",
  repoUrl: "https://github.com/zhengyunhui123-dev/PMBrain",
  rawBaseUrl:
    process.env.LLMS_REPO_BASE ??
    "https://raw.githubusercontent.com/zhengyunhui123-dev/PMBrain/main",
};

export const SECTIONS: DocSection[] = [
  {
    heading: "Start here",
    entries: [
      {
        title: "AGENTS.md",
        description: "Non-negotiable working rules and protected-data boundaries.",
        path: "AGENTS.md",
      },
      {
        title: "CLAUDE.md",
        description: "Project map and task-specific code call chains.",
        path: "CLAUDE.md",
      },
      {
        title: "README.md",
        description: "Current product overview, setup, commands, and curated documentation links.",
        path: "README.md",
      },
      {
        title: "skills/RESOLVER.md",
        description: "Project skill dispatcher; consult only when the task matches a listed skill.",
        path: "skills/RESOLVER.md",
        includeInFull: false,
      },
    ],
  },
  {
    heading: "Architecture by topic",
    entries: [
      {
        title: "Deployment topologies",
        description: "Desktop/PGLite ownership, CLI, Postgres, and MCP deployment boundaries.",
        path: "docs/architecture/topologies.md",
      },
      {
        title: "Brains and Sources",
        description: "Source identity, slug isolation, resolution priority, and loading chain.",
        path: "docs/architecture/brains-and-sources.md",
      },
      {
        title: "Infrastructure layers",
        description: "UI-to-core-to-engine layering and the minimal-change boundary.",
        path: "docs/architecture/infra-layer.md",
      },
      {
        title: "Retrieval",
        description: "Current hybrid retrieval pipeline, modes, and acceptance criteria.",
        path: "docs/architecture/RETRIEVAL.md",
      },
      {
        title: "System of record",
        description: "Protected source data, database-only knowledge, and derived-data rules.",
        path: "docs/architecture/system-of-record.md",
      },
    ],
  },
  {
    heading: "Operations and evaluation",
    entries: [
      {
        title: "Windows desktop setup",
        description: "Desktop installation and first-run configuration.",
        path: "docs/desktop/安装与首次使用.md",
        includeInFull: false,
      },
      {
        title: "Docker Postgres setup",
        description: "Optional Docker Postgres first-run guide.",
        path: "docs/desktop/首次安装使用DockerPostgres.md",
        includeInFull: false,
      },
      {
        title: "ChatGPT MCP setup",
        description: "Connect ChatGPT to PMBrain through the supported MCP path.",
        path: "docs/mcp/CHATGPT.md",
        includeInFull: false,
      },
      {
        title: "Retrieval and Dream evaluation",
        description: "PMBrain quality metrics, evidence requirements, and test method.",
        path: "docs/eval/PMBrain检索与Dream质量评测规范.md",
        includeInFull: false,
      },
      {
        title: "PMBrain and upstream GBrain comparison",
        description: "Read only when comparing, pulling, or merging upstream retrieval or Dream logic.",
        path: "docs/eval/PMBrain与原版GBrain的检索和Dream功能对比.md",
        includeInFull: false,
      },
    ],
  },
];

export const INLINE_TIPS = [
  "Read `AGENTS.md`, then use the table in `CLAUDE.md` to follow one task-specific call chain.",
  "Do not read the entire `docs/architecture/` directory by default.",
  "Treat user Sources, Wiki, database-only knowledge, and vectors as protected data.",
  "Use `pmbrain --help` and targeted tests to verify current behavior instead of relying on upstream GBrain history.",
];

export const FULL_SIZE_BUDGET = 300_000;
