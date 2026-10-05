"""Provider-protocol fixture -> native driver -> real Host progress projection.

Run with run-hmux-tests.mjs; this does not prove a particular Codex version emits
every notification. Pair with managed-codex-native-smoke.py --message-progress.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]


def wait(predicate, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(.02)
    raise AssertionError('native progress observation timed out')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--driver', required=True, type=Path)
    args = parser.parse_args()
    driver = args.driver.resolve(strict=True)
    state_root = Path(os.environ['DURE_HMUX_TEST_STATE_ROOT']).resolve(strict=True)
    assert state_root.name.startswith('dure-hmux-test.')
    root = state_root / 'codex-progress'
    root.mkdir(mode=0o700)
    (root / 'rollout.jsonl').write_text('')
    cli = str(Path(os.environ['DURE_QA_HMUX_BIN']).resolve(strict=True))
    runtime = str(Path(os.environ['DURE_QA_HMUX_RUNTIME']).resolve(strict=True))
    node = str(Path(shutil.which('node')).resolve(strict=True))
    provider = root / 'provider'
    fixture = REPO / 'scripts/qa/fixtures/codex-progress-native.mjs'
    provider.write_text('#!/bin/sh\nexec ' + shlex.join([node, str(fixture)]) + ' "$@"\n')
    provider.chmod(0o700)
    env = {'PATH': os.environ.get('PATH', os.defpath), 'TERM': 'xterm-256color',
           'HOME': str(root), 'DURE_HOME': str(root), 'CODEX_HOME': str(root),
           'HMUX_DISCOVERY_ROOT': os.environ['HMUX_DISCOVERY_ROOT'],
           'DURE_HMUX_TEST_STATE_ROOT': str(state_root), 'TMPDIR': str(root)}
    evidence = Path(tempfile.mkdtemp(prefix='dure-native-progress-evidence-', dir=state_root.parent))
    print(json.dumps({'evidence': str(evidence)}), flush=True)

    def command(*arguments):
        result = subprocess.run([cli, '--discovery-root', env['HMUX_DISCOVERY_ROOT'], '--json', *arguments],
                                env=env, cwd=root, capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, result.stdout + result.stderr
        return json.loads(result.stdout)

    def state():
        return command('session', 'snapshot', 'progress-fixture', '--workspace', 'progress-workspace')['agentRuntimeState']

    revision = 0

    def send(method, **extra):
        nonlocal revision
        revision += 1
        notification = {'method': method, 'params': {'threadId': 'thread-progress',
                        'turnId': 'turn-progress', 'itemId': 'item-progress', **extra}}
        temporary = root / 'notifications.tmp'
        temporary.write_text(json.dumps({'revision': revision, 'notifications': [notification]}))
        temporary.replace(root / 'notifications.json')
        def observed():
            try:
                return json.loads((root / 'observed.json').read_text())['revision'] == revision
            except (FileNotFoundError, ValueError):
                return False
        wait(observed)

    request = {'schema': 'hmux-managed-create-v1', 'schemaVersion': 1,
               'idempotencyKey': 'progress-fixture', 'sessionId': 'progress-fixture',
               'workspaceId': 'progress-workspace', 'providerId': 'codex',
               'permissionMode': 'default', 'providerCwd': str(root),
               'command': [str(driver), 'codex-native-driver', '--runtime', runtime, '--', str(provider)],
               'initialRows': 24, 'initialColumns': 80}
    encoded = json.dumps(request).encode()
    created = subprocess.run([runtime, '--no-autostart', 'internal-hmux-managed-create'],
                             input=len(encoded).to_bytes(4, 'big') + encoded, env=env, cwd=root,
                             capture_output=True, timeout=20)
    assert created.returncode == 0, created.stderr.decode()
    assert json.loads(created.stdout[4:])['state'] == 'completed', created.stdout
    session = command('session', 'show', 'progress-fixture', '--workspace', 'progress-workspace')
    fence = {key: session[key] for key in ('workspace_id', 'session_id', 'runner_principal',
             'runner_instance', 'channel_epoch', 'host_instance_id', 'terminal_epoch')}
    observations = []
    try:
        wait(lambda: (state() or {}).get('source') == 'provider_event')
        send('turn/started', turn={'id': 'turn-progress', 'status': 'inProgress'})
        before = wait(lambda: (value if (value := state()).get('progress') else None))
        source = before['progress']['report']['source_id']
        for method, extra in [
            ('item/fileChange/patchUpdated', {'changes': [{'path': 'example.rs', 'kind': {'type': 'update'}, 'diff': '+first'}]}),
            ('turn/diff/updated', {'diff': '+first'}),
            ('item/plan/delta', {'delta': 'First inspect'}),
            ('item/mcpToolCall/progress', {'message': 'Processed page 1'}),
            ('item/fileChange/outputDelta', {'delta': 'Updating file'}),
        ]:
            time.sleep(2.1)  # Exercise the production publication throttle.
            send(method, **extra)
            after = wait(lambda: (value if int((value := state())['progress']['report']['sequence']) > int(before['progress']['report']['sequence']) else None))
            assert after['activity'] == 'working', after
            assert after['progress']['report']['source_id'] == source, after
            assert after['progress']['report']['phase'] == 'thinking', after
            assert after['turn_completed_count'] == before['turn_completed_count'], after
            assert after['progress']['progress_unconfirmed'] is False, after
            observations.append({'method': method, 'before': before, 'after': after})
            if method in ('item/fileChange/patchUpdated', 'turn/diff/updated', 'item/mcpToolCall/progress'):
                time.sleep(2.1)
                send(method, **extra)
                assert state()['progress']['report'] == after['progress']['report'], method
            before = after
        send('thread/tokenUsage/updated', tokenUsage={'total': {'outputTokens': 10, 'reasoningOutputTokens': 1}})
        assert state()['progress']['report'] == before['progress']['report']
        time.sleep(2.1)
        send('thread/tokenUsage/updated', tokenUsage={'total': {'outputTokens': 11, 'reasoningOutputTokens': 1}})
        after = wait(lambda: (value if int((value := state())['progress']['report']['sequence']) > int(before['progress']['report']['sequence']) else None))
        observations.append({'method': 'thread/tokenUsage/updated', 'before': before, 'after': after})
        send('turn/completed', turn={'id': 'turn-progress', 'status': 'completed'})
        completed = wait(lambda: (value if (value := state())['activity'] == 'waiting' else None))
        assert int(completed['turn_completed_count']) == int(before['turn_completed_count']) + 1
        time.sleep(2.1)
        send('item/plan/delta', delta='late')
        assert state()['progress']['report'] == completed['progress']['report']
        result = {'ok': True, 'realCredentialsUsed': False, 'provider': 'protocol-fixture',
                  'driverSha256': hashlib.sha256(driver.read_bytes()).hexdigest(),
                  'observations': observations, 'completed': completed}
        (evidence / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'ok': True, 'signals': len(observations), 'evidence': str(evidence)}), flush=True)
    finally:
        for path in root.glob('dure-codex-*/lifecycle.json'):
            (evidence / 'lifecycle.json').write_bytes(path.read_bytes())
        command('kill', 'progress-fixture', '--workspace', 'progress-workspace',
                '--expected-fence-json', json.dumps(fence), '--runtime', runtime)


if __name__ == '__main__':
    main()
