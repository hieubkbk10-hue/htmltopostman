import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultOutputDir = path.join(cliRoot, 'output');

export const colors = {
  reset: (text) => `\x1b[0m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
  dim: (text) => `\x1b[2m${text}\x1b[0m`,
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  cyan: (text) => `\x1b[36m${text}\x1b[0m`,
  blue: (text) => `\x1b[34m${text}\x1b[0m`,
  magenta: (text) => `\x1b[35m${text}\x1b[0m`,
  gray: (text) => `\x1b[90m${text}\x1b[0m`,
};

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    html: '',
    baseUrl: '',
    token: '',
    email: 'admin@admin.com',
    password: 'admin',
    output: '',
    patchLimit: 20,
    noLive: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '--no-live') {
      args.noLive = true;
    } else if (arg === '--html' && i + 1 < argv.length) {
      args.html = argv[++i];
    } else if (arg.startsWith('--html=')) {
      args.html = arg.split('=')[1];
    } else if ((arg === '--base-url' || arg === '-u') && i + 1 < argv.length) {
      args.baseUrl = argv[++i];
    } else if (arg.startsWith('--base-url=')) {
      args.baseUrl = arg.split('=')[1];
    } else if ((arg === '--token' || arg === '-t' || arg === '--bearer') && i + 1 < argv.length) {
      args.token = argv[++i];
    } else if (arg.startsWith('--token=') || arg.startsWith('--bearer=')) {
      args.token = arg.split('=')[1];
    } else if (arg === '--email' && i + 1 < argv.length) {
      args.email = argv[++i];
    } else if (arg.startsWith('--email=')) {
      args.email = arg.split('=')[1];
    } else if (arg === '--password' && i + 1 < argv.length) {
      args.password = argv[++i];
    } else if (arg.startsWith('--password=')) {
      args.password = arg.split('=')[1];
    } else if ((arg === '--output' || arg === '-o') && i + 1 < argv.length) {
      args.output = argv[++i];
    } else if (arg.startsWith('--output=')) {
      args.output = arg.split('=')[1];
    } else if (arg === '--patch-limit' && i + 1 < argv.length) {
      args.patchLimit = parseInt(argv[++i], 10) || 20;
    } else if (arg.startsWith('--patch-limit=')) {
      args.patchLimit = parseInt(arg.split('=')[1], 10) || 20;
    } else if (!args.html && !arg.startsWith('-')) {
      args.html = arg;
    }
  }

  return args;
}

export async function askQuestion(promptText, defaultValue = '') {
  const rl = readline.createInterface({ input, output });
  try {
    const hint = defaultValue ? ` [default: ${defaultValue}]` : '';
    const answer = await rl.question(colors.cyan(`? ${promptText}${hint}: `));
    const trimmed = answer.trim();
    return trimmed || defaultValue;
  } finally {
    rl.close();
  }
}

export function normalizeBaseUrl(url) {
  if (!url) return '';
  let trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  return trimmed.replace(/\/+$/, '');
}

export function cleanHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export function safeJsonParse(str, fallback = null) {
  if (!str || typeof str !== 'string') return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
