"""Native Codex lifecycle -> Hmux state; run under the repository guardian."""
import argparse
import hashlib
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import threading
import time

REPO = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
MODEL_SPEC = importlib.util.spec_from_file_location('completion_fixture', Path(__file__).with_name('managed-codex-completion-path-smoke.py'))
MODEL_MODULE = importlib.util.module_from_spec(MODEL_SPEC)
MODEL_SPEC.loader.exec_module(MODEL_MODULE)
APPROVAL_SPEC = importlib.util.spec_from_file_location('approval_fixture', Path(__file__).with_name('fixtures') / 'codex-approval.py')
APPROVAL_MODULE = importlib.util.module_from_spec(APPROVAL_SPEC)
APPROVAL_SPEC.loader.exec_module(APPROVAL_MODULE)


class LimitModel(BaseHTTPRequestHandler):
    entered = threading.Event()
    release = threading.Event()
    requests = 0
    outcome = 'failed'
    successor_release = threading.Event()
    successor_entered = threading.Event()

    def log_message(self, *_args):
        pass

    def do_POST(self):
        size = int(self.headers.get('Content-Length', '0'))
        if size > 1024 * 1024 or not self.path.endswith('/responses'):
            self.send_error(400)
            return
        type(self).requests += 1
        request_number = type(self).requests
        self.entered.set()
        if not self.release.wait(30):
            self.send_error(500)
            return
        if self.outcome == 'approval':
            return APPROVAL_MODULE.respond(self, request_number, size)
        if self.outcome == 'connection-lost':
            # The fixture has already terminated its request owner.
            self.close_connection = True
            return
        if self.outcome == 'goal' and request_number > 2:
            self.successor_entered.set()
            self.successor_release.wait(30)
        if self.outcome in ('completed', 'goal'):
            return MODEL_MODULE.ModelFixture.do_POST(self)
        self.rfile.read(size)
        body = json.dumps({'error': {
            'type': 'usage_limit_reached', 'message': 'The usage limit has been reached',
            'plan_type': 'plus', 'resets_in_seconds': 3600,
        }}).encode()
        self.send_response(429)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def wait(predicate, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError('bounded fixture observation timed out')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--driver', type=Path, required=True)
    parser.add_argument('--codex', type=Path, required=True)
    parser.add_argument('--legacy-hooks', action='store_true')
    parser.add_argument('--outcome', choices=('failed', 'completed', 'interrupted', 'goal', 'connection-lost', 'approval'), default='failed')
    parser.add_argument('--resume-evidence', type=Path)
    parser.add_argument('--preserve-stop', action='store_true')
    parser.add_argument('--draft', action='store_true', help='Retain an unsubmitted draft and require stop refusal')
    parser.add_argument('--report-outage', action='store_true', help='Require convergence after an isolated report transport outage')
    parser.add_argument('--outage-successor', action='store_true', help='Start another turn before restoring report transport')
    parser.add_argument('--picker', action='store_true', help='Exercise the native /resume picker after a completed turn')
    args = parser.parse_args()
    LimitModel.outcome = args.outcome
    codex = str(args.codex.resolve(strict=True))
    driver_sha = hashlib.sha256(args.driver.read_bytes()).hexdigest()
    assert not args.draft or args.preserve_stop, '--draft requires --preserve-stop'
    assert not args.outage_successor or (args.report_outage and args.outcome == 'failed')
    assert not args.picker or (args.outcome == 'completed' and not args.legacy_hooks and not args.preserve_stop)
    assert args.outcome != 'approval' or (not args.legacy_hooks and not args.report_outage and not args.preserve_stop)
    evidence = Path(tempfile.mkdtemp(prefix='dure-codex-native-evidence-', dir=Path(os.environ['DURE_HMUX_TEST_STATE_ROOT']).parent))
    print(json.dumps({'evidence': str(evidence)}), flush=True)
    root = Path(os.environ['DURE_HMUX_TEST_STATE_ROOT']) / 'usage-limit'
    root.mkdir(mode=0o700)
    conversation = None
    if args.resume_evidence:
        previous = json.loads((args.resume_evidence / 'native-result.json').read_text())
        assert previous['realCredentialsUsed'] is False
        profile = Path(previous['profile']).resolve(strict=True)
        assert profile.parent == args.resume_evidence.resolve(strict=True)
        assert profile.parent.parent == evidence.parent
        assert profile.parent.name.startswith('dure-codex-native-evidence-')
        identities = {json.loads(line)['payload']['id'] for path in profile.glob('sessions/**/*.jsonl')
                      for line in path.read_text().splitlines() if json.loads(line).get('type') == 'session_meta'}
        assert len(identities) == 1, identities
        conversation = next(iter(identities))
    else:
        profile = Path(tempfile.mkdtemp(prefix='codex-profile-', dir=evidence))
    cli = Path(os.environ['DURE_QA_HMUX_BIN']).resolve(strict=True)
    runtime = Path(os.environ['DURE_QA_HMUX_RUNTIME']).resolve(strict=True)
    report_runtime = runtime
    report_unavailable = root / 'report-unavailable'
    if args.report_outage:
        assert not args.legacy_hooks and args.outcome in ('failed', 'completed')
        report_runtime = root / 'report-runtime.sh'
        report_runtime.write_text(
            '#!/bin/sh\n'
            f'if test -f {shlex.quote(str(report_unavailable))}; then exit 75; fi\n'
            f'exec {shlex.quote(str(runtime))} "$@"\n'
        )
        report_runtime.chmod(0o700)
    env = {
        'PATH': os.environ.get('PATH', os.defpath), 'TERM': 'xterm-256color',
        'HOME': str(root), 'CODEX_HOME': str(profile), 'CODEX_SQLITE_HOME': str(profile),
        'DURE_HOME': str(root), 'HMUX_DISCOVERY_ROOT': os.environ['HMUX_DISCOVERY_ROOT'],
        'TMPDIR': str(root),
    }
    native_executable = codex
    if args.outcome == 'connection-lost':
        assert not args.legacy_hooks and not args.preserve_stop and not args.report_outage
        env.update({'DURE_QA_NATIVE_ROOT': str(root), 'DURE_QA_NATIVE_CODEX': codex})
        native_executable = str(root / 'native-codex-fixture')
        Path(native_executable).write_text(
            f'#!{sys.executable}\nimport json, os, sys\nfrom pathlib import Path\n'
            'root = Path(os.environ["DURE_QA_NATIVE_ROOT"])\n'
            'codex = os.environ["DURE_QA_NATIVE_CODEX"]\n'
            'if sys.argv[1:2] == ["app-server"]:\n'
            '    (root / "app-server-child.json").write_text(json.dumps({"pid": os.getpid(), '
            '"parentPid": os.getppid(), "cwd": str(root), "executable": codex}))\n'
            'os.execv(codex, [codex, *sys.argv[1:]])\n')
        Path(native_executable).chmod(0o700)
    (profile / 'config.toml').write_text(
        'check_for_update_on_startup=false\n'
        f'[projects.{json.dumps(str(root))}]\ntrust_level="trusted"\n'
    )
    hook = root / 'managed-codex-notify.sh'
    hook.write_text((REPO / 'src-tauri/resources/managed-claude-hook.py').read_text().replace(
        '"__DURE_HMUX_RUNTIME_EXECUTABLE__"', json.dumps(str(runtime))))
    hook.chmod(0o700)
    recorded = profile / 'hook-invocations.jsonl'
    prior_notifications = len(recorded.read_text().splitlines()) if recorded.exists() else 0
    recorder = root / 'record-hook.py'
    recorder.write_text(
        '#!' + sys.executable + '\nimport json, subprocess, sys\nfrom pathlib import Path\n'
        'raw = sys.argv[-1] if len(sys.argv) > 1 else sys.stdin.read()\n'
        'payload = json.loads(raw)\n'
        f'with Path({str(recorded)!r}).open("a") as output:\n'
        '    output.write(json.dumps(payload) + "\\n")\n'
        + (f'subprocess.run([{sys.executable!r}, {str(hook)!r}, *sys.argv[1:]], '
           'input=raw.encode() if len(sys.argv) == 1 else b"", timeout=3)\n' if args.legacy_hooks else '')
    )
    recorder.chmod(0o700)
    server = ThreadingHTTPServer(('127.0.0.1', 0), LimitModel)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    created = False

    def command(args):
        result = subprocess.run(
            [str(cli), '--discovery-root', env['HMUX_DISCOVERY_ROOT'], '--json', *args],
            cwd=root, env=env, capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, result.stdout + result.stderr
        return json.loads(result.stdout)

    def events():
        result = []
        for path in profile.glob('sessions/**/*.jsonl'):
            for line in path.read_text().splitlines():
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if record.get('type') == 'event_msg':
                    result.append(record['payload'])
        return result

    def lifecycle_records():
        for path in root.glob('dure-codex-*/lifecycle.json'):
            try:
                return json.loads(path.read_text())
            except ValueError:
                pass
        return []

    previous_turns = {event.get('turn_id') for event in events()}

    try:
        hook_args = ['--dangerously-bypass-hook-trust', '-c', 'features.hooks=true',
                     '-c', 'notify=' + json.dumps([str(recorder)])]
        for event in ('SessionStart', 'UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd'):
            hook_args.extend(['-c', f'hooks.{event}=[{{hooks=[{{type="command",command={json.dumps(str(recorder))},timeout=3}}]}}]'])
        prefix = [codex] if args.legacy_hooks else [str(args.driver.resolve(strict=True)), 'codex-native-driver', '--runtime', str(report_runtime), '--', native_executable]
        request = {
            'schema': 'hmux-managed-create-v1', 'schemaVersion': 1,
            'idempotencyKey': 'codex-usage-limit-proof', 'sessionId': 'codex-usage-limit-proof',
            'workspaceId': 'codex-usage-limit-workspace', 'providerId': 'codex',
            'permissionMode': 'default', 'providerCwd': str(root),
            'command': [sys.executable, str(REPO / 'scripts/qa/fixtures/native-provider-input-bridge.py'),
                        *prefix, '--no-alt-screen', '--sandbox', 'workspace-write',
                        '--ask-for-approval', 'on-request' if args.outcome == 'approval' else 'never', '-m', 'gpt-5.6-sol',
                        '-c', 'model_provider="fixture"', '-c',
                        'model_providers.fixture={name="fixture",base_url="http://127.0.0.1:%d/v1",wire_api="responses",requires_openai_auth=false}' % server.server_port,
                        *(hook_args if args.legacy_hooks else ['-c', 'notify=' + json.dumps([str(recorder)])]),
                        *(['resume', conversation] if conversation else []),
                        *([] if args.outcome == 'goal' else ['Wait for the fixture response. Do not call tools.'])],
            'initialRows': 40, 'initialColumns': 120,
        }
        encoded = json.dumps(request).encode()
        result = subprocess.run([str(runtime), '--no-autostart', 'internal-hmux-managed-create'],
                                input=len(encoded).to_bytes(4, 'big') + encoded,
                                capture_output=True, env=env, cwd=root, timeout=20)
        assert result.returncode == 0, result.stderr.decode()
        receipt = json.loads(result.stdout[4:])
        assert receipt['state'] == 'completed', receipt
        created = True
        session = command(['ls'])[0]
        fence = {key: session[key] for key in ('workspace_id', 'session_id', 'runner_principal', 'runner_instance', 'channel_epoch', 'host_instance_id', 'terminal_epoch')}
        exact = ['--target', session['session_id'], '--workspace', session['workspace_id'], '--expected-fence-json', json.dumps(fence)]
        if args.outcome == 'goal':
            # Empty native TUI startup is lazy: no thread exists until input.
            # This is fixture input readiness, never production activity parsing.
            wait(lambda: (root / 'provider-output.bin').exists() and b'gpt-5.6-sol' in (root / 'provider-output.bin').read_bytes(), 30)
            command(['command-input', *exact, '--text',
                     '/goal Continue working until I explicitly stop you. Do not use tools.', '--submit'])

        def state():
            return command(['session', 'snapshot', session['session_id'], '--workspace',
                            session['workspace_id']])['agentRuntimeState']

        wait(LimitModel.entered.is_set, 30)
        before = state()
        assert before['activity'] == 'working', before
        assert before['source'] == 'provider_event', before
        # Each snapshot opens and detaches a real read-only Host connection.
        # A fresh observer must retain the same generation and working state.
        reattached = state()
        assert reattached == before, (before, reattached)
        if args.outcome == 'connection-lost':
            def process_boundary(mode):
                observed = subprocess.run(['node', str(REPO / 'scripts/qa/fixtures/native-codex-server-loss.mjs'),
                                           mode, str(root)], capture_output=True, text=True, timeout=10)
                (evidence / f'app-server-{mode}.json').write_text(observed.stdout)
                assert observed.returncode == 0, observed.stderr
                return json.loads(observed.stdout)
            process_boundary('capture')
            (evidence / 'lifecycle-before-loss.json').write_text(json.dumps(lifecycle_records()))
            process_boundary('crash')
            wait(lambda: (root / 'provider-exit.json').exists(), 10)
            exited = process_boundary('verify-exit')
            provider_exit = json.loads((root / 'provider-exit.json').read_text())
            assert provider_exit['status'] != 0, provider_exit
            # An exited Host is inspectable but cannot serve a terminal snapshot.
            # Its missing live projection must not be replaced by invented idle.
            after = command(['session', 'show', session['session_id'], '--workspace', session['workspace_id']])
            assert after['health'] == 'exited' and after['effectiveLifecycle'] == 'exited', after
            assert after['agentRuntimeState'] is None, after
            assert not any(event.get('turn_id') not in previous_turns and event.get('type') == 'task_complete'
                           and not event.get('error') for event in events())
            result = {'source': subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', 'HEAD'], text=True).strip(),
                      'driverSha256': driver_sha, 'profile': str(profile), 'realCredentialsUsed': False,
                      'outcome': args.outcome, 'before': before, 'after': after,
                      'serverExit': exited, 'providerExit': provider_exit}
            (evidence / 'native-result.json').write_text(json.dumps(result, indent=2))
            print(json.dumps(result), flush=True)
            return
        if args.draft:
            command(['command-input', *exact, '--text', 'RETAIN THIS UNFINISHED DRAFT'])
        continuation = None
        successor = None
        interrupted_turn = None
        if args.report_outage:
            report_unavailable.touch(mode=0o600)
        if args.outcome == 'interrupted':
            command(['command-input', *exact, '--key', 'Escape'])
        else:
            LimitModel.release.set()
        approval = APPROVAL_MODULE.check(command, exact, state, root, before, wait) if args.outcome == 'approval' else None
        if args.outcome == 'goal':
            wait(lambda: LimitModel.successor_entered.is_set() and len({event.get('turn_id') for event in events()
                              if event.get('type') == 'task_started' and event.get('turn_id') not in previous_turns}) >= 2, 20)
            interrupted_turn = next(event['turn_id'] for event in reversed(events()) if event.get('type') == 'task_started')
            # Interrupt the held successor, not a completed predecessor whose
            # rollover may still be reaching the native TUI.
            wait(lambda: any(record.get('event') == 'turn/started' and record.get('turnId') == interrupted_turn
                and record.get('outcome') in ('Applied', 'NoOp') for record in lifecycle_records()))
            continuation = state()
            assert continuation['activity'] == 'working', continuation
            assert continuation['turn_completed_count'] == before['turn_completed_count'], continuation
            command(['command-input', *exact, '--key', 'Escape'])
        completed = wait(lambda: next((event for event in reversed(events())
                                      if event.get('turn_id') not in previous_turns
                                      and (interrupted_turn is None or event.get('turn_id') == interrupted_turn)
                                      and event.get('type') == ('turn_aborted' if args.outcome in ('interrupted', 'goal') else 'task_complete')), None), 20)
        if args.outcome == 'failed':
            assert completed.get('error', {}).get('codex_error_info') == 'usage_limit_exceeded', completed
        else:
            assert not completed.get('error'), completed
        if args.report_outage:
            # Refuse only this fixture driver's report broker, not the Host or
            # the observer. Restore it after proving a rejected boundary.
            wait(lambda: b'[codex native lifecycle] report unavailable' in (root / 'provider-output.bin').read_bytes())
            if args.outage_successor:
                LimitModel.release.clear()
                command(['command-input', *exact, '--text', 'Run the next isolated turn. Do not call tools.', '--submit'])
                successor = wait(lambda: next((event for event in reversed(events())
                    if event.get('type') == 'task_started' and event.get('turn_id') not in previous_turns
                    and event.get('turn_id') != completed['turn_id']), None), 20)
                wait(lambda: any(record.get('turnId') == successor['turn_id']
                    and record.get('outcome') == 'hmux_managed_runtime_failed' for record in lifecycle_records()))
            report_unavailable.unlink()
            if successor:
                wait(lambda: any(record.get('event') == 'thread/reconciled'
                    and record.get('activity') == 'working' and record.get('outcome') in ('Applied', 'NoOp')
                    for record in lifecycle_records()), 10)
                continuation = state()
                assert continuation['activity'] == 'working', continuation
                assert continuation['turn_completed_count'] == before['turn_completed_count'], continuation
                (evidence / 'successor-recovery.json').write_text(json.dumps({
                    'turnId': successor['turn_id'], 'state': continuation, 'lifecycle': lifecycle_records()
                }, indent=2))
                LimitModel.release.set()
                completed = wait(lambda: next((event for event in reversed(events())
                    if event.get('type') == 'task_complete' and event.get('turn_id') == successor['turn_id']), None), 20)
                assert completed.get('error', {}).get('codex_error_info') == 'usage_limit_exceeded', completed
        after = None
        try:
            after = wait(lambda: (current if (current := state())['activity'] == 'waiting' else None), 5)
        except AssertionError:
            after = state()
        delivery = [json.loads(line) for line in recorded.read_text().splitlines()] if recorded.exists() else []
        delivery = delivery[prior_notifications:]
        result_evidence = {'source': subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', 'HEAD'], text=True).strip(),
                    'codex': subprocess.check_output([codex, '--version'], text=True).strip(),
                    'runtime': str(runtime), 'root': str(root), 'profile': str(profile),
                    'resumedConversation': conversation,
                    'reportOutage': args.report_outage,
                    'outageSuccessor': args.outage_successor,
                    'driverSha256': driver_sha,
                    'outcome': args.outcome, 'before': before, 'terminalTurn': completed, 'after': after,
                    'reattachedWorking': reattached, 'continuation': continuation,
                    'hooks': [{'event': item.get('hook_event_name', item.get('type')),
                               'turn': item.get('turn_id', item.get('turn-id'))} for item in delivery],
                    'modelRequests': LimitModel.requests, 'realCredentialsUsed': False, 'approval': approval}
        (evidence / 'native-result.json').write_text(json.dumps(result_evidence, indent=2) + '\n')
        print(json.dumps(result_evidence), flush=True)
        assert after['activity'] == 'waiting', 'usage-limit failed turn left Host working'
        assert after['source'] == 'provider_event'
        assert int(after['turn_completed_count']) == int(before['turn_completed_count']) + int(args.outcome in ('completed', 'approval'))
        if args.picker:
            picker_spec = importlib.util.spec_from_file_location('picker_fixture', Path(__file__).with_name('fixtures') / 'codex-session-picker.py')
            picker = importlib.util.module_from_spec(picker_spec)
            picker_spec.loader.exec_module(picker)
            picker.check(command, exact, session, root, evidence, lambda: LimitModel.requests)
        # Title generation may finish after the main turn. It must not change
        # the selected conversation or create rejected Host reports.
        if not args.report_outage:
            assert b'[codex native lifecycle] report unavailable' not in (root / 'provider-output.bin').read_bytes()
        for path in root.glob('dure-codex-*/lifecycle.json'):
            (evidence / 'lifecycle.json').write_bytes(path.read_bytes())
        (evidence / 'provider-output.bin').write_bytes((root / 'provider-output.bin').read_bytes())
        if args.preserve_stop:
            snapshot = command(['session', 'snapshot', session['session_id'], '--workspace', session['workspace_id']])
            identities = {json.loads(line)['payload']['id'] for path in profile.glob('sessions/**/*.jsonl')
                          for line in path.read_text().splitlines() if json.loads(line).get('type') == 'session_meta'}
            assert len(identities) == 1
            request = {
                'schema': 'hmux-managed-stop-v1', 'schemaVersion': 5,
                'stopId': 'native-completion-preserve-stop', 'sessionId': session['session_id'], 'workspaceId': session['workspace_id'],
                'expectedRunnerPrincipal': fence['runner_principal'], 'expectedRunnerInstance': fence['runner_instance'],
                'expectedChannelEpoch': int(fence['channel_epoch']), 'expectedHostInstanceId': fence['host_instance_id'],
                'expectedTerminalEpoch': fence['terminal_epoch'],
                'expectedQuiescence': {'terminalEpoch': after['terminal_epoch'], 'runtimeRevision': int(after['revision']),
                                       'observedThroughOutputSeq': int(snapshot['sequenceThrough'])},
                'expectedConversation': {'providerId': 'codex', 'conversationId': next(iter(identities))},
            }
            encoded = json.dumps(request).encode()
            stopped = subprocess.run([str(runtime), '--no-autostart', 'internal-hmux-managed-stop'],
                input=len(encoded).to_bytes(4, 'big') + encoded, capture_output=True, env=env, cwd=root, timeout=20)
            assert stopped.returncode == 0, stopped.stderr.decode()
            receipt = json.loads(stopped.stdout[4:])
            (evidence / 'preserve-stop.json').write_text(json.dumps(receipt, indent=2))
            (evidence / 'stop-observation.json').write_text(json.dumps({
                'expected': request['expectedQuiescence'],
                'afterRequest': None if receipt['state'] == 'completed' else command([
                    'session', 'snapshot', session['session_id'], '--workspace', session['workspace_id']]),
            }, indent=2))
            if args.draft:
                assert receipt['state'] == 'refused' and receipt['payload']['code'] == 'hmux_managed_stop_unavailable', receipt
                assert command(['session', 'probe', session['session_id'], '--workspace', session['workspace_id']])
            else:
                assert receipt['state'] == 'completed' and receipt['payload']['outcome'] == 'stopped', receipt
                created = False
    except Exception:
        if created:
            capture = root / 'provider-output.bin'
            if capture.exists():
                (evidence / 'provider-output.bin').write_bytes(capture.read_bytes())
                print(json.dumps({'terminalTail': capture.read_bytes()[-4000:].decode(errors='replace')}), flush=True)
        raise
    finally:
        LimitModel.release.set()
        LimitModel.successor_release.set()
        APPROVAL_MODULE.release.set()
        if created:
            for path in root.glob('dure-codex-*/lifecycle.json'):
                (evidence / 'lifecycle.json').write_bytes(path.read_bytes())
            capture = root / 'provider-output.bin'
            if capture.exists():
                (evidence / 'provider-output.bin').write_bytes(capture.read_bytes())
            (root / 'stop-provider').write_text('stop')
            wait(lambda: (root / 'provider-exit.json').exists(), 5)
            (evidence / 'provider-exit.json').write_text((root / 'provider-exit.json').read_text())
            capture = root / 'provider-output.bin'
            if capture.exists():
                (evidence / 'provider-output.bin').write_bytes(capture.read_bytes())
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    main()
