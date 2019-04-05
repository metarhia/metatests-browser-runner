#!/usr/bin/env node
'use strict';

const yargs = require('yargs');
const common = require('@metarhia/common');
const karma = require('karma');
const yaml = require('yaml').default;
const path = require('path');
const fs = require('fs');

const DEFAULT_EXIT_TIMEOUT = 5;

const browserLaunchers = {
  Chrome: 'karma-chrome-launcher',
  ChromeHeadless: 'karma-chrome-launcher',
  Firefox: 'karma-firefox-launcher',
  IE: 'karma-ie-launcher',
  Opera: 'karma-opera-launcher',
  Safari: 'karma-safari-launcher',
};

const logLevels = {
  quiet: [0, 'LOG_DISABLE', 'none'],
  default: [1, 'LOG_ERROR', 'errors-only'],
  error: [1, 'LOG_ERROR', 'errors-only'],
  warn: [2, 'LOG_WARN', 'minimal'],
  info: [3, 'LOG_INFO', 'normal'],
  debug: [4, 'LOG_DEBUG', 'verbose'],
};

const args = yargs
  .usage('$0 [options] file.js [file.js...]')
  .parserConfiguration({
    'duplicate-arguments-array': false,
  })
  .option('exclude', {
    array: true,
    type: 'string',
    describe: 'Exclude tests patterns',
  })
  .option('reporter', {
    type: 'string',
    describe: 'Reporter name',
  })
  .option('log-level', {
    choices: Object.keys(logLevels),
    type: 'string',
    describe: 'Log level',
  })
  .option('run-todo', {
    type: 'boolean',
    describe: 'Run todo tests',
  })
  .option('exit-timeout', {
    type: 'number',
    describe: 'Seconds to wait after tests finished',
  })
  .option('config', {
    alias: 'c',
    type: 'string',
    describe: 'Path to config file',
  })
  .option('browsers', {
    array: true,
    choices: Object.keys(browserLaunchers),
    type: 'string',
    describe: 'Browsers to run',
  })
  .option('browser-port', {
    alias: 'p',
    type: 'number',
    describe: 'Browser port',
  })
  .option('karma-config', {
    type: 'string',
    describe: 'Karma config file',
  })
  .option('save-adapter', {
    type: 'string',
    describe: 'Save adapter processed by webpack to a file',
  })
  .option('unresolved-module', {
    choices: ['ignore', 'fail'],
    type: 'string',
    describe: 'Unresolved modules handling strategy',
  })
  .argv;

const ignoredNodePackages = [
  'child_process', 'cluster', 'dgram',
  'fs', 'module', 'readline', 'repl',
];

const isLogAtLeast = (level1, level2) => {
  if (!logLevels[level1]) level1 = 'default';
  if (!logLevels[level2]) level2 = 'default';
  return logLevels[level1][0] >= logLevels[level2][0];
};

const merge = (arr1 = [], arr2 = []) => common.merge(arr1, arr2);

const exclude = (files, filterArr) =>
  filterArr
    .map(path =>
      path
        .replace('.', '\\.')
        .replace('*', '.+')
        .replace('?', '.')
    )
    .map(path => new RegExp(path))
    .reduce((files, regexp) => files.filter(file => !regexp.test(file)), files);

const parseFile = file => {
  const data = fs.readFileSync(path.resolve(file), 'utf8');
  switch (common.fileExt(file)) {
    case 'json':
      return JSON.parse(data);
    case 'yml':
    case 'yaml':
      return yaml.parse(data);
    default:
      return {};
  }
};

const loadFiles = files => {
  const result = [];
  files
    .map(file => {
      if (fs.existsSync(file + '.js')) {
        return file + '.js';
      } else if (fs.existsSync(file)) {
        return file;
      } else {
        console.error('File does not exist:', file);
        process.exit(1);
        return '';
      }
    })
    .forEach(file => {
      if (fs.statSync(file).isDirectory()) {
        const subfiles = fs.readdirSync(file).map(f => path.join(file, f));
        result.push(...loadFiles(subfiles));
      } else if (common.fileExt(file) === 'js') {
        result.push(file);
      }
    });
  return result;
};

const setKarmaBrowsers = (config, ...browsers) => {
  if (!config.plugins) config.plugins = [];
  if (!config.browsers) config.browsers = [];

  browsers.forEach(browser => {
    const launcher = browserLaunchers[browser];
    if (!launcher) {
      console.error(
        'Metatests library does not support such browser:',
        browser
      );
      process.exit(1);
    }
    config.browsers.push(browser);
    if (!config.plugins.includes(launcher)) config.plugins.push(launcher);
  });
};

const setKarmaLogLevel = (config, logLevel) => {
  if (!logLevels[logLevel]) logLevel = 'default';

  if (!config.webpackMiddleware) config.webpackMiddleware = {};
  config.logLevel = karma.constants[logLevels[logLevel][1]];
  config.webpackMiddleware.stats = logLevels[logLevel][2];
};

const removeNodePackages = config => {
  if (!config.webpack) config.webpack = {};
  if (!config.webpack.node) config.webpack.node = {};
  ignoredNodePackages.forEach(lib => {
    config.webpack.node[lib] = 'empty';
  });
};

const getReporter = () => {
  const browsers = [];
  const reporter = function(base) {
    base(this);
    this.onBrowserLog = (browser, log) => {
      if (typeof log !== 'string') log = JSON.stringify(log, null, 2);
      else log = log.slice(1, log.length - 1);
      if (!browsers.includes(browser)) {
        browsers.push(browser);
        console.log(`\n${browser}:`);
      }
      console.log(log);
    };

    this.onBrowserError = (browser, error) => {
      if (typeof error !== 'string') error = JSON.stringify(error, null, 2);
      else error = error.slice(1, error.length - 1);
      if (!browsers.includes(browser)) {
        browsers.push(browser);
        console.log(`\n${browser}:`);
      }
      console.error(error);
    };
  };

  reporter.$inject = ['baseReporterDecorator'];
  return reporter;
};

const getPreprocesor = adapterFile => function() {
  return (content, file, done) =>
    fs.writeFile(adapterFile, content, err =>
      done(err, content));
};

const getBrowserConfig = conf => {
  const buildDir = path.resolve('build');
  const buildAdapter = path.join(buildDir, 'adapter.js');
  const buildLoader = path.join(buildDir, 'loader.js');

  const config = {
    preprocessors: {},
    files: [],
    plugins: [
      'karma-webpack',
      { 'reporter:meta': ['type', getReporter()] },
    ],
    webpack: {
      optimization: { minimize: false },
      module: { rules: [{
        test: /tap-mocha-reporter\/index.js/,
        loader: buildLoader,
      }] },
    },
    reporters: ['meta'],
    basePath: process.env.PWD,
    port: conf.browser.port,
    autoWatch: false,
    singleRun: true,
    concurrency: 1,
  };

  config.files.push(buildAdapter);
  config.preprocessors[buildAdapter] = ['webpack'];
  if (conf.saveAdapter) {
    config.plugins.push({
      'preprocessor:meta': ['factory', getPreprocesor(conf.saveAdapter)],
    });
    config.preprocessors[buildAdapter].push('meta');
  }

  if (conf.unresolvedModule === 'ignore') removeNodePackages(config);
  setKarmaBrowsers(config, ...conf.browser.browsers);
  setKarmaLogLevel(config, conf.logLevel);
  return config;
};

const getConfig = () => {
  const config = args.config ? parseFile(args.config) : {};

  config.exclude = merge(config.exclude, args.exclude);
  config.files = loadFiles(merge(config.files, args._));
  config.files = exclude(config.files, config.exclude);

  config.logLevel = args.logLevel || config.logLevel || 'default';
  config.reporter = args.reporter || config.reporter || 'default';
  config.runTodo = args.runTodo || config.runTodo;
  config.exitTimeout =
    args.exitTimeout || config.exitTimeout || DEFAULT_EXIT_TIMEOUT;

  config.saveAdapter = args.saveAdapter;
  config.unresolvedModule =
    args.unresolvedModule || config.unresolvedModule || 'ignore';

  config.browser = config.browser || {};
  config.browser.browsers = merge(config.browser.browsers, args.browsers);
  config.browser.port = args.browserPort || config.browser.port;
  config.browser = getBrowserConfig(config);
  if (args.karmaConfig) {
    config.browser = karma.parseConfig(args.karmaConfig, config.browser);
  }

  return config;
};

const getBuildFiles = config => {
  let adapter = `
__karma__.start=()=>{};
require('babel-polyfill');
process.versions.node = '';
process.stdout = {};
process.stdout.write = (() => {
  let stdout = '';
  return str => {
    stdout += str;
    let i = stdout.indexOf('\\n');
    while(i !== -1) {
      console.log(stdout.slice(0, i));
      stdout = stdout.slice(i + 1);
      i = stdout.indexOf('\\n');
    }
  };
})();
const metatests = require('metatests');
metatests.runner.instance.on('finish', () => {
  console.log(
    'Tests finished. Waiting for unfinished tests after end...'
  );
  setTimeout(() => {
    __karma__.info({ total: 1 });
    __karma__.result({ success: !metatests.runner.instance.hasFailures });
    __karma__.complete();
  }, ${config.exitTimeout * 1000});
});\n`;

  if (config.logLevel === 'quiet') {
    adapter += 'metatests.runner.instance.removeReporter();\n';
  } else if (config.reporter.startsWith('tap')) {
    let reporterType = config.reporter.split('-')[1];
    if (reporterType) reporterType = `'${reporterType}'`;
    adapter +=
`metatests.runner.instance.setReporter(
  new metatests.reporters.TapReporter({ type: ${reporterType} })
);\n`;
  } else if (config.reporter === 'concise') {
    adapter +=
`metatests.runner.instance.setReporter(
  new metatests.reporters.ConciseReporter()
);\n`;
  }

  if (config.runTodo) {
    adapter += `require('metatests').runner.instance.runTodo();\n`;
  }

  adapter += config.files.map(file => `require('../${file}');`).join('\n');

  const loader = `module.exports = source =>
  source.slice(20, source.indexOf('function avail'));`;
  return { adapter, loader };
};

const runBrowser = (config, cb) => {
  if (!config.browser.browsers.length) {
    console.error('No browser environments specified');
    cb(1);
  }

  const { adapter, loader } = getBuildFiles(config);

  const buildDir = path.resolve('build');
  const buildAdapter = path.join(buildDir, 'adapter.js');
  const buildLoader = path.join(buildDir, 'loader.js');

  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir);
  fs.writeFileSync(buildAdapter, adapter);
  fs.writeFileSync(buildLoader, loader);

  if (isLogAtLeast(config.logLevel, 'info')) {
    console.log(`Adapter file:\n${adapter}`);
  }

  const server = new karma.Server(config.browser, code => {
    fs.unlinkSync(buildAdapter);
    fs.unlinkSync(buildLoader);
    fs.rmdirSync(buildDir);
    cb(code);
  });
  server.start();
};

const config = getConfig();

const onExit = code => {
  if (isLogAtLeast(config.logLevel, 'default')) {
    console.log('Metatests finished with code', code);
  }
  process.exit(code);
};

if (isLogAtLeast(config.logLevel, 'debug')) {
  console.log(`Metatests final config:\n${JSON.stringify(config, null, 2)}\n`);
}
if (!config.files.length) {
  console.error('No test files were specified\n');
  yargs.showHelp();
  onExit(1);
}

runBrowser(config, onExit);
