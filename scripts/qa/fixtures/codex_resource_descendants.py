"""A loopback model that keeps one real Codex child busy after its parent answers."""

import io
import json
import threading
import time


CHILD_PROMPT = 'Dure isolated descendant fixture: finish only when the model responds.'


class DescendantModel:
    def __init__(self, base_handler, evidence):
        self.started = threading.Event()
        self.release = threading.Event()
        self.lock = threading.Lock()
        self.spawned = False
        self.events = []
        self.evidence = evidence
        scenario = self

        class Handler(base_handler):
            def do_POST(self):
                size = int(self.headers.get('Content-Length', '0'))
                if size > 1024 * 1024 or not self.path.endswith('/responses'):
                    self.send_error(400)
                    return
                encoded = self.rfile.read(size)
                request = json.loads(encoded)
                user_texts = [content.get('text', '')
                              for item in request.get('input', []) if item.get('role') == 'user'
                              for content in item.get('content', []) if isinstance(content, dict)]
                agent_messages = [item for item in request.get('input', [])
                                  if item.get('type') == 'agent_message']
                child_request = any(content.get('encrypted_content') == CHILD_PROMPT
                                    for item in agent_messages
                                    if item.get('author') == '/root' and item.get('recipient') == '/root/resource_child'
                                    for content in item.get('content', []))
                scenario.record({'event': 'model_request', 'model': request.get('model'),
                                 'agentMessages': agent_messages,
                                 'toolOutputs': [item for item in request.get('input', [])
                                                 if item.get('type') == 'function_call_output']})
                if child_request:
                    scenario.record({'event': 'child_model_started'})
                    scenario.started.set()
                    if not scenario.release.wait(45):
                        scenario.record({'event': 'child_release_timeout'})
                        self.send_error(504)
                        return
                    scenario.record({'event': 'child_model_released'})
                elif any(text.startswith('Resource lifecycle fixture turn ') for text in user_texts):
                    with scenario.lock:
                        spawn = not scenario.spawned
                        scenario.spawned = True
                    if spawn:
                        tools = [tool for item in request.get('input', [])
                                 if item.get('type') == 'additional_tools'
                                 for namespace in item.get('tools', [])
                                 if namespace.get('type') == 'namespace' and namespace.get('name') == 'collaboration'
                                 for tool in namespace.get('tools', [])]
                        tool = next((tool for tool in tools if tool.get('name') == 'spawn_agent'), None)
                        scenario.record({'event': 'parent_spawn',
                                         'tool': {key: tool[key] for key in ('type', 'name', 'parameters')}
                                         if tool else None})
                        if tool is None:
                            self.send_error(400, 'Native spawn_agent tool unavailable')
                            return
                        assert set(tool['parameters']['required']) == {'task_name', 'message'}, tool
                        self.spawn_child()
                        return
                    scenario.record({'event': 'parent_model_completed'})
                self.rfile = io.BytesIO(encoded)
                super().do_POST()

            def spawn_child(self):
                item = {'id': 'fc_descendant_fixture', 'type': 'function_call',
                        'call_id': 'call_descendant_fixture', 'namespace': 'collaboration', 'name': 'spawn_agent',
                        'arguments': json.dumps({'message': CHILD_PROMPT, 'task_name': 'resource_child',
                                                 'fork_turns': 'none'}),
                        'status': 'completed'}
                response = {'id': 'resp_descendant_fixture', 'object': 'response',
                            'created_at': 1, 'status': 'completed', 'output': [item],
                            'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}
                events = [
                    {'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
                    {'type': 'response.output_item.added', 'output_index': 0,
                     'item': {**item, 'status': 'in_progress', 'arguments': ''}},
                    {'type': 'response.function_call_arguments.delta', 'item_id': item['id'],
                     'output_index': 0, 'delta': item['arguments']},
                    {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                    {'type': 'response.completed', 'response': response},
                ]
                body = ''.join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
                               for event in events).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.handler = Handler

    def record(self, event):
        with self.lock:
            self.events.append({'observedAtMs': int(time.time() * 1000), **event})
            (self.evidence / 'descendant-model.json').write_text(json.dumps(self.events, indent=2))
