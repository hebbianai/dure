"""Public-API lifecycle adapter for the existing native resource fixture."""

import json
import os
from pathlib import Path
import shlex
import subprocess
import time
import uuid


class NativeIdleBackend:
    def __init__(self, root, environment, driver, cli, runtime, codex, evidence, after_ms=1000):
        assert root.name == 'codex-resources'
        assert root.parent.name.startswith('dure-hmux-test.')
        assert root.parent == Path(environment['DURE_HMUX_TEST_STATE_ROOT']).resolve(strict=True)
        assert root == Path(environment['DURE_HOME']).resolve(strict=True)
        assert root == Path(environment['HOME']).resolve(strict=True)
        self.root, self.evidence = root, evidence
        assert isinstance(after_ms, int) and 1000 <= after_ms <= 2_592_000_000
        self.environment = {**environment, 'DURE_SESSION_IDLE_AFTER_MS': str(after_ms)}
        executables = root / 'bin'
        executables.mkdir(mode=0o700)
        (executables / 'codex').symlink_to(codex)
        self.environment['PATH'] = str(executables) + os.pathsep + environment['PATH']
        # Supply the channel-owned launch reference the backend normally reads
        # from the app. Its wrapper invokes the same real driver as generation 1;
        # activity, stopping and replacement are not simulated by the fixture.
        wrapper = root / 'native-codex.sh'
        wrapper.write_text('#!/bin/sh\nexec ' + shlex.join([
            driver, 'codex-native-driver', '--runtime', runtime, '--',
        ]) + ' "$@"\n')
        wrapper.chmod(0o700)
        integration = root / 'managed-provider-integrations-v1.json'
        integration.write_text(json.dumps({'schemaVersion': 1, 'channel': 'stable',
            'integrations': {'codex': {'kind': 'command_wrapper', 'path': str(wrapper)}}}))
        integration.chmod(0o600)
        self.agent_id = 'automatic-native-resource-agent'
        self.asleep = None
        self.observations = []
        self.restarts = []
        self.log = (evidence / 'backend.log').open('w')
        # Inherit the existing QA supervisor's owned process group. The guardian
        # reaps this service after provider departure has been verified, including
        # on fixture failure; no detached bootstrap or independent cleanup owner.
        self.launch = [
            driver, 'serve', '--home', str(root), '--launch-executable', driver,
            '--hmux-bin', cli, '--hmux-runtime-bin', runtime,
            '--hmux-discovery-root', environment['HMUX_DISCOVERY_ROOT'],
        ]
        self.process = subprocess.Popen(self.launch, cwd=root, env=self.environment, stdin=subprocess.DEVNULL,
           stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 15
        while not (root / 'backend/control-plane.json').exists():
            assert self.process.poll() is None, 'isolated backend exited during startup'
            assert time.monotonic() < deadline, 'isolated backend descriptor timeout'
            time.sleep(.05)
        status = self.request('agent_runtime.idle.inspect', {'schemaVersion': 1})
        assert status['configuration'] == 'enabled' and status['afterMs'] == after_ms, status

    def restart(self, seed=None):
        descriptor_path = self.root / 'backend/control-plane.json'
        previous = json.loads(descriptor_path.read_text())
        assert previous['processId'] == self.process.pid and self.process.poll() is None
        self.request('backend.shutdown', {'schemaVersion': 2, 'mode': 'stop'})
        assert self.process.wait(timeout=15) == 0
        environment = {**self.environment}
        environment.pop('DURE_SESSION_IDLE_AFTER_MS', None)
        if seed is not None:
            environment['DURE_SESSION_IDLE_AFTER_MS'] = seed
        self.process = subprocess.Popen([*self.launch, '--expected-generation', previous['generation']],
            cwd=self.root, env=environment, stdin=subprocess.DEVNULL,
            stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 15
        while True:
            assert self.process.poll() is None, 'restart exited before publication'
            if descriptor_path.exists():
                current = json.loads(descriptor_path.read_text())
                if current['processId'] == self.process.pid:
                    # Same-artifact restart retains the logical backend generation;
                    # Popen.wait reaped the prior owned process before this launch.
                    assert current['generation'] == previous['generation']
                    assert current['observedAtMs'] > previous['observedAtMs']
                    break
            assert time.monotonic() < deadline, 'replacement descriptor timeout'
            time.sleep(.05)
        self.restarts.append({'before': previous, 'after': current, 'priorProcessExit': 0})
        (self.evidence / 'backend-restarts.json').write_text(json.dumps(self.restarts, indent=2))
        return self.request('agent_runtime.idle.inspect', {'schemaVersion': 1})

    def observe_idle_age(self, minimum_ms=0, observed_after_ms=0):
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            status = self.request('agent_runtime.idle.inspect', {'schemaVersion': 1})
            if (status['observedAtMs'] or 0) >= observed_after_ms:
                agent = next((entry for entry in status['agents'] if entry['agentId'] == self.agent_id), None)
                if agent is not None:
                    assert agent['state'] == 'observing', agent
                    if agent['observedIdleMs'] >= minimum_ms:
                        return {'observedAtMs': status['observedAtMs'], 'agent': agent}
            time.sleep(.5)
        raise AssertionError('No fresh eligible idle observation before backend replacement')

    def verify_idle_continuity(self, legacy=False):
        # A preceding activity scenario can leave a retained protected page.
        # Require a new scan before asserting idle; keep fresh protection fatal.
        # A legacy interval needs two actual scans. Its second sample can be
        # 14,999 ms after the first due to scan duration, so test positive
        # measured credit, not alignment with a timer's nominal 15,000 ms tick.
        before = self.observe_idle_age(minimum_ms=1 if legacy else 15_000,
            observed_after_ms=int(time.time() * 1000))
        projection = {'schemaVersion': 1, 'agentId': self.agent_id}
        source = self.request('agent_runtime.projection.inspect', projection)
        assert source['state'] == 'stable', source
        checkpoint_path = self.root / 'backend/runtime-idle-observations-v1.json'
        checkpoint = json.loads(checkpoint_path.read_text()) if legacy and checkpoint_path.exists() else None
        restarted = self.restart()
        after = self.observe_idle_age(observed_after_ms=before['observedAtMs'] + 1)
        retained = self.request('agent_runtime.projection.inspect', projection)
        evidence = {'before': before, 'after': after, 'policy': restarted,
                    'source': source, 'retained': retained, 'legacyCheckpoint': checkpoint}
        name = 'backend-legacy-idle-continuity.json' if legacy else 'backend-idle-continuity.json'
        (self.evidence / name).write_text(json.dumps(evidence, indent=2))
        assert retained == source, 'Backend replacement changed the stable native source'
        assert after['agent']['observedIdleMs'] >= before['agent']['observedIdleMs'], (
            'Backend replacement reset the unchanged native session idle age', evidence)
        if legacy:
            assert checkpoint is not None, 'Legacy continuity requires a retained measured observation'
            assert after['agent']['clockSource'] == 'backend_observed', evidence
            assert after['agent']['restoredFromCheckpoint'] is True, evidence
            assert after['agent']['observedIdleMs'] == checkpoint['observations'][self.agent_id]['measuredMs'], (
                'The first restarted scan must not credit backend downtime', evidence)
        return evidence

    def request(self, operation, body, request_id=None):
        request = {'requestId': request_id or str(uuid.uuid4()), 'operation': operation, 'body': body}
        response = subprocess.run([
            'node', str(Path(__file__).with_name('native-idle-backend-request.mjs')), str(self.root),
        ], input=json.dumps(request), text=True, capture_output=True,
           cwd=self.root, env=self.environment, timeout=40)
        assert response.returncode == 0, response.stderr
        receipt = json.loads(response.stdout)
        self.observations.append({'request': request, 'response': receipt})
        (self.evidence / 'automatic-backend.json').write_text(json.dumps(self.observations, indent=2))
        return receipt['result']

    @staticmethod
    def creation_fields(arguments):
        return {
            'schema': 'hmux-managed-create-v6', 'schemaVersion': 6,
            'providerStateEnvironment': {'CODEX_HOME': None, 'CODEX_SQLITE_HOME': None},
            'requiredManagedStopRequestVersion': 5,
            'managedRehostRecipe': {
                'schema': 'hmux-managed-rehost-recipe-v1', 'schemaVersion': 1,
                'commandTemplate': [*arguments[:-1], 'resume', '__HMUX_EXACT_CONVERSATION_ID__'],
            },
        }

    def bind(self, session):
        names = ('runner_principal', 'runner_instance', 'channel_epoch', 'host_instance_id', 'terminal_epoch')
        camel = ('runnerPrincipal', 'runnerInstance', 'channelEpoch', 'hostInstanceId', 'terminalEpoch')
        return self.request('agent_checkpoint.binding.ensure', {
            'schemaVersion': 1, 'agentId': self.agent_id,
            'sessionId': session['session_id'], 'workspaceId': session['workspace_id'],
            'displayName': 'Automatic native resource fixture', 'worktreePath': str(self.root),
            'stopFence': {key: str(session[name]) for key, name in zip(camel, names)},
        })

    def wait_for_hibernation(self, conversation):
        policy = self.request('agent_runtime.idle.inspect', {'schemaVersion': 1})
        assert policy['configuration'] == 'enabled' and 1000 <= policy['afterMs'] <= 60_000, policy
        # The restart scenario observes a full minute of native idle, unlike
        # the original one-second policy. Allow its threshold, one 15s scan
        # phase and one 15s stop/observation window; never shorten the policy.
        deadline = time.monotonic() + max(65, policy['afterMs'] / 1000 + 30)
        while time.monotonic() < deadline:
            observed = self.request('agent_runtime.projection.inspect', {
                'schemaVersion': 1, 'agentId': self.agent_id,
            })
            if observed.get('deferredTarget', {}).get('state') == 'waiting':
                assert observed['stage'] == 'source_stopped', observed
                self.asleep = observed
                outcome = self.inspect_outcome(observed, 'not_requested')
                return {'automatic': True, 'journal': observed, 'conversationId': conversation,
                        'outcome': outcome}
            time.sleep(1)
        status = self.request('agent_runtime.idle.inspect', {'schemaVersion': 1})
        raise AssertionError(f'No automatic hibernation without a cleanup request: {status}')

    def inspect_outcome(self, journal, wake_state):
        report = self.request('agent_runtime.idle.inspect', {'schemaVersion': 1})
        outcomes = report['reclamation']
        assert outcomes['schemaVersion'] == 1 and outcomes['state'] == 'available', outcomes
        assert outcomes['scope'] == 'latest_runtime_transition_admissions', outcomes
        assert outcomes['partial'] is False and outcomes['scanned'] <= outcomes['limit'], outcomes
        entries = [entry for entry in outcomes['entries']
                   if entry['operationId'] == journal['operationId']]
        assert len(entries) == 1, outcomes
        entry = entries[0]
        assert entry['agentId'] == self.agent_id and entry['providerId'] == 'codex', entry
        assert entry['stopState'] == 'completed' and entry['wakeState'] == wake_state, entry
        if wake_state == 'completed':
            assert entry['stage'] == 'committed', entry
            assert entry['journalRevision'] > journal['journalRevision'], (entry, journal)
        else:
            assert entry['journalRevision'] == journal['journalRevision'], (entry, journal)
        assert entry['sourceSessionId'] is not None, entry
        return entry

    def verify_dormant_restart(self):
        assert self.asleep is not None
        before = self.inspect_outcome(self.asleep, 'not_requested')
        self.restart()
        retained = self.request('agent_runtime.projection.inspect', {
            'schemaVersion': 1, 'agentId': self.agent_id,
        })
        assert retained == self.asleep, 'Backend restart changed or woke the dormant transition'
        after = self.inspect_outcome(retained, 'not_requested')
        assert after == before, 'Backend restart changed the durable outcome'
        evidence = {'before': before, 'after': after, 'retained': retained}
        (self.evidence / f'dormant-restart-{before["operationId"]}.json').write_text(
            json.dumps(evidence, indent=2))
        return evidence

    def observe_busy_protection(self):
        return self.observe_protection('hmux_agent_runtime_not_quiescent')

    def observe_protection(self, reason_code):
        # A retained page newer than the request proves the real coordinator
        # scanned the source while the native tool was still held. The existing
        # MCP fixture holds at most 20 seconds, so release after one real scan
        # rather than waiting for a second 15-second tick after the tool expires.
        started_at_ms = int(time.time() * 1000)
        deadline = time.monotonic() + 18
        while time.monotonic() < deadline:
            status = self.request('agent_runtime.idle.inspect', {'schemaVersion': 1})
            observed_at = status['observedAtMs']
            if observed_at is not None and observed_at >= started_at_ms:
                agent = next((entry for entry in status['agents'] if entry['agentId'] == self.agent_id), None)
                assert agent is not None, status
                assert agent['state'] == 'protected', agent
                assert agent['reasonCode'] == reason_code, agent
                return {'observedAtMs': observed_at, 'agent': agent}
            time.sleep(1)
        raise AssertionError(f'No authoritative protection scan for {reason_code}')

    def wake(self, conversation):
        assert self.asleep is not None
        body = {'schemaVersion': 1, 'agentId': self.agent_id,
                'operationId': self.asleep['operationId'],
                'expectedJournalRevision': self.asleep['journalRevision'],
                'expectedProviderConversationRef': conversation}
        request_id = f"wake-{self.asleep['operationId']}"
        awake = self.request('agent_runtime.wake', body, request_id)
        assert awake['receipt']['providerConversationRef'] == conversation, awake
        completed = self.inspect_outcome(self.asleep, 'completed')
        assert self.request('agent_runtime.wake', body, request_id) == awake
        assert self.inspect_outcome(self.asleep, 'completed') == completed
        authority = awake['receipt']['authority']['authority']
        assert authority['runtimeWorkspaceId'] == 'resource-workspace', authority
        return authority['binding']['sessionId']
