#!/usr/bin/env python3
"""xo-coworker lite: the parent folder's serve.py, serving this folder instead.

    python3 lite/serve.py            # http://127.0.0.1:5181
    PORT=5182 XO_API=http://127.0.0.1:5002 python3 lite/serve.py

Same proxy, same guards (same-origin check, route denylist, body caps, SSE relay).
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("PORT", "5181")
sys.path.insert(0, os.path.dirname(HERE))

import serve  # noqa: E402  (the full UI's server; Handler reads serve.ROOT on every request)

serve.ROOT = HERE

if __name__ == "__main__":
    serve.main()
