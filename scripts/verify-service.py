"""Check the running loopback service using only the Python standard library."""

import argparse
import json
import sys
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener

expected = {
    "status": "ok",
    "service": "local-voice-form-assistant",
    "version": "0.1.0",
    "inference": "not_integrated",
    "protocol_version": 1,
}

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--port", type=int, default=8765, help="Loopback service port (default: 8765)")
args = parser.parse_args()
if not 1 <= args.port <= 65535:
    parser.error("port must be between 1 and 65535")

try:
    # A local health check must bypass any machine-wide HTTP proxy.
    with build_opener(ProxyHandler({})).open(
        f"http://127.0.0.1:{args.port}/v1/health", timeout=5
    ) as response:
        payload = json.load(response)
        if response.status != 200 or payload != expected:
            sys.exit("Unexpected health response")
except (URLError, ValueError):
    sys.exit(f"Health check failed. Start the local service on 127.0.0.1:{args.port}.")

print(json.dumps(payload, indent=2))
print("Health response verified. Check the listener separately to confirm loopback binding.")
