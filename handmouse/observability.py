"""Sentry for the hand mouse: crashes, profiling, and every few seconds a trace of one frame's pipeline
(camera -> hand tracking -> gestures -> mouse), which shows what limits the frame rate.
Does nothing until SENTRY_DSN is set (in the environment or the project's .env)."""
import contextlib
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _dsn():
    dsn = os.environ.get('SENTRY_DSN', '').strip()
    if dsn:
        return dsn
    try:
        with open(os.path.join(ROOT, '.env'), encoding='utf-8') as f:
            for line in f:
                key, sep, value = line.strip().partition('=')
                if sep and key.strip() == 'SENTRY_DSN':
                    return value.strip().strip('"').strip("'")
    except OSError:
        pass
    return ''


class _NoFrame:
    def span(self, op):
        return contextlib.nullcontext()

    def set(self, key, value):
        pass


class _Frame:
    def __init__(self, tx):
        self.tx = tx

    def span(self, op):
        return self.tx.start_child(op=op, name=op)

    def set(self, key, value):
        self.tx.set_data(key, value)


class Tracer:
    """frame() gives a real trace every `every` frames and a do-nothing one otherwise."""

    def __init__(self, every=90):
        self.sdk, self.every, self.n = None, every, 0
        dsn = _dsn()
        if not dsn:
            return
        import sentry_sdk
        sentry_sdk.init(dsn=dsn, environment='hackathon', release='holomodel@0.1.0', traces_sample_rate=1.0,
                        profile_session_sample_rate=1.0, profile_lifecycle='trace', enable_logs=True)
        self.sdk = sentry_sdk
        print('Sentry: on (errors, frame traces, profiling)')

    @property
    def on(self):
        return self.sdk is not None

    @contextlib.contextmanager
    def frame(self):
        self.n += 1
        if not self.sdk or self.n % self.every:
            yield _NoFrame()
            return
        with self.sdk.start_transaction(op='handmouse.frame', name='hand mouse frame') as tx:
            yield _Frame(tx)

    def log(self, message, **attrs):
        if self.sdk:
            self.sdk.logger.info(message, attributes=attrs)
