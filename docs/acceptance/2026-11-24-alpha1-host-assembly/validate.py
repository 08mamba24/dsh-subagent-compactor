"""Validate the patrol fix for a host that cannot be assembled (PR #13).

Runs the watcher contracts, the stock suites on rc.1--rc.5 and alpha.2, the
real watcher prepare/run path for the three discovered Harness candidates,
the watcher contracts once more against the classifier and CLI that the
review rejected, and thirteen mutation checks that each turn the regressions
of its change red. Everything runs with isolated HOME, TMPDIR, npm cache and
loopback synthetic models.

Requires Homebrew Node 24.22.3, the documented existing rc.1 and rc.5 npm
trees, public npm access, and a clean checkout of the commit under test.
"""
from pathlib import Path
import datetime
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time

evidence = Path(__file__).resolve().parent
source = evidence.parents[2]
node = Path('/opt/homebrew/opt/node@24/bin/node')
npm = node.parent / 'npm'
git = '/usr/bin/git'
CANDIDATES = [
    ('alpha2', '0.2.3-alpha.2', 'dsh-v0.2.3-alpha.2', '4b399c39a6d1479cd84ca591b4d7c88e24d38a96'),
    ('alpha1', '0.2.3-alpha.1', 'dsh-v0.2.3-alpha.1', 'd98f5d68519215da48f3002da2cb9c9d2068d81d'),
    ('rc5', '0.2.2-rc.5', 'dsh-v0.2.2-rc.5', '9c2670d3bce5275e0d1610272958121af87787bb'),
]
HOST_PROBE = 'DSH_HOST_ASSEMBLY_FAILED mount @deepseek-ai/dsh-llm: Error: cannot get property "undefined" without inject'
CLEAN = ['fail', 'cancelled', 'skipped', 'todo']
SUPERSEDED = 'ab8c63f3eb65b0cd4c60e36460d7ec8d1314ea8d'  # the classifier and CLI that the review rejected
LEAK_PROBE = 'DSH_FIXTURE_LISTENER_LEAK {} fixture HTTP listener(s) outlived their test'
WRAPPED_PROBE = 'Error [HostAssemblyError]: the stock host could not be assembled: mount @deepseek-ai/dsh-llm'
scratch = Path(tempfile.mkdtemp(prefix='dsh-alpha1-patrol-'))
home = scratch / 'home'
home.mkdir()
environment = {'HOME': str(home), 'TMPDIR': str(scratch), 'PATH': f'{node.parent}:/usr/bin:/bin', 'LANG': 'en_US.UTF-8', 'NPM_CONFIG_CACHE': str(scratch / 'npm-cache')}


def git_output(*args):
    return subprocess.check_output([git, *args], cwd=source, text=True).strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def counts(text):
    return {key: int(re.search(rf'^ℹ {key} (\d+)$', text, re.M).group(1)) for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']}


pkg = json.loads((source / 'package.json').read_text())
tracked = ['index.js', 'package.json', 'package-lock.json', '.github/workflows/ci.yml', '.github/workflows/upstream-compat.yml']
tracked += [str(p.relative_to(source)) for directory in ['test', 'scripts'] for p in (source / directory).rglob('*') if p.is_file() and 'node_modules' not in p.parts]
plugin_sha = git_output('rev-parse', 'HEAD')
assert not git_output('status', '--porcelain', '--', *tracked), 'tested files differ from HEAD'
record = {
    'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'pluginSha': plugin_sha,
    'node': str(node),
    'nodeSha256': digest(node),
    'scope': 'local stock module suites and the real watcher prepare/run path; synthetic loopback models; no Desktop GUI or daily installation',
    'candidates': [{'label': label, 'version': version, 'tag': tag, 'commit': commit} for label, version, tag, commit in CANDIDATES],
    'testedFileSha256': {rel: digest(source / rel) for rel in sorted(tracked)},
    'runs': [],
    'patrol': [],
    'superseded': [],
    'mutations': [],
}


def save():
    (evidence / 'validation.json').write_text(json.dumps(record, indent=2) + '\n')


def run(label, command, cwd, timeout):
    log = evidence / f'{label}.log'
    item = {'label': label, 'command': [str(part) for part in command], 'cwd': str(cwd), 'log': log.name}
    started = time.monotonic()
    with log.open('w') as output:
        output.write(json.dumps(item) + '\n')
        output.flush()
        process = subprocess.Popen(command, cwd=cwd, env=environment, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            code = 'TIMEOUT'
    item.update(exitCode=code, elapsedSeconds=round(time.monotonic() - started, 1), logSha256=digest(log))
    return item


def text_of(item):
    return (evidence / item['log']).read_text(errors='replace')


def suite(label, command, cwd, expected, timeout=120):
    item = run(label, command, cwd, timeout)
    item['counts'] = counts(text_of(item))
    item['expected'] = f'{expected}/{expected}, nothing failed, cancelled, skipped or TODO'
    record['runs'].append(item)
    save()
    print(label, item['exitCode'], item['counts'], item['elapsedSeconds'], flush=True)
    assert item['exitCode'] == 0, f'{label}: see {item["log"]}'
    c = item['counts']
    assert c['tests'] == c['pass'] == expected and all(c[k] == 0 for k in CLEAN), item
    return item


def step(label, command, cwd, timeout):
    item = run(label, command, cwd, timeout)
    record['runs'].append(item)
    save()
    assert item['exitCode'] == 0, item
    return item


def leftovers():
    prefixes = ('dsh-', 'subagent-compactor-', 'compactor-optional-auth-', 'preset-')
    return sorted(p.name for p in scratch.iterdir() if p.name.startswith(prefixes))


def swap(root, rel, old, new):
    path = root / rel
    text = path.read_text()
    assert text.count(old) == 1, (rel, old[:50], text.count(old))
    path.write_text(text.replace(old, new))


def restore(revision, *rels):
    """Put files back as they were at `revision`."""
    def change(root):
        for rel in rels:
            (root / rel).write_bytes(subprocess.check_output([git, 'show', f'{revision}:{rel}'], cwd=source))
    return change


def mutated(label, change, modules, command_of, expect, check, group='mutations'):
    root = scratch / label
    shutil.copytree(source, root, ignore=shutil.ignore_patterns('node_modules', '.git', 'docs'))
    change(root)
    os.symlink(modules, root / 'node_modules')
    item = run(label, command_of(root), root, 120)
    item['counts'] = counts(text_of(item))
    item['expected'] = expect
    record[group].append(item)
    save()
    print(label, item['exitCode'], item['counts'], item['elapsedSeconds'], flush=True)
    assert item['exitCode'] == 1 and item['elapsedSeconds'] < 60, item
    check(item, text_of(item))


def through_runner(modules, *extra):
    return lambda root: [node, root / 'scripts/test-installed-runtime.mjs', '--modules', modules, *extra]


def watcher(root):
    return [node, '--test', '--test-reporter=spec', 'test/upstream-compat-watch.test.mjs']
CAPACITY_CLEANUP_BEFORE_BOOT = '\t// Registered before boot: a host that fails to assemble still releases the listener and the scratch directory.\n\tt.after(async () => {\n\t\tjournal?.dispose(); lifecycle?.dispose();\n\t\tawait ctx?.fiber.dispose(); await fake.close();\n\t\trmSync(storageRoot, { recursive: true, force: true });\n\t});\n\tctx = await boot(await fake.start(), storageRoot, { plugin: true, auto: false, ...options });\n\tjournal = sessionJournal(ctx);\n\tlifecycle = activationJournal(ctx);\n'
CAPACITY_CLEANUP_AFTER_BOOT = '\tctx = await boot(await fake.start(), storageRoot, { plugin: true, auto: false, ...options });\n\tjournal = sessionJournal(ctx);\n\tlifecycle = activationJournal(ctx);\n\tt.after(async () => {\n\t\tjournal?.dispose(); lifecycle?.dispose();\n\t\tawait ctx?.fiber.dispose(); await fake.close();\n\t\trmSync(storageRoot, { recursive: true, force: true });\n\t});\n'
BOOT_INSIDE_TRY = '\ttry {\n\t\t// Started and assembled inside the try: a host that fails to boot still reaches the cleanup.\n\t\tctx = await bootComposition(await fake.start(), storageRoot);\n'
BOOT_OUTSIDE_TRY = '\tctx = await bootComposition(await fake.start(), storageRoot);\n\ttry {\n'

try:
    suite('watcher', watcher(source), source, 45, 90)
    cases = [('rc1', '0.2.2-rc.1', Path('/Users/yuhan/codespace/dsh-subagent-compactor/node_modules'))]
    for number in [2, 3, 4]:
        version = f'0.2.2-rc.{number}'
        runtime = scratch / f'rc{number}'
        runtime.mkdir()
        dependencies = {name: version if name.startswith('@deepseek-ai/dsh-') else pinned for name, pinned in pkg['devDependencies'].items()}
        (runtime / 'package.json').write_text(json.dumps({'private': True, 'dependencies': dependencies}, indent=2) + '\n')
        step(f'install-rc{number}', [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], runtime, 240)
        cases.append((f'rc{number}', version, runtime / 'node_modules'))
    cases.append(('rc5', '0.2.2-rc.5', Path('/private/tmp/dsh-alpha2-compat/runtime-rc5/node_modules')))
    alpha2 = scratch / 'alpha2'
    alpha2.mkdir()
    for name in ['package.json', 'package-lock.json']:
        shutil.copy2(source / 'test/host-locks/0.2.3-alpha.2' / name, alpha2 / name)
    step('install-alpha2', [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], alpha2, 300)
    cases.append(('alpha2', '0.2.3-alpha.2', alpha2 / 'node_modules'))
    for label, version, modules in cases:
        command = [node, source / 'scripts/test-installed-runtime.mjs', '--modules', modules]
        if label == 'alpha2':
            command += ['--candidate-version', version]
        item = suite(label, command, source, 131)
        manifest = modules / '@deepseek-ai/dsh-subagent/package.json'
        assert json.loads(manifest.read_text())['version'] == version
        item.update(harness=version, hostManifestSha256=digest(manifest))

    cli = [node, source / 'scripts/upstream-compat.mjs']
    for label, version, tag, commit in CANDIDATES:
        work = scratch / f'patrol-{label}'
        prepared = scratch / f'{label}-prepared.json'
        preparing = step(f'{label}-prepare', cli + ['prepare', '--version', version, '--tag', tag, '--commit', commit, '--plugin-sha', plugin_sha, '--scratch', str(work), '--report', str(prepared), '--timeout-ms', '240000'], source, 300)
        assert json.loads(prepared.read_text())['classification'] == 'PREPARED', preparing
        report_path = evidence / f'{label}-report.json'
        running = step(f'{label}-run', cli + ['run', '--plan', str(work / 'plan.json'), '--report', str(report_path), '--timeout-ms', '180000'], source, 400)
        report = json.loads(report_path.read_text())
        keys = ['tag', 'version', 'commit', 'pluginSha', 'classification', 'reason', 'testSummary', 'testExitCode', 'firstFailure', 'dependencyDigest', 'runnerDigest', 'comboDigest', 'candidateRuntime', 'testedAt']
        cell = {key: report[key] for key in keys}
        cell.update(label=label, runLog=running['log'], runSeconds=running['elapsedSeconds'], prepareSeconds=preparing['elapsedSeconds'], report=report_path.name, reportSha256=digest(report_path), cordis=report['installedVersions']['@deepseek-ai/cordis'])
        record['patrol'].append(cell)
        save()
        print(label, 'patrol', cell['classification'], cell['testSummary'], cell['runSeconds'], flush=True)
        assert report['pluginSha'] == plugin_sha and (report['tag'], report['commit']) == (tag, commit), cell
        c = cell['testSummary']
        text = text_of(running)
        if label == 'alpha1':
            # The published host cannot be composed: named, fast, and not a verdict about this plugin.
            assert cell['classification'] == 'NOT_VERIFIED' and cell['reason'] == 'upstream host failed to assemble before the plugin loaded', cell
            assert cell['testExitCode'] == 1 and cell['firstFailure'] == HOST_PROBE and cell['cordis'] == '4.1.0', cell
            assert c['tests'] == 131 and c['fail'] > 0 and c['skipped'] == 2 and c['cancelled'] == c['todo'] == 0, cell
            assert text.count(HOST_PROBE) == c['fail'] and 'AssertionError' not in text and 'outlived their test' not in text and 'timed out' not in text, cell
            # Every failure is thrown as the fixture's own error, and no listener leaked.
            assert text.count(WRAPPED_PROBE) == c['fail'] and 'DSH_FIXTURE_' not in text, cell
            assert cell['runSeconds'] < 120, cell
        else:
            assert cell['classification'] == 'COMPATIBLE' and cell['reason'] == 'stock compatibility suite passed' and cell['testExitCode'] == 0 and cell['firstFailure'] == '', cell
            assert c['tests'] == c['pass'] == 131 and all(c[k] == 0 for k in CLEAN), cell
    record['scratchLeftovers'] = leftovers()
    save()
    assert record['scratchLeftovers'] == [], record['scratchLeftovers']

    rc1 = Path('/Users/yuhan/codespace/dsh-subagent-compactor/node_modules')
    alpha1_modules = scratch / 'patrol-alpha1/dependencies/node_modules'
    alpha1 = through_runner(alpha1_modules, '--candidate-version', '0.2.3-alpha.1')

    fixture, core = 'test/runtime-fixture.mjs', 'scripts/lib/upstream-compat-core.mjs'
    compositions = ['test/integration.test.mjs', 'test/preset-integration.test.mjs']
    # Every contract that a mutant must turn red, as the spec reporter prints its name.
    HOST = 'a host that fails to assemble before the plugin is mounted is attributed to the host, never to the plugin, the runner, or a timeout'
    LEAK_CONTRACT = "a fixture listener leak is the fixture's own failure: INFRA_ERROR, never a verdict about the upstream version"
    REPORTER = 'on the real reporter, a host row that fails with an assertion and a fixture leak are attributed to their source'
    LEAK_RUNNER = 'a real runner with a leaked fixture listener settles INFRA_ERROR and keeps the leak line as its first failure'
    MARKER_RUNNER = 'a real runner that announces a host-assembly failure settles NOT_VERIFIED and keeps the marker as its first failure'
    ASSERTION_RUNNER = "a real runner that announces a host row's own assertion settles NOT_VERIFIED, the same as any other host failure"
    LEAK_SELFCHECK = "fixture listeners: the leak self-check closes and reports a live listener as the fixture's own failure, then passes"
    SKIP_RULE = 'fixture: a plugin-phase check skips only for a stock host that cannot be assembled'
    NOT_ANNOUNCED = ['fixture: a plugin that fails to mount once the host is up is not announced', 'fixture: a plugin that fails to mount once the host and its preset are up is not announced']
    ANNOUNCED = ['fixture: a host row that fails to mount is announced as such', 'fixture: a preset host row that fails to mount is announced as such']
    HOST_ASSERTION = ['fixture: a host row that fails with an assertion is announced, and never thrown as an assertion', 'fixture: a preset host row that fails with an assertion is announced, and never thrown as an assertion']
    CLEANUP = ['fixture: a cleanup that throws neither hides the host failure nor its announcement', 'fixture: a cleanup that throws neither hides the preset host failure nor its announcement']

    def footer(item, tests, passed, failed, skipped):
        assert item['counts'] == {'tests': tests, 'pass': passed, 'fail': failed, 'cancelled': 0, 'skipped': skipped, 'todo': 0}, item

    def only_failed(tests, *names):
        """The footer and the failing rows agree that `names`, and nothing else, turned red."""
        def check(item, text):
            footer(item, tests, tests - len(names), len(names), 0)
            # Rows of the run itself: the closing summary repeats every failure, nested ones included.
            rows = re.findall(r'^✖ (.+?) \([\d.]+ms\)$', text.split('\n✖ failing tests:')[0], re.M)
            assert sorted(rows) == sorted(names), item
        return check

    def stage_never_cleared(item, text):
        only_failed(131, *NOT_ANNOUNCED)(item, text)
        # The plugin's own mount failure arrives wrapped as a host failure. The precondition's
        # console is mocked, so nothing announces it.
        for stage in ['mount @deepseek-ai/dsh-subagent-spawn-in-process', 'resolve preset']:
            assert f'HostAssemblyError: the stock host could not be assembled: {stage}' in text, stage
        assert 'DSH_HOST_ASSEMBLY_FAILED' not in text

    # A failing root after hook is counted as one more test: a leak adds the hook's row to the 21 host failures.
    def leaked(listeners):
        def check(item, text):
            footer(item, 132, 108, 22, 2)
            assert LEAK_PROBE.format(listeners) in text and f'Error [FixtureListenerLeakError]: {listeners} fixture HTTP listener(s) outlived their test' in text, item
            # The leak is thrown as the fixture's own error type, announced once, and is the only fixture announcement.
            assert 'AssertionError' not in text and text.count(WRAPPED_PROBE) == 21 and text.count('DSH_FIXTURE_') == 2, item
        return check

    def each_composition(old, new):
        return lambda root: [swap(root, rel, old, new) for rel in compositions]

    # The contracts of this change, run against the classifier and CLI that the review rejected.
    mutated('superseded-classifier-and-cli-watcher', restore(SUPERSEDED, core, 'scripts/upstream-compat.mjs'), rc1, watcher, '5 failed: every contract the rejected classifier or CLI breaks', only_failed(45, HOST, LEAK_CONTRACT, REPORTER, LEAK_RUNNER, ASSERTION_RUNNER), group='superseded')

    mutated('mutant-stage-never-cleared-rc1', each_composition('\t\tstage = "";\n', ''), rc1, through_runner(rc1), '2 failed: both "not announced" phase checks', stage_never_cleared)
    mutated('mutant-capacity-cleanup-after-boot-alpha1', lambda root: swap(root, 'test/preset-integration.test.mjs', CAPACITY_CLEANUP_BEFORE_BOOT, CAPACITY_CLEANUP_AFTER_BOOT), alpha1_modules, alpha1, '22 failed: the hook names 10 leaked listeners', leaked(10))
    mutated('mutant-callsite-boots-outside-try-alpha1', lambda root: swap(root, 'test/integration.test.mjs', BOOT_INSIDE_TRY, BOOT_OUTSIDE_TRY), alpha1_modules, alpha1, '22 failed: the hook names 1 leaked listener', leaked(1))
    mutated('mutant-classifier-ignores-marker-watcher', lambda root: swap(root, core, '\t\tif (HOST_ASSEMBLY_FAILURE.test(output)) {\n', '\t\tif (false && HOST_ASSEMBLY_FAILURE.test(output)) {\n'), rc1, watcher, '4 failed: every contract that reads the host-assembly marker', only_failed(45, HOST, REPORTER, MARKER_RUNNER, ASSERTION_RUNNER))
    # R1: a leak is the fixture's own failure, and a host row's assertion is not this plugin's.
    mutated('mutant-classifier-ignores-leak-watcher', lambda root: swap(root, core, '\t\tif (FIXTURE_LISTENER_LEAK.test(output)) {\n', '\t\tif (false && FIXTURE_LISTENER_LEAK.test(output)) {\n'), rc1, watcher, '3 failed: every contract that expects a leak to be INFRA_ERROR', only_failed(45, LEAK_CONTRACT, REPORTER, LEAK_RUNNER))
    mutated('mutant-classifier-reads-fixture-lines-watcher', lambda root: swap(root, core, '\t\tconst product = output.split(/\\r?\\n/).filter((line) => !FIXTURE_ANNOUNCEMENT.test(line) && !STACK_FRAME.test(line)).join("\\n");\n', '\t\tconst product = output;\n'), rc1, watcher, '3 failed: every contract with an assertion inside a fixture announcement', only_failed(45, HOST, REPORTER, ASSERTION_RUNNER))
    mutated('mutant-leak-hook-asserts-rc1', lambda root: swap(root, fixture, '\tthrow new FixtureListenerLeakError(leaked.length);\n', '\tthrow Object.assign(new Error(`${leaked.length} fixture HTTP listener(s) outlived their test`), { name: "AssertionError" });\n'), rc1, through_runner(rc1), '1 failed: the leak self-check', only_failed(131, LEAK_SELFCHECK))
    mutated('mutant-leak-hook-silent-rc1', lambda root: swap(root, fixture, '\tconsole.error(`DSH_FIXTURE_LISTENER_LEAK ${leaked.length} fixture HTTP listener(s) outlived their test`);\n', '\tvoid leaked.length;\n'), rc1, through_runner(rc1), '1 failed: the leak self-check', only_failed(131, LEAK_SELFCHECK))
    # R2: only a host that cannot be assembled makes a phase check skip.
    mutated('mutant-skip-swallows-unexpected-errors-rc1', lambda root: swap(root, fixture, '\tif (!(error instanceof HostAssemblyError)) throw error;\n', '\tif (!(error instanceof HostAssemblyError)) return;\n'), rc1, through_runner(rc1), '1 failed: the skip rule', only_failed(131, SKIP_RULE))
    # R3: the original host failure and its announcement survive the cleanup.
    mutated('mutant-host-error-also-cause-rc1', lambda root: swap(root, fixture, '\t\tObject.defineProperty(this, "hostError", { value: hostError });\n', '\t\tObject.defineProperty(this, "hostError", { value: hostError }); this.cause = hostError;\n'), rc1, through_runner(rc1), '2 failed: both "never thrown as an assertion" contracts', only_failed(131, *HOST_ASSERTION))
    mutated('mutant-cleanup-failure-unannounced-rc1', lambda root: swap(root, fixture, '\t\t...(cleanup ? [`DSH_FIXTURE_CLEANUP_FAILED ${stage}: ${describe(cleanup)}`] : []),\n', '\t\t...[],\n'), rc1, through_runner(rc1), '2 failed: both cleanup contracts', only_failed(131, *CLEANUP))
    mutated('mutant-cleanup-unguarded-rc1', each_composition('\t\tconst cleanup = await disposeComposition(ctx);\n', '\t\tconst cleanup = await ctx.fiber.dispose();\n'), rc1, through_runner(rc1), '2 failed: both cleanup contracts', only_failed(131, *CLEANUP))
    mutated('mutant-host-error-rethrown-rc1', each_composition('\t\tthrow new HostAssemblyError(stage, error);\n', '\t\tthrow error;\n'), rc1, through_runner(rc1), '6 failed: every announced-host contract', only_failed(131, *ANNOUNCED, *HOST_ASSERTION, *CLEANUP))

    step('pack', [npm, 'pack', '--dry-run', '--json'], source, 60)
    for rel, expected in record['testedFileSha256'].items():
        assert digest(source / rel) == expected, rel
    record['testedFilesUnchanged'] = True
    record['completedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()
finally:
    shutil.rmtree(scratch)
