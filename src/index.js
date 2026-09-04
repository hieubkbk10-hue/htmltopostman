import fs from 'node:fs';
import path from 'node:path';
import { colors, parseArgs, askQuestion, normalizeBaseUrl, defaultOutputDir } from './utils.js';
import { parseApiDocHtml } from './parser.js';
import { loginAdmin } from './auth.js';
import { runLiveApiRequests } from './runner.js';
import { buildPostmanCollection } from './postman.js';

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return;
  }

  printBanner();

  // 1. Resolve HTML path
  let htmlPath = args.html;
  if (!htmlPath) {
    htmlPath = await askQuestion('Enter path to ApiDoc HTML file');
  }

  if (!htmlPath) {
    console.error(colors.red('❌ Error: HTML file path is required.'));
    process.exit(1);
  }

  // Handle surrounding quotes if passed in Windows cmd/pwsh
  htmlPath = htmlPath.replace(/^['"]|['"]$/g, '');

  if (!fs.existsSync(htmlPath)) {
    console.error(colors.red(`❌ Error: File not found at "${htmlPath}"`));
    process.exit(1);
  }

  // 2. Parse HTML file
  console.log(colors.cyan(`\n📖 Parsing ApiDoc HTML: ${htmlPath}...`));
  const { project, endpoints } = parseApiDocHtml(htmlPath);
  console.log(colors.green(`✅ Successfully parsed ${endpoints.length} endpoints from "${project.title}"`));

  // 3. Resolve Base URL & Live Mode
  let baseUrl = args.baseUrl;
  const noLive = args.noLive;

  if (!noLive && !baseUrl) {
    const entered = await askQuestion('Enter backend Base URL for live response capture (leave blank to skip live)');
    baseUrl = entered.trim();
  }

  let token = args.token || '';
  let liveResponses = new Map();

  if (!noLive && baseUrl) {
    baseUrl = normalizeBaseUrl(baseUrl);

    // 4. Authenticate or use provided token
    if (!token) {
      const authResult = await loginAdmin({
        baseUrl,
        email: args.email,
        password: args.password,
      });

      if (authResult.success) {
        token = authResult.token;
      } else {
        console.warn(colors.yellow(`\n⚠️  Authentication failed (HTTP ${authResult.status || 'ERR'}): ${authResult.error}`));
        console.log(colors.cyan('👉 Choose how to proceed:'));
        console.log('   [0] Use default credentials (admin@admin.com / admin)');
        console.log('   [1] Paste Bearer token directly');
        console.log('   [2] Re-enter custom email & password to retry login');
        console.log('   [3] Switch to offline mode (use doc examples, avoid 401 errors)\n');

        const choice = await askQuestion('Select option (0/1/2/3)', '0');

        if (choice === '0') {
          console.log(colors.cyan('🔄 Retrying with default credentials (admin@admin.com / admin)...'));
          const retryAuth = await loginAdmin({
            baseUrl,
            email: 'admin@admin.com',
            password: 'admin',
          });
          if (retryAuth.success) {
            token = retryAuth.token;
          }
        } else if (choice === '1') {
          const inputToken = await askQuestion('Paste your Bearer token');
          if (inputToken) {
            token = inputToken.replace(/^Bearer\s+/i, '').trim();
            console.log(colors.green('🔑 Bearer token applied.'));
          }
        } else if (choice === '2') {
          const newEmail = await askQuestion('Enter email', 'admin@admin.com');
          const newPass = await askQuestion('Enter password', 'admin');
          if (newEmail && newPass) {
            const retryAuth = await loginAdmin({
              baseUrl,
              email: newEmail,
              password: newPass,
            });
            if (retryAuth.success) {
              token = retryAuth.token;
            }
          }
        }
      }
    } else {
      token = token.replace(/^Bearer\s+/i, '').trim();
      console.log(colors.green('🔑 Using Bearer token provided via command-line.'));
    }

    if (token) {
      // 5. Run Live API Calls with valid token
      liveResponses = await runLiveApiRequests({
        baseUrl,
        token,
        endpoints,
        patchLimit: args.patchLimit,
      });
    } else {
      console.log(colors.yellow('\n⚡ No valid token available. Generating Postman collection in offline mode to preserve documentation examples.'));
    }
  } else {
    console.log(colors.yellow('⚡ Offline mode: skipping live API requests. Generating Postman collection with doc examples.'));
  }

  // 6. Build Postman Collection
  console.log(colors.cyan('📦 Generating Postman Collection v2.1.0...'));
  const collection = buildPostmanCollection({
    project,
    endpoints,
    baseUrl: baseUrl || '{{base_url}}',
    token,
    liveResponses,
  });

  // 7. Save Collection to E:\stondy\htmltpostman\output\ by default
  const timestamp = getFormattedTimestamp();
  const apiName = (project.title || 'apiato').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const defaultFileName = `${timestamp}_${apiName}.postman_collection.json`;

  let outputPath = args.output;
  if (!outputPath) {
    cleanOutputDirectory(defaultOutputDir);
    outputPath = path.join(defaultOutputDir, defaultFileName);
  } else {
    outputPath = path.resolve(process.cwd(), outputPath);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(collection, null, 2), 'utf8');

  console.log(colors.bold(colors.green(`\n🎉 Success! Postman collection generated at:`)));
  console.log(colors.bold(`👉 ${outputPath}`));
  console.log(colors.gray(`   • File Name:         ${path.basename(outputPath)}`));
  console.log(colors.gray(`   • Total Endpoints:   ${endpoints.length}`));
  console.log(colors.gray(`   • Total Folders:     ${collection.item.length}`));
  console.log(colors.gray(`   • Live Responses:    ${liveResponses.size}\n`));
}

function cleanOutputDirectory(dir) {
  if (!fs.existsSync(dir)) return;
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isFile()) {
        fs.unlinkSync(fullPath);
      }
    }
  } catch {
    // ignore
  }
}

function getFormattedTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = pad(now.getDate());
  const month = pad(now.getMonth() + 1);
  const year = now.getFullYear();
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  const seconds = pad(now.getSeconds());
  return `${day}-${month}-${year}_${hours}-${minutes}-${seconds}`;
}

function printBanner() {
  console.log(colors.bold(colors.magenta(`
=====================================================
  htmltpostman - ApiDoc HTML to Postman Collection
  with Live Response Capture & Dependency ID Crawler
=====================================================`)));
}

function printHelp() {
  printBanner();
  console.log(`
Usage:
  htmltpostman [options]

Options:
  --html <path>         Path to ApiDoc HTML documentation file
  --base-url <url>, -u  Target backend base URL (e.g. https://api.example.com)
  --token <token>, -t   Bearer token for authenticated API requests
  --email <email>       Admin login email (default: admin@admin.com)
  --password <pass>     Admin login password (default: admin)
  --output <path>, -o   Output JSON collection file path (defaults to ./output/)
  --patch-limit <num>   Maximum PATCH requests to invoke (default: 20)
  --no-live             Offline mode: skip live API requests and use doc examples
  --help, -h            Show this help message

Examples:
  # Interactive mode
  htmltpostman

  # Using Bearer token directly
  htmltpostman --html "./docs.html" --base-url "https://api.example.com" --token "eyJhbG..."

  # Fast offline mode (output goes to ./output/)
  htmltpostman --html "./docs.html" --no-live
`);
}

export {
  parseApiDocHtml,
  loginAdmin,
  runLiveApiRequests,
  buildPostmanCollection,
};
