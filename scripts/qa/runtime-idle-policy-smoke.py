"""Restart proof using the public backend API and the existing QA guardian."""

import json
import os
from pathlib import Path
import sys
import tempfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent / 'fixtures'))
from native_idle_backend import NativeIdleBackend


def main():
    state_root = Path(os.environ['DURE_HMUX_TEST_STATE_ROOT']).resolve(strict=True)
    assert state_root.name.startswith('dure-hmux-test.')
    root = state_root / 'codex-resources'
    root.mkdir(mode=0o700)
    evidence = Path(tempfile.mkdtemp(prefix='dure-idle-policy-evidence-', dir=state_root.parent))
    print(json.dumps({'evidence': str(evidence)}), flush=True)
    environment = {
        'PATH': os.environ.get('PATH', os.defpath), 'HOME': str(root), 'DURE_HOME': str(root),
        'HMUX_DISCOVERY_ROOT': os.environ['HMUX_DISCOVERY_ROOT'],
        'DURE_HMUX_TEST_STATE_ROOT': str(state_root), 'TMPDIR': str(root),
    }
    backend = NativeIdleBackend(root, environment, str(Path(sys.argv[1]).resolve(strict=True)),
        os.environ['DURE_QA_HMUX_BIN'], os.environ['DURE_QA_HMUX_RUNTIME'], '/usr/bin/true', evidence)
    restarted = backend.restart()
    assert restarted['configuration'] == 'enabled' and restarted['afterMs'] == 1000, (
        'Restart without launch environment lost automatic idle policy', restarted)
    revision = restarted['policyRevision']
    disabled = backend.request('agent_runtime.idle.configure', {
        'schemaVersion': 1, 'expectedRevision': revision, 'policy': {'mode': 'disabled'},
    })
    assert disabled['configuration'] == 'disabled' and disabled['policyRevision'] == revision + 1
    restarted = backend.restart('1000')
    assert restarted['configuration'] == 'disabled', 'Stored disable must override launch environment'
    assert restarted['policyRevision'] == revision + 1
    backend.request('backend.shutdown', {'schemaVersion': 2, 'mode': 'stop'})
    assert backend.process.wait(timeout=15) == 0
    print(json.dumps({'result': 'passed', 'policyRevision': restarted['policyRevision']}), flush=True)


if __name__ == '__main__':
    main()
