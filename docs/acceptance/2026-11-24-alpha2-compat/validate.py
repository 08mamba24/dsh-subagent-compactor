"""Validate the candidate in six isolated stock runtimes without daily data.

Requires Homebrew Node 24.22.3, the three documented existing npm trees, and
public npm access for rc.2--rc.4 and the checked-in alpha.2 host lock.
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

evidence = Path(__file__).resolve().parent
source = evidence.parents[2]
node = Path('/opt/homebrew/opt/node@24/bin/node')
npm = node.parent / 'npm'
scratch = Path(tempfile.mkdtemp(prefix='dsh-alpha2-candidate-'))
home = scratch / 'home'
home.mkdir()
environment = {'HOME': str(home), 'TMPDIR': str(scratch), 'PATH': f'{node.parent}:/usr/bin:/bin', 'LANG': 'en_US.UTF-8', 'NPM_CONFIG_CACHE': str(scratch / 'npm-cache')}
pkg = json.loads((source / 'package.json').read_text())
files = ['index.js', 'package.json', 'package-lock.json', '.github/workflows/ci.yml', '.github/workflows/upstream-compat.yml']
files += [str(p.relative_to(source)) for directory in ['test', 'scripts'] for p in (source / directory).rglob('*') if p.is_file() and 'node_modules' not in p.parts]
record = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'node': str(node), 'nodeSha256': hashlib.sha256(node.read_bytes()).hexdigest(), 'scope': 'local stock module suites; synthetic loopback models; no Desktop GUI or daily installation', 'testedFileSha256': {rel: hashlib.sha256((source / rel).read_bytes()).hexdigest() for rel in sorted(files)}, 'runs': []}


def save():
    (evidence / 'validation.json').write_text(json.dumps(record, indent=2) + '\n')


def run(label, command, cwd, timeout, suite=False):
    log = evidence / f'{label}.log'
    item = {'label': label, 'command': [str(part) for part in command], 'cwd': str(cwd), 'log': log.name}
    with log.open('w') as output:
        output.write(json.dumps(item) + '\n')
        output.flush()
        process = subprocess.Popen(command, cwd=cwd, env=environment, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise
    item.update(exitCode=code, logSha256=hashlib.sha256(log.read_bytes()).hexdigest())
    if suite:
        text = log.read_text()
        item['counts'] = {key: int(re.search(rf'^ℹ {key} (\d+)$', text, re.M).group(1)) for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']}
    record['runs'].append(item)
    save()
    print(label, code, item.get('counts', ''), flush=True)
    assert code == 0, f'{label}: see {log}'
    if suite:
        c = item['counts']
        assert c['tests'] == c['pass'] > 0 and all(c[k] == 0 for k in ['fail', 'cancelled', 'skipped', 'todo']), item
    return item


try:
    run('watcher', [node, '--test', '--test-reporter=spec', 'test/upstream-compat-watch.test.mjs'], source, 90, True)
    cases = [('rc1', '0.2.2-rc.1', Path('/Users/yuhan/codespace/dsh-subagent-compactor/node_modules'))]
    for number in [2, 3, 4]:
        version = f'0.2.2-rc.{number}'
        runtime = scratch / f'rc{number}'
        runtime.mkdir()
        dependencies = {name: version if name.startswith('@deepseek-ai/dsh-') else pinned for name, pinned in pkg['devDependencies'].items()}
        (runtime / 'package.json').write_text(json.dumps({'private': True, 'dependencies': dependencies}, indent=2) + '\n')
        run(f'install-rc{number}', [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], runtime, 240)
        cases.append((f'rc{number}', version, runtime / 'node_modules'))
    cases.append(('rc5', '0.2.2-rc.5', Path('/private/tmp/dsh-alpha2-compat/runtime-rc5/node_modules')))
    alpha = scratch / 'alpha2'
    alpha.mkdir()
    for name in ['package.json', 'package-lock.json']:
        shutil.copy2(source / 'test/host-locks/0.2.3-alpha.2' / name, alpha / name)
    run('install-alpha2', [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], alpha, 300)
    cases.append(('alpha2', '0.2.3-alpha.2', alpha / 'node_modules'))
    for label, version, modules in cases:
        command = [node, source / 'scripts/test-installed-runtime.mjs', '--modules', modules]
        if label == 'alpha2':
            command += ['--candidate-version', version]
        item = run(label, command, source, 90, True)
        item['harness'] = version
        manifest = modules / '@deepseek-ai/dsh-subagent/package.json'
        assert json.loads(manifest.read_text())['version'] == version
        item['hostManifestSha256'] = hashlib.sha256(manifest.read_bytes()).hexdigest()
        lock = modules.parent / 'package-lock.json'
        item['dependencyLockSha256'] = hashlib.sha256(lock.read_bytes()).hexdigest()
        assert item['counts']['tests'] == 120, item
        save()
    run('pack', [npm, 'pack', '--dry-run', '--json'], source, 60)
    for rel, expected in record['testedFileSha256'].items():
        assert hashlib.sha256((source / rel).read_bytes()).hexdigest() == expected, rel
    record['testedFilesUnchanged'] = True
    record['completedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()
finally:
    shutil.rmtree(scratch)
