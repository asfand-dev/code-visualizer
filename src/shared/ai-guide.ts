/**
 * A short guide to working with Claude Code, and what code-visualizer adds to it: the commands and shortcuts
 * worth knowing, habits that give better results, ready-to-save templates for a skill, command, subagent, hook
 * and CLAUDE.md, and the tools code-visualizer gives Claude. Static text, so it is the same in the report and in
 * `serve`, and costs nothing to compute.
 */
import type { ProjectInfo } from './types.js';

export interface GuideEntry {
  name: string;
  text: string;
}

export interface GuideSection {
  id: string;
  title: string;
  /** One line saying why this section is worth reading. */
  intro: string;
  entries: GuideEntry[];
}

export const CLAUDE_GUIDE: GuideSection[] = [
  {
    id: 'slash',
    title: 'Slash commands',
    intro: 'Type / in Claude Code for the full list, yours included.',
    entries: [
      { name: '/init', text: 'Reads the project and writes a CLAUDE.md for it. The best first step in a new repository.' },
      { name: '/memory', text: 'Open the memory files (CLAUDE.md) to edit them.' },
      { name: '/clear', text: 'Start a fresh conversation. Do it between unrelated tasks: old context makes answers worse and costs more.' },
      { name: '/compact', text: 'Summarise the conversation to free up context. Say what to keep: /compact keep the API decisions.' },
      { name: '/context', text: 'Show what fills the context window: memory, tools, messages.' },
      { name: '/model', text: 'Switch model: a faster one for simple edits, a stronger one for hard problems.' },
      { name: '/resume', text: 'Pick up an earlier conversation.' },
      { name: '/rewind', text: 'Go back to an earlier point in the conversation, and restore the code from then.' },
      { name: '/agents', text: 'Create and manage subagents.' },
      { name: '/mcp', text: 'See the MCP servers and their status, and sign in to those that need it.' },
      { name: '/hooks', text: 'Set up commands that run automatically before or after Claude acts.' },
      { name: '/permissions', text: 'See and change what Claude may do without asking.' },
      { name: '/review', text: 'Review a pull request.' },
      { name: '/add-dir', text: 'Let Claude work in another folder too.' },
      { name: '/cost', text: 'Show what the session has cost so far.' },
      { name: '/doctor', text: 'Check the installation and the configuration.' },
    ],
  },
  {
    id: 'keys',
    title: 'Keys and shortcuts',
    intro: 'Small things that save a lot of typing.',
    entries: [
      { name: 'Shift+Tab', text: 'Cycle the mode: ask before each edit, accept edits, and plan mode, where Claude only reads and proposes.' },
      { name: 'Esc', text: 'Stop Claude while it works. The context stays, so you can redirect it.' },
      { name: 'Esc Esc', text: 'Go back and edit an earlier message.' },
      { name: '@path', text: 'Mention a file or folder so Claude reads it: “explain @src/auth”.' },
      { name: '!command', text: 'Run a shell command yourself and add its output to the conversation.' },
      { name: 'Ctrl+C', text: 'Cancel what is typed or running. Twice to exit.' },
    ],
  },
  {
    id: 'cli',
    title: 'From the terminal',
    intro: 'For scripts, CI and quick questions.',
    entries: [
      { name: 'claude -p "question"', text: 'Answer once and print the result: use it in scripts and pipes.' },
      { name: 'claude -c', text: 'Continue the most recent conversation in this folder.' },
      { name: 'claude --resume', text: 'Choose an earlier conversation to continue.' },
      { name: 'claude --permission-mode plan', text: 'Start in plan mode: read-only until you approve the plan.' },
      { name: 'claude --model <name>', text: 'Pick the model for this session.' },
      { name: 'claude --add-dir <path>', text: 'Give Claude access to another folder.' },
      { name: 'claude mcp add <name> -- <command>', text: 'Register an MCP server for this project.' },
    ],
  },
  {
    id: 'habits',
    title: 'Habits that give better results',
    intro: 'What people who get good results with Claude do differently.',
    entries: [
      { name: 'Explore, plan, then code', text: 'Ask Claude to read and explain first, then to plan (Shift+Tab twice), and only then to edit. Changing a plan is cheaper than changing code.' },
      { name: 'Give it a way to check itself', text: 'Put the test, lint and type-check commands in CLAUDE.md and ask for them to be run after every change. Claude fixes what it can see failing.' },
      { name: 'Be specific', text: 'Name the file, the function and the behaviour you expect, and point at an existing example to copy: “add an endpoint like @src/routes/users.ts”.' },
      { name: 'One task per conversation', text: '/clear between tasks. A long conversation about three things serves none of them well.' },
      { name: 'Let subagents research', text: 'A subagent reads many files in its own context and returns a summary, so your conversation stays small.' },
      { name: 'Turn repeated prompts into commands', text: 'When you type the same instructions twice, save them as a slash command or a skill.' },
      { name: 'Review before you commit', text: 'Read the diff (git diff) and run the tests yourself. Claude is fast, not infallible.' },
    ],
  },
];

/** What code-visualizer gives Claude when it is registered as an MCP server (`code-visualizer agents init --write`). */
export const CODE_VISUALIZER_TOOLS: GuideEntry[] = [
  { name: 'project_overview', text: 'Start here in an unfamiliar repository: stack, entry points, core modules, the test, lint and type-check commands, and the architecture rules.' },
  { name: 'impact', text: 'Before editing: what a change to a file, symbol, folder or route affects, with exact call sites, the tests to run, code owners and a risk level.' },
  { name: 'tests_for', text: 'After editing: the tests that exercise the changed code, and the exact command that runs only those.' },
  { name: 'review_changes', text: 'Your current work: changed files and symbols, what they impact, tests to run, risk, reviewers, and architecture changes.' },
  { name: 'find_symbol', text: 'Where a function, component, class or type is defined and used. More precise than grep: it tells definitions from uses.' },
  { name: 'find_similar', text: 'Before writing a helper: existing functions that already do the same thing, even when renamed.' },
  { name: 'check_architecture', text: 'Before adding an import: is it allowed under the architecture rules, and would it create a cycle?' },
  { name: 'route', text: 'Which handler serves a URL, its middleware, who calls it and which tests reach it.' },
  { name: 'who', text: 'Who owns and knows a file, folder or symbol: owners, recent authors, bus factor. Use it to pick reviewers.' },
];

/** Prompts that make Claude use those tools well. */
export const CODE_VISUALIZER_PROMPTS: string[] = [
  'Before changing src/payments/charge.ts, check its impact and tell me which tests to run.',
  'Review my current changes and list anything the tests do not cover.',
  'Is there already a helper that does this? Check before writing a new one.',
  'Who should review a change to src/auth?',
];

/* -------------------------------- Templates -------------------------------- */

export interface GuideTemplate {
  id: 'claude-md' | 'skill' | 'command' | 'agent' | 'hook';
  title: string;
  /** Where to save it. */
  path: string;
  /** What it is for, and how to use it once saved. */
  text: string;
  content: string;
}

const RUN_PREFIX: Record<string, string> = { npm: 'npm run', pnpm: 'pnpm', yarn: 'yarn', bun: 'bun run' };
const COMMAND_SCRIPTS: [script: string, label: string][] = [
  ['dev', 'Start the dev server'],
  ['build', 'Build'],
  ['test', 'Run the tests'],
  ['lint', 'Lint'],
  ['typecheck', 'Check the types'],
  ['format', 'Format'],
];

/** The package.json scripts a CLAUDE.md should list, as ready-to-run commands. */
export function projectCommands(project: Pick<ProjectInfo, 'packageManager' | 'scripts'>): string[] {
  const manager = project.packageManager?.split('@')[0] ?? 'npm';
  const prefix = RUN_PREFIX[manager] ?? 'npm run';
  return COMMAND_SCRIPTS.filter(([script]) => project.scripts?.[script]).map(([script, label]) => `- ${label}: \`${script === 'test' && manager === 'npm' ? 'npm test' : `${prefix} ${script}`}\``);
}

export function guideTemplates(project: Pick<ProjectInfo, 'name' | 'description' | 'packageManager' | 'scripts'>): GuideTemplate[] {
  const commands = projectCommands(project);
  const claudeMd = [
    `# ${project.name}`,
    '',
    project.description ?? 'What this project does, in one or two sentences.',
    '',
    '## Commands',
    '',
    ...(commands.length ? commands : ['- Run the tests: `…`', '- Build: `…`']),
    '',
    '## How the code is organised',
    '',
    '- `src/…`: what lives here',
    '',
    '## Conventions',
    '',
    '- Follow the patterns of the neighbouring files.',
    '- Add or update tests with every change.',
    '',
    '## Do not',
    '',
    '- Do not edit generated files in `dist/`.',
    '',
  ].join('\n');

  return [
    {
      id: 'claude-md',
      title: 'CLAUDE.md',
      path: 'CLAUDE.md',
      text: 'Standing instructions Claude reads at the start of every session. Keep it short: only what Claude cannot work out from the code. /init writes a first version for you.',
      content: claudeMd,
    },
    {
      id: 'skill',
      title: 'Skill',
      path: '.claude/skills/<name>/SKILL.md',
      text: 'Know-how Claude loads when a task matches the description. Everything under the description is read only when it is used, so skills are cheap to keep around.',
      content: [
        '---',
        'name: release-notes',
        'description: Write release notes from the commits since the last tag. Use when asked to prepare a release or a changelog.',
        '---',
        '',
        '# Release notes',
        '',
        '1. Find the last tag with `git describe --tags --abbrev=0`.',
        '2. Read the commits since it with `git log <tag>..HEAD --oneline`.',
        '3. Group them into Features, Fixes and Other; skip merge commits.',
        '4. Write the notes in the style of the existing CHANGELOG.md.',
        '',
      ].join('\n'),
    },
    {
      id: 'command',
      title: 'Slash command',
      path: '.claude/commands/<name>.md',
      text: 'A prompt you run by typing its name: /fix-issue 123. $ARGUMENTS is replaced by what you type after the name.',
      content: ['---', 'description: Fix a GitHub issue', 'argument-hint: [issue number]', '---', '', 'Fix GitHub issue $ARGUMENTS.', '', '1. Read the issue with `gh issue view $ARGUMENTS`.', '2. Find the code it is about and explain the cause before changing anything.', '3. Fix it and add a test that fails without the fix.', '4. Run the tests.', ''].join('\n'),
    },
    {
      id: 'agent',
      title: 'Subagent',
      path: '.claude/agents/<name>.md',
      text: 'A specialist with its own instructions and context window. Claude hands matching work to it, or you ask for it by name. Limit its tools to what it needs.',
      content: ['---', 'name: code-reviewer', 'description: Reviews code changes for bugs, missing tests and unclear naming. Use after finishing a change.', 'tools: Read, Grep, Glob, Bash(git diff:*)', '---', '', 'You review code. Read the diff with `git diff`, then report:', '', '1. Bugs and edge cases that are not handled.', '2. Changes that no test covers.', '3. Names or structure that will confuse the next reader.', '', 'Be specific: name the file and line. Do not rewrite the code.', ''].join('\n'),
    },
    {
      id: 'hook',
      title: 'Hook',
      path: '.claude/settings.json',
      text: 'A command that runs by itself, every time, at a fixed point: here, formatting each file after Claude edits it. Unlike an instruction, a hook cannot be forgotten.',
      content: JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: "jq -r '.tool_input.file_path' | xargs npx prettier --write" }] }] } }, null, 2) + '\n',
    },
  ];
}
