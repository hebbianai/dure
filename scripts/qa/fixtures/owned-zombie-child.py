import json
import os
import signal
import sys
import time


signal.alarm(20)
reader, writer = os.pipe()
child = os.fork()
if child == 0:
    os.close(writer)
    os.read(reader, 1)
    os._exit(0)

os.close(reader)
print(json.dumps({"leader": os.getpid(), "child": child}), flush=True)
sys.stdin.readline()
os.write(writer, b"exit")
os.close(writer)
# Retain the exited child until the exact group cleanup retires this parent.
while True:
    time.sleep(1)
