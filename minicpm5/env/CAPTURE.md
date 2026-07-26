# Environment Capture

Capture every host used for a reported result:

```sh
uv run --frozen python scripts/capture_env.py \
  --output "env/captures/$(hostname)-$(date -u +%Y%m%dT%H%M%SZ).md"
```

The generated Markdown records UTC time, OS, kernel, architecture, CPU model,
logical core count, RAM, Python, NumPy's BLAS build metadata, thread-related
environment variables, and relevant library versions. Captures are ignored by
default because they may contain host-identifying details. Review and sanitize a
capture before force-adding it with `git add -f`; every reported result must link
to its reviewed capture.

The script supports x86-64 Linux through `/proc` and arm64 macOS through
`sysctl`. Missing tools or fields are recorded as `unavailable`, rather than
causing capture to fail.
