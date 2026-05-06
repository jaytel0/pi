# Tests

## Mock integration

```bash
python3 tests/mock-openai-fast-test.py
```

Starts a local Responses-compatible server and asserts:

- Fast off omits `service_tier`.
- Fast on for `openai/gpt-5.5` sends `service_tier: "priority"`.
- Unsupported models are not modified.
- If an endpoint honors `priority`, Pi receives a faster response.

## Real endpoint benchmark

```bash
OPENAI_API_KEY=... python3 tests/real-endpoint-benchmark.py
```

Optional:

```bash
PI_FAST_TEST_MODEL=openai/gpt-5.5
PI_FAST_TEST_THINKING=low
PI_FAST_TEST_PROVIDER_EXTENSIONS=/path/to/provider-extension.ts
```

Prints:

- Payload assertions.
- Redacted token metadata only.
- Interleaved standard vs Fast end-to-end timings.

Real endpoint latency is noisy; use several runs before drawing conclusions.
