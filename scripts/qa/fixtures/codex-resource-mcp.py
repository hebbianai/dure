"""Disposable STDIO MCP with an observable, process-local counter."""

import json
import os
from pathlib import Path
import sys
import time

root = Path(sys.argv[1]).resolve(strict=True)
assert root == Path(os.environ['DURE_HMUX_TEST_STATE_ROOT']).resolve() / 'codex-resources'
assert root.parent.name.startswith('dure-hmux-test.')
counter = 0


def record(event, **values):
    with (root / 'mcp-events.jsonl').open('a') as output:
        output.write(json.dumps({'event': event, 'pid': os.getpid(),
                                 'parentPid': os.getppid(), 'sessionId': os.getsid(0),
                                 'tag': os.environ.get('DURE_QA_RESOURCE_MCP_TAG', 'default'), **values}) + '\n')


record('started')
for line in sys.stdin:
    request = json.loads(line)
    initialization = {'protocolVersion': request['params']['protocolVersion']} \
        if request.get('method') == 'initialize' else {}
    record('request', method=request.get('method'), **initialization)
    if 'id' not in request:
        continue
    method = request.get('method')
    if method == 'initialize':
        result = {'protocolVersion': request['params']['protocolVersion'],
                  'capabilities': {'tools': {}}, 'serverInfo': {'name': 'resource-fixture', 'version': '1'}}
    elif method == 'tools/list':
        result = {'tools': [{'name': 'counter', 'description': 'Increment the isolated resource fixture counter.',
                             'inputSchema': {'type': 'object', 'properties': {'hold': {'type': 'boolean'}},
                                             'additionalProperties': False}}]}
    elif method == 'tools/call' and request['params']['name'] == 'counter':
        if request['params'].get('arguments', {}).get('hold'):
            record('entered')
            deadline = time.monotonic() + 20
            while not (root / 'release-counter').exists():
                assert time.monotonic() < deadline, 'fixture tool was not released'
                time.sleep(.02)
        counter += 1
        record('called', counter=counter)
        result = {'content': [{'type': 'text', 'text': f'resource-counter-{counter}'}]}
    elif method == 'ping':
        result = {}
    else:
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'],
                          'error': {'code': -32601, 'message': 'Unsupported fixture method'}}), flush=True)
        continue
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
record('eof')
