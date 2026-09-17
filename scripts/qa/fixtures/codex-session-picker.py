"""Native picker interaction inside the managed Codex smoke's owned PTY."""

import json
import re
import time


def check(command, exact, session, root, evidence, model_requests):
    capture = root / 'provider-output.bin'

    def inspect():
        return command(['session', 'show', session['session_id'], '--workspace', session['workspace_id']])

    before = inspect()
    identity = before['providerConversationIdentity']
    assert identity, 'the completed fixture must have a provider conversation'
    receipt = {'ok': False, 'steps': [], 'conversation': identity, 'before': before['agentRuntimeState'],
               'realCredentialsUsed': False}

    def interact(label, args, expected, *, starts_turn=False):
        offset = capture.stat().st_size
        command(['command-input', *exact, *args])
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            plain = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', capture.read_bytes()[offset:])
            assert b'Failed to start TUI session picker' not in plain, 'native /resume could not connect its picker'
            if all(text in plain for text in expected):
                current = inspect()
                assert current['providerConversationIdentity'] == identity, 'picker changed the retained conversation'
                receipt['steps'].append({'action': label, 'state': current['agentRuntimeState']})
                if not starts_turn:
                    state = current['agentRuntimeState']
                    assert state['activity'] == 'waiting' and state['source'] == 'provider_event', state
                    assert state['turn_completed_count'] == receipt['before']['turn_completed_count'], state
                return
            time.sleep(.05)
        raise AssertionError(f'native picker did not finish {label}')

    picker = [b'Resume a previous session', b'Wait for the fixture response']
    prompt = [b'Ask Codex to do anything']
    try:
        interact('open', ['--text', '/resume', '--submit'], picker)
        interact('cancel', ['--key', 'Escape'], prompt)
        interact('reopen', ['--text', '/resume', '--submit'], picker)
        interact('select current conversation', ['--key', 'Enter'], [*prompt, b'Already viewing'])
        interact('reopen after selection', ['--text', '/resume', '--submit'], picker)
        interact('cancel after selection', ['--key', 'Escape'], prompt)
        receipt['requestsBeforeNextTurn'] = model_requests()
        interact('submit next turn', ['--text', 'Continue after the picker. Do not call tools.', '--submit'], [b'Continue after the picker.'], starts_turn=True)
        expected_count = int(receipt['before']['turn_completed_count']) + 1
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            after = inspect()['agentRuntimeState']
            if int(after['turn_completed_count']) == expected_count:
                break
            time.sleep(.05)
        assert after['source'] == 'provider_event' and after['activity'] == 'waiting', after
        assert int(after['turn_completed_count']) == expected_count, after
        receipt.update(ok=True, after=after, modelRequests=model_requests())
    finally:
        (evidence / 'picker-result.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps(receipt), flush=True)
