"""Single supervised spawn worker; no model/download/import side effects."""
import asyncio
import multiprocessing
import time
from .media import verify_image
from .detectors.test_detector import TestDetector


def process_image(payload, sender):
    try:
        verify_image(payload['path'], payload['mime'], payload['frame'])
        observations = TestDetector().detect(payload['frame'], payload['profile'])
        sender.send({'ok': True, 'observations': observations})
    except Exception:
        # Never return parser exceptions, filenames, image bytes or coordinates.
        sender.send({'ok': False, 'errorCode': 'invalid_image'})
    finally:
        sender.close()


class Jobs:
    def __init__(self, engine, worker=process_image):
        self.engine = engine
        self.worker = worker
        self.queue = asyncio.Queue(maxsize=engine.settings.queue_limit)
        self.task = None
        self.process = None

    def start(self):
        self.task = asyncio.create_task(self.run())

    async def stop(self):
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        if self.process is not None:
            if self.process.is_alive():
                self.process.terminate()
            self.process.join(timeout=3)
            self.process.close()
            self.process = None
        self.engine.interrupt_jobs()

    async def run(self):
        while True:
            domain, job_id = await self.queue.get()
            try:
                payload = self.engine.start_job(domain, job_id)
                if payload is None:
                    continue
                context = multiprocessing.get_context('spawn')
                receiver, sender = context.Pipe(duplex=False)
                process = context.Process(target=self.worker, args=(payload, sender), daemon=True)
                self.process = process
                result = None
                try:
                    process.start()
                    sender.close()
                    deadline = time.monotonic() + self.engine.settings.worker_timeout
                    while True:
                        if self.engine.job_cancelled(domain, job_id):
                            result = {'ok': False, 'errorCode': 'cancelled'}
                            break
                        if receiver.poll():
                            try:
                                result = receiver.recv()
                            except (EOFError, OSError):
                                result = {'ok': False, 'errorCode': 'worker_crashed'}
                            break
                        if not process.is_alive():
                            result = {'ok': False, 'errorCode': 'worker_crashed'}
                            break
                        if time.monotonic() >= deadline:
                            result = {'ok': False, 'errorCode': 'worker_timeout'}
                            break
                        await asyncio.sleep(0.02)
                except (EOFError, OSError):
                    result = {'ok': False, 'errorCode': 'worker_crashed'}
                except Exception:
                    result = {'ok': False, 'errorCode': 'worker_failed'}
                finally:
                    if process.pid is not None:
                        if process.is_alive():
                            process.terminate()
                        process.join(timeout=3)
                        process.close()
                    receiver.close()
                    sender.close()
                    self.process = None
                if result is not None:
                    self.engine.finish_job(domain, job_id, result)
            finally:
                self.queue.task_done()
