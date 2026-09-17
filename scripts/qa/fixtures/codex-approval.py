"""Loopback model response that asks the real Codex TUI for command approval."""
import json
import threading

continued = threading.Event()
release = threading.Event()


def respond(handler, request_number, size):
    handler.rfile.read(size)
    if request_number == 1:
        item = {
            'id': 'fc_approval_fixture', 'type': 'function_call',
            'call_id': 'call_approval_fixture', 'name': 'exec_command',
            'arguments': json.dumps({
                'cmd': 'echo DURE_APPROVAL_FIXTURE',
                'sandbox_permissions': 'require_escalated',
                'justification': 'Allow this isolated fixture to print its marker?',
            }),
            'status': 'completed',
        }
    else:
        continued.set()
        if not release.wait(30):
            handler.send_error(500)
            return
        item = {
            'id': 'msg_approval_fixture', 'type': 'message', 'role': 'assistant',
            'status': 'completed', 'content': [{
                'type': 'output_text', 'text': 'Approval fixture complete.', 'annotations': [],
            }],
        }
    response = {
        'id': f'resp_approval_{request_number}', 'object': 'response', 'created_at': 1,
        'status': 'completed', 'output': [item],
        'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2},
    }
    events = [
        {'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
        {'type': 'response.output_item.added', 'output_index': 0, 'item': item},
        {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
        {'type': 'response.completed', 'response': response},
    ]
    body = ''.join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()
    handler.send_response(200)
    handler.send_header('Content-Type', 'text/event-stream')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def check(command, exact, state, root, before, wait):
    # Screen text is only fixture proof that the provider really opened its
    # approval UI; production projection consumes ordered provider events.
    wait(lambda: b'Would you like to run' in (root / 'provider-output.bin').read_bytes(), 20)
    waiting = state()
    assert waiting['activity'] == 'waiting', waiting
    assert waiting['attention'] == 'approval_required', waiting
    assert waiting['turn_completed_count'] == before['turn_completed_count'], waiting
    assert state() == waiting, 'a fresh Host observer lost approval attention'
    command(['command-input', *exact, '--key', 'Enter'])
    wait(continued.is_set, 20)
    resumed = wait(lambda: (current if (current := state())['activity'] == 'working' else None))
    assert resumed['attention'] == 'none', resumed
    assert resumed['turn_completed_count'] == before['turn_completed_count'], resumed
    release.set()
    return {'waiting': waiting, 'resumed': resumed}
