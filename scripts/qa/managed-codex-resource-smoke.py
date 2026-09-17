"""Real native Codex + MCP stop/resume proof; run with run-hmux-tests.mjs.

Uses disposable credentials and a loopback model. Automatic hibernation is
opt-in and isolated; CPU silence and guardian cleanup are never product proof.
"""

import argparse
import hashlib
import importlib.util
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time

REPO = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
MODEL_SPEC = importlib.util.spec_from_file_location('completion_fixture',
    Path(__file__).with_name('managed-codex-completion-path-smoke.py'))
MODEL_MODULE = importlib.util.module_from_spec(MODEL_SPEC)
MODEL_SPEC.loader.exec_module(MODEL_MODULE)
sys.path.insert(0, str(Path(__file__).with_name('fixtures')))
from native_idle_backend import NativeIdleBackend
from codex_resource_descendants import DescendantModel


def wait(predicate, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.05)
    raise AssertionError('resource lifecycle fixture observation timed out')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--driver', type=Path, required=True)
    parser.add_argument('--codex', type=Path, required=True)
    parser.add_argument('--inflight-tool', action='store_true',
                        help='Require an auxiliary MCP call to protect the runtime from idle reclamation')
    parser.add_argument('--disconnect-helper', action='store_true',
                        help='Disconnect the caller while its MCP tool remains in flight')
    parser.add_argument('--report-outage', action='store_true',
                        help='Require a refused state report to prevent tool execution without stopping the pane')
    parser.add_argument('--response-outage', action='store_true',
                        help='Require automatic state convergence after the tool response report fails')
    parser.add_argument('--idle-worker', action='store_true',
                        help='Keep native Codex and its thread while retiring only its Dure MCP worker')
    parser.add_argument('--reload-mcp', action='store_true',
                        help='Probe whether changing one MCP leaves another stateful MCP intact')
    parser.add_argument('--activate-idle-worker', action='store_true',
                        help='Adopt the idle relay in an already-running native Codex without restarting it')
    parser.add_argument('--automatic-hibernation', action='store_true',
                        help='Use the isolated backend idle coordinator and same-conversation wake')
    parser.add_argument('--active-descendant', action='store_true',
                        help='Protect a completed parent while its real spawned child is still working')
    parser.add_argument('--generations', type=int, choices=range(2, 11),
                        help='Repeat automatic stop/wake for 2..10 generations (default: 2)')
    parser.add_argument('--late-conversation', action='store_true',
                        help='Register the fresh native source before its first conversation is known')
    parser.add_argument('--pending-input', action='store_true',
                        help='Observe an unsubmitted draft as protected before submitting the resumed turn')
    parser.add_argument('--restart-idle-backend', action='store_true',
                        help='Require uninterrupted native idle age across a backend-only restart')
    parser.add_argument('--initial-runtime', type=Path,
                        help='Start on an older Host without native idle age, then wake on the current runtime')
    parser.add_argument('--resume-input-readiness', choices=('identity', 'provider'), default='provider',
                        help='Use provider readiness; identity selects the early-input diagnostic without retries')
    args = parser.parse_args()
    if args.restart_idle_backend and not args.automatic_hibernation:
        parser.error('--restart-idle-backend requires --automatic-hibernation')
    if args.initial_runtime and not args.automatic_hibernation:
        parser.error('--initial-runtime requires --automatic-hibernation')
    if args.generations is not None and not args.automatic_hibernation:
        parser.error('--generations requires --automatic-hibernation')
    if args.active_descendant and (not args.automatic_hibernation or any((
            args.inflight_tool, args.late_conversation, args.pending_input))):
        parser.error('--active-descendant requires automatic hibernation without other activity scenarios')
    assert not args.disconnect_helper or args.inflight_tool
    assert not args.response_outage or (args.inflight_tool and not args.disconnect_helper)
    assert not args.idle_worker or not any((args.inflight_tool, args.disconnect_helper,
                                          args.report_outage, args.response_outage))
    assert not args.reload_mcp or not any((args.idle_worker, args.inflight_tool, args.disconnect_helper,
                                         args.report_outage, args.response_outage))
    assert not args.activate_idle_worker or args.idle_worker
    assert not args.late_conversation or args.automatic_hibernation
    assert not args.pending_input or args.automatic_hibernation
    assert not args.automatic_hibernation or not any((args.idle_worker, args.reload_mcp,
        args.activate_idle_worker,
        args.report_outage, args.response_outage))
    generation_count = 1 if args.reload_mcp or args.activate_idle_worker else args.generations or 2
    state_root = Path(os.environ['DURE_HMUX_TEST_STATE_ROOT']).resolve(strict=True)
    assert state_root.name.startswith('dure-hmux-test.')
    root = state_root / 'codex-resources'
    root.mkdir(mode=0o700)
    prompts = [f'Resource lifecycle fixture turn {generation}. Complete this isolated turn without tools.'
               for generation in range(1, generation_count + 1)]
    if args.active_descendant:
        prompts[0] = ('Resource lifecycle fixture turn 1. Spawn one child for this isolated test, '
                      'then finish this parent turn while the child continues working.')
    (root / 'expected-prompts.json').write_text(json.dumps(prompts))
    profile = root / ('.codex' if args.automatic_hibernation else 'profile')
    profile.mkdir(mode=0o700)
    evidence = Path(tempfile.mkdtemp(prefix='dure-codex-resource-evidence-', dir=state_root.parent))
    print(json.dumps({'evidence': str(evidence)}), flush=True)
    driver = str(args.driver.resolve(strict=True))
    codex = str(args.codex.resolve(strict=True))
    runtime = str(Path(os.environ['DURE_QA_HMUX_RUNTIME']).resolve(strict=True))
    cli = str(Path(os.environ['DURE_QA_HMUX_BIN']).resolve(strict=True))
    initial_runtime = str(args.initial_runtime.resolve(strict=True)) if args.initial_runtime else runtime
    if args.initial_runtime:
        assert hashlib.sha256(Path(initial_runtime).read_bytes()).digest() != hashlib.sha256(Path(runtime).read_bytes()).digest(), (
            'Cross-build proof requires distinct source and target runtime artifacts')
    env = {'PATH': os.environ.get('PATH', os.defpath), 'TERM': 'xterm-256color',
           'HOME': str(root), 'CODEX_HOME': str(profile), 'CODEX_SQLITE_HOME': str(profile),
           'DURE_HOME': str(root), 'HMUX_DISCOVERY_ROOT': os.environ['HMUX_DISCOVERY_ROOT'],
           'DURE_HMUX_TEST_STATE_ROOT': str(state_root), 'TMPDIR': str(root)}
    report_runtime = root / 'report-runtime.sh'
    report_unavailable = root / 'report-unavailable'
    report_runtime.write_text('#!/bin/sh\n'
        f'if test -f {shlex.quote(str(report_unavailable))}; then exit 75; fi\n'
        f'exec {shlex.quote(runtime)} "$@"\n')
    report_runtime.chmod(0o700)
    mcp_command = sys.executable
    mcp_arguments = [str(REPO / 'scripts/qa/fixtures/codex-resource-mcp.py'), str(root)]
    counter_arguments = mcp_arguments.copy()
    if args.idle_worker:
        idle_root = state_root / 'mcp-idle'
        idle_root.mkdir(mode=0o700)
        catalogue = subprocess.run(['node', str(REPO / 'cli/lib/orchestration-mcp-server.mjs'), '--catalogue'],
                                   env=env, cwd=root, capture_output=True, text=True, timeout=10)
        assert catalogue.returncode == 0, catalogue.stderr
        catalogue_path = idle_root / 'catalogue.json'
        catalogue_path.write_text(catalogue.stdout)
        receipt = {'schemaVersion': 1, 'provider': 'codex', 'version': 'fixture-v1',
                   'digest': 'a' * 64, 'channel': 'test', 'capabilities': ['event_cursor_v1']}
        mcp_command = driver
        mcp_arguments = ['mcp-stdio-relay', '--node', str(Path(shutil.which('node')).resolve(strict=True)),
                         '--worker', str(REPO / 'scripts/qa/fixtures/orchestration-idle-worker.mjs'),
                         '--catalogue', str(catalogue_path), '--receipt-json', json.dumps(receipt),
                         '--idle-ms', '1000']
        if args.activate_idle_worker:
            updated = {'command': mcp_command, 'args': mcp_arguments,
                       'env_vars': ['DURE_HMUX_TEST_STATE_ROOT']}
            mcp_command = str(Path(shutil.which('node')).resolve(strict=True))
            mcp_arguments = [str(REPO / 'scripts/qa/fixtures/orchestration-idle-worker.mjs'),
                             '--receipt-json', json.dumps(receipt)]
            (root / 'idle-entry-update.json').write_text(json.dumps(updated))
    (profile / 'config.toml').write_text(
        'check_for_update_on_startup=false\n'
        + ('features.multi_agent=true\n' if args.active_descendant else '') +
        f'[projects.{json.dumps(str(root))}]\ntrust_level="trusted"\n'
        '[mcp_servers.resource_fixture]\n'
        f'command={json.dumps(mcp_command)}\n'
        f'args={json.dumps(mcp_arguments)}\n'
        'env_vars=["DURE_HMUX_TEST_STATE_ROOT"]\n')
    if args.reload_mcp or args.activate_idle_worker:
        with (profile / 'config.toml').open('a') as config:
            if args.reload_mcp:
                config.write('[mcp_servers.resource_fixture.env]\nDURE_QA_RESOURCE_MCP_TAG="v1"\n')
            config.write('[mcp_servers.keep]\n'
                         f'command={json.dumps(sys.executable)}\nargs={json.dumps(counter_arguments)}\n'
                         'env_vars=["DURE_HMUX_TEST_STATE_ROOT"]\n'
                         '[mcp_servers.keep.env]\nDURE_QA_RESOURCE_MCP_TAG="keep"\n')
    descendant = DescendantModel(MODEL_MODULE.ModelFixture, evidence) if args.active_descendant else None
    server = ThreadingHTTPServer(('127.0.0.1', 0), descendant.handler if descendant else MODEL_MODULE.ModelFixture)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    if args.automatic_hibernation:
        configuration = profile / 'config.toml'
        configuration.write_text(
            'model_provider="fixture"\n'
            'model_providers.fixture={name="fixture",base_url="http://127.0.0.1:%d/v1",wire_api="responses",requires_openai_auth=false}\n' % server.server_port
            + configuration.read_text())
    result = {'ok': False, 'realCredentialsUsed': False,
              'automaticHibernationEnabled': args.automatic_hibernation,
              'activeDescendant': args.active_descendant,
              'requestedGenerations': generation_count,
              'lateConversation': args.late_conversation,
              'pendingInput': args.pending_input,
              'restartIdleBackend': args.restart_idle_backend,
              'resumeInputReadiness': args.resume_input_readiness,
              'checkoutHead': subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', 'HEAD'], text=True).strip(),
              'artifacts': {name: {'path': path, 'sha256': hashlib.sha256(Path(path).read_bytes()).hexdigest()}
                            for name, path in [('driver', driver), ('codex', codex), ('hmux', cli), ('runtime', runtime),
                                               ('initialRuntime', initial_runtime)]},
              'fixtureSha256': {str(path.relative_to(REPO)): hashlib.sha256(path.read_bytes()).hexdigest()
                                for path in (Path(__file__).resolve(),
                                             REPO / 'scripts/qa/fixtures/codex-resource-mcp.py',
                                             REPO / 'scripts/qa/fixtures/codex-resource-processes.mjs',
                                             *([REPO / 'scripts/qa/fixtures/native_idle_backend.py',
                                                REPO / 'scripts/qa/fixtures/native-idle-backend-request.mjs'] if args.automatic_hibernation else []),
                                             *([REPO / 'scripts/qa/fixtures/codex_resource_descendants.py',
                                                REPO / 'scripts/qa/fixtures/codex-resource-descendants.mjs'] if args.active_descendant else []),
                                             *([REPO / 'scripts/qa/fixtures/codex-idle-worker.mjs',
                                                REPO / 'scripts/qa/fixtures/orchestration-idle-worker.mjs',
                                                REPO / 'cli/lib/orchestration-mcp-server.mjs'] if args.idle_worker else []),
                                             *([REPO / 'scripts/qa/fixtures/codex-mcp-reload.mjs'] if args.reload_mcp else []))},
              'idleWorker': args.idle_worker, 'liveActivation': False,
              'reloadMcp': args.reload_mcp,
              'activateIdleWorker': args.activate_idle_worker,
              'inflightTool': args.inflight_tool, 'disconnectHelper': args.disconnect_helper,
              'reportOutage': args.report_outage, 'responseOutage': args.response_outage,
              'generations': [], 'protection': []}

    def broker(operation, body, expected='completed', executable=None):
        encoded = json.dumps(body).encode()
        response = subprocess.run([executable or runtime, '--no-autostart', f'internal-hmux-managed-{operation}'],
                                  input=len(encoded).to_bytes(4, 'big') + encoded,
                                  capture_output=True, cwd=root, env=env, timeout=30)
        assert response.returncode == 0, response.stderr.decode()
        receipt = json.loads(response.stdout[4:])
        assert receipt['state'] == expected, receipt
        return receipt

    def stop_body(session_id, session, snapshot, stop_id):
        state = snapshot['agentRuntimeState']
        return {'schema': 'hmux-managed-stop-v1', 'schemaVersion': 5,
                'stopId': stop_id, 'sessionId': session_id, 'workspaceId': 'resource-workspace',
                'expectedRunnerPrincipal': session['runner_principal'], 'expectedRunnerInstance': session['runner_instance'],
                'expectedChannelEpoch': int(session['channel_epoch']), 'expectedHostInstanceId': session['host_instance_id'],
                'expectedTerminalEpoch': session['terminal_epoch'],
                'expectedConversation': {'providerId': 'codex',
                                         'conversationId': session['providerConversationIdentity']['conversation_id']},
                'expectedQuiescence': {'terminalEpoch': state['terminal_epoch'], 'runtimeRevision': int(state['revision']),
                                       'observedThroughOutputSeq': int(snapshot['sequenceThrough'])}}

    last_snapshot = None

    def command(*arguments):
        nonlocal last_snapshot
        response = subprocess.run([cli, '--discovery-root', env['HMUX_DISCOVERY_ROOT'], '--json', *arguments],
                                  cwd=root, env=env, capture_output=True, text=True, timeout=10)
        assert response.returncode == 0, response.stdout + response.stderr
        value = json.loads(response.stdout)
        if arguments[:2] == ('session', 'snapshot'):
            last_snapshot = value
            result['lastRuntimeState'] = value.get('agentRuntimeState')
        return value

    def observe(mode, generation, *arguments):
        response = subprocess.run(['node', str(REPO / 'scripts/qa/fixtures/codex-resource-processes.mjs'),
                                   mode, str(root), str(generation), *arguments], env=env, cwd=root,
                                  capture_output=True, text=True, timeout=40 if mode in ('prepare', 'call-idle', 'call-idle-activate', 'call-reload') else 10)
        (evidence / f'processes-{generation}-{mode}.json').write_text(response.stdout)
        assert response.returncode == 0, response.stderr
        return json.loads(response.stdout)

    def submit_input(session, text, submit=True):
        fence = {key: session[key] for key in ('workspace_id', 'session_id', 'runner_principal', 'runner_instance',
            'channel_epoch', 'host_instance_id', 'terminal_epoch')}
        return command('command-input', '--target', session['session_id'],
            '--workspace', 'resource-workspace', '--expected-fence-json', json.dumps(fence),
            '--text', text, *(['--submit'] if submit else []))

    def records():
        path = state_root / 'mcp-idle/events.jsonl' if args.idle_worker else root / 'mcp-events.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    conversation = None
    automatic = None
    try:
        # Compile the isolated observation helper before starting any provider.
        # Runtime observations keep their normal two-second deadline.
        observe('prepare', 1)
        if args.automatic_hibernation:
            automatic = NativeIdleBackend(root, env, driver, cli, runtime, codex, evidence,
                                          after_ms=60_000 if args.restart_idle_backend else 1000)
        for generation in range(1, generation_count + 1):
            session_id = f'codex-resources-{generation}'
            previous_endpoints = set(root.glob('dure-codex-*/client.sock'))
            argv = [driver, 'codex-native-driver', '--runtime', str(report_runtime), '--', codex,
                    '--no-alt-screen', '--sandbox', 'workspace-write', '--ask-for-approval', 'never',
                    '-m', 'gpt-5.6-sol', '-c', 'model_provider="fixture"', '-c',
                    'model_providers.fixture={name="fixture",base_url="http://127.0.0.1:%d/v1",wire_api="responses",requires_openai_auth=false}' % server.server_port,
                    *(['resume', conversation] if conversation else []),
                    prompts[generation - 1]]
            if automatic and generation > 1:
                if args.restart_idle_backend:
                    result.setdefault('dormantRestarts', []).append(automatic.verify_dormant_restart())
                session_id = automatic.wake(conversation)
                def input_target():
                    value = command('session', 'show', session_id, '--workspace', 'resource-workspace')
                    identity = value.get('providerConversationIdentity') or {}
                    state = value.get('agentRuntimeState') or {}
                    result['resumeInputObservation'] = {'identity': identity, 'runtime': state}
                    if identity.get('conversation_id') != conversation:
                        return None
                    if args.resume_input_readiness == 'provider' and not (
                        identity.get('source') == 'provider_event' and
                        state.get('source') == 'provider_event' and
                        state.get('activity') == 'waiting' and state.get('attention') == 'none'
                    ):
                        return None
                    return value
                resumed = wait(input_target)
                if args.pending_input:
                    result['draftInput'] = submit_input(resumed, argv[-1], submit=False)
                    result['draftInspection'] = command('session', 'show', session_id,
                                                        '--workspace', 'resource-workspace')
                    assert result['draftInspection']['agentRuntimeState']['activity'] == 'waiting'
                    result['draftProtection'] = automatic.observe_protection('hmux_controller_input_pending')
                    assert result['draftInspection']['controllerInputPending'] is True
                    result['draftRuntime'] = automatic.request('agent_runtime.projection.inspect', {
                        'schemaVersion': 1, 'agentId': automatic.agent_id,
                    })
                    assert result['draftRuntime']['state'] == 'stable', result['draftRuntime']
                result['resumedInput'] = submit_input(resumed, '' if args.pending_input else argv[-1])
            else:
                broker('create', {'schema': 'hmux-managed-create-v1', 'schemaVersion': 1,
                                 'idempotencyKey': session_id, 'sessionId': session_id, 'workspaceId': 'resource-workspace',
                                 'providerId': 'codex', 'permissionMode': 'default', 'providerCwd': str(root),
                                 'command': argv[:-1] if args.late_conversation else argv,
                                 'initialRows': 40, 'initialColumns': 120,
                                 **(automatic.creation_fields(argv) if automatic else {})},
                       executable=initial_runtime if generation == 1 else runtime)
                if args.late_conversation:
                    def fresh_input_target():
                        value = command('session', 'show', session_id, '--workspace', 'resource-workspace')
                        state = value.get('agentRuntimeState') or {}
                        return value if state.get('source') == 'provider_event' and state.get('activity') == 'waiting' else None
                    fresh = wait(fresh_input_target)
                    assert fresh.get('providerConversationIdentity') is None, fresh
                    automatic.bind(fresh)
                    initial = automatic.request('agent_runtime.projection.inspect', {
                        'schemaVersion': 1, 'agentId': automatic.agent_id,
                    })
                    assert initial['receipt']['providerConversationRef'] is None, initial
                    result['initialBinding'] = initial
                    result['firstInput'] = submit_input(fresh, argv[-1])
            if descendant and generation == 1:
                try:
                    assert descendant.started.wait(20), 'native child did not enter the loopback model'
                    session = command('session', 'show', session_id, '--workspace', 'resource-workspace')
                    conversation = session['providerConversationIdentity']['conversation_id']
                    endpoints = list(set(root.glob('dure-codex-*/client.sock')) - previous_endpoints)
                    assert len(endpoints) == 1, endpoints
                    result['descendantBefore'] = observe('descendant', generation, str(endpoints[0]), conversation)
                    protected = command('session', 'snapshot', session_id, '--workspace', 'resource-workspace')
                    assert protected['agentRuntimeState']['activity'] == 'working', protected
                    automatic.bind(session)
                    stopped = broker('stop', stop_body(session_id, session, protected,
                                                      f'descendant-stop-{session_id}'), 'refused')
                    assert stopped['payload']['code'] == 'hmux_managed_stop_unavailable', stopped
                    result['descendantStop'] = stopped
                    result['descendantProtection'] = automatic.observe_busy_protection()
                    result['descendantAfter'] = observe('descendant', generation, str(endpoints[0]), conversation)
                finally:
                    descendant.release.set()
            snapshot = wait(lambda: (value if ((value := command('session', 'snapshot', session_id,
                '--workspace', 'resource-workspace')).get('agentRuntimeState') or {}).get('turn_completed_count') in (1, '1') else None))
            session = command('session', 'show', session_id, '--workspace', 'resource-workspace')
            if args.initial_runtime:
                has_native_idle_age = 'semantic_idle_observation_v1' in session['capabilities']
                assert has_native_idle_age == (generation > 1), (
                    'Legacy-to-current wake did not switch the actual Host idle-clock capability', session)
            if args.pending_input and generation > 1:
                result['submittedInspection'] = session
                assert session['controllerInputPending'] is False, session
            identity = session['providerConversationIdentity']['conversation_id']
            assert conversation is None or identity == conversation, (identity, conversation)
            conversation = identity
            if automatic and generation == 1 and args.inflight_tool and not args.late_conversation:
                automatic.bind(session)
            endpoints = list(set(root.glob('dure-codex-*/client.sock')) - previous_endpoints)
            assert len(endpoints) == 1, endpoints
            if args.report_outage:
                report_unavailable.touch()
                before = len([event for event in records() if event['event'] in ('called', 'entered')])
                try:
                    observe('call-refused', generation, str(endpoints[0]), conversation)
                    assert len([event for event in records() if event['event'] in ('called', 'entered')]) == before
                finally:
                    report_unavailable.unlink()
            if args.inflight_tool:
                release = root / 'release-counter'
                # Each generation gets an independent in-flight request.
                if release.exists():
                    release.unlink()
                with subprocess.Popen(['node', str(REPO / 'scripts/qa/fixtures/codex-resource-processes.mjs'),
                                       'call-blocked-detach' if args.disconnect_helper else 'call-blocked',
                                       str(root), str(generation), str(endpoints[0]), conversation],
                                      env=env, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      stdin=subprocess.PIPE, text=True) as caller:
                    try:
                        wait(lambda: len([event for event in records() if event['event'] == 'entered']) == generation)
                        if args.disconnect_helper:
                            caller.stdin.write('disconnect\n')
                            caller.stdin.flush()
                            caller.wait(timeout=10)
                        protected = command('session', 'snapshot', session_id, '--workspace', 'resource-workspace')
                        protection = {'state': protected['agentRuntimeState']}
                        result['protection'].append(protection)
                        assert protected['agentRuntimeState']['activity'] == 'working', protected['agentRuntimeState']
                        protection['stop'] = broker('stop', stop_body(session_id, session, protected,
                                                                   f'busy-stop-{session_id}'), 'refused')
                        assert protection['stop']['payload']['code'] == 'hmux_managed_stop_unavailable'
                        if automatic:
                            protection['automatic'] = automatic.observe_busy_protection()
                    finally:
                        if args.response_outage:
                            report_unavailable.touch()
                        release.touch()
                        stdout, stderr = caller.communicate(timeout=15)
                        if args.response_outage:
                            report_unavailable.unlink()
                        (evidence / f'processes-{generation}-call.json').write_text(stdout)
                    assert caller.returncode == 0, stderr
            elif args.reload_mcp:
                observe('call-reload', generation, str(endpoints[0]), conversation)
            elif args.idle_worker:
                observe('call-idle-activate' if args.activate_idle_worker else 'call-idle',
                        generation, str(endpoints[0]), conversation, codex)
            else:
                observe('call', generation, str(endpoints[0]), conversation)
            if args.reload_mcp:
                called = [event for event in records() if event['event'] == 'called']
                assert len(called) == 5, called
            elif args.idle_worker:
                called = [event for event in records() if event['event'] == 'called']
                expected_calls = [1, 2, 1, 1] if args.activate_idle_worker else [1] * (generation * 2)
                assert [event['call'] for event in called] == expected_calls, called
                retained = command('session', 'show', session_id, '--workspace', 'resource-workspace')
                for key in ('runner_instance', 'host_instance_id', 'terminal_epoch', 'providerConversationIdentity'):
                    assert retained[key] == session[key], key
            else:
                called = wait(lambda: value if len(value := [event for event in records()
                              if event['event'] == 'called']) == generation else None)
                assert len(called) == generation and called[-1]['counter'] == 1, called
                observe('capture', generation)
            snapshot = wait(lambda: value if (value := command('session', 'snapshot', session_id,
                            '--workspace', 'resource-workspace'))['agentRuntimeState']['activity'] == 'waiting' else None)
            state = snapshot['agentRuntimeState']
            assert state['activity'] == 'waiting' and state['source'] == 'provider_event', state
            assert state['turn_completed_count'] in (1, '1'), state
            if automatic:
                if generation == 1 and not args.inflight_tool and not args.late_conversation and not descendant:
                    automatic.bind(session)
                if args.restart_idle_backend and generation <= (2 if args.initial_runtime else 1):
                    continuity = automatic.verify_idle_continuity(legacy=bool(args.initial_runtime and generation == 1))
                    result['backendIdleContinuity'] = continuity
                    result.setdefault('backendIdleContinuityByGeneration', {})[str(generation)] = continuity
                    observe('verify-live', generation)
                stop = automatic.wait_for_hibernation(conversation)
            else:
                stop = broker('stop', stop_body(session_id, session, snapshot, f'stop-{session_id}'))
            # This observation precedes guardian cleanup: product stop must own it.
            observe('verify-idle-exit' if args.idle_worker else 'verify-exit', generation)
            history = json.loads((root / f'history-{generation}.json').read_text())
            result['generations'].append({'conversationId': conversation, 'history': history,
                                          'stop': stop, 'mcp': called[-1],
                                          'hostInstanceId': session['host_instance_id'],
                                          'hostCapabilities': session['capabilities'],
                                          'semanticIdleMs': snapshot.get('semanticIdleMs')})
            if args.idle_worker:
                result['generations'][-1]['idleWorker'] = json.loads((root / f'idle-worker-{generation}.json').read_text())
            print(json.dumps({'type': 'resource_generation_verified', 'generation': generation,
                              'requestedGenerations': generation_count,
                              'conversationId': conversation, 'automatic': automatic is not None}), flush=True)
        result['ok'] = True
    except Exception as error:
        result['failure'] = {'type': type(error).__name__, 'message': str(error)}
        raise
    finally:
        if descendant:
            descendant.release.set()
        if last_snapshot is not None:
            (evidence / 'last-snapshot.json').write_text(json.dumps(last_snapshot))
        result['mcpEvents'] = records()
        for path in root.glob('idle-worker-*.json'):
            (evidence / path.name).write_bytes(path.read_bytes())
        if (root / 'mcp-reload.json').exists():
            (evidence / 'mcp-reload.json').write_bytes((root / 'mcp-reload.json').read_bytes())
        for path in root.glob('dure-codex-*/lifecycle.json'):
            (evidence / f'{path.parent.name}-lifecycle.json').write_bytes(path.read_bytes())
        (evidence / 'result.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result), flush=True)
        server.shutdown()
        server.server_close()
        worker.join()


if __name__ == '__main__':
    main()
