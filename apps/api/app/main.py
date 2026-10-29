"""Create with --factory. Only loopback startup is documented and supported in M2."""
from contextlib import asynccontextmanager
import sqlite3
from uuid import uuid4
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from .contracts import ApiError
from .jobs import process_image
from .routes import analysis, candidates, review, sessions
from .security import Settings
from .sessions import Engine


class BodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        limit = 8 * 1024 * 1024 if scope['method'] == 'PUT' and scope['path'].endswith('/content') else 128 * 1024
        total = 0

        async def bounded_receive():
            nonlocal total
            message = await receive()
            if message['type'] == 'http.request':
                total += len(message.get('body', b''))
                if total > limit:
                    raise ApiError(413, 'request_body_too_large')
            return message

        async def private_send(message):
            if message['type'] == 'http.response.start':
                headers = [(key, value) for key, value in message.get('headers', []) if key.lower() not in (b'cache-control', b'x-content-type-options')]
                message = {**message, 'headers': headers + [(b'cache-control', b'no-store'), (b'x-content-type-options', b'nosniff')]}
            await send(message)

        return await self.app(scope, bounded_receive, private_send)


def create_app(settings=None, *, worker=process_image):
    settings = settings or Settings.from_env()
    engine = Engine(settings, worker)

    @asynccontextmanager
    async def lifespan(app):
        acquired = False
        try:
            engine.store.acquire()
            acquired = True
            engine.jobs.start()
            yield
        finally:
            try:
                if acquired:
                    await engine.jobs.stop()
            finally:
                engine.store.close()

    app = FastAPI(title='RoadSense TEST API', version='0.1.0', lifespan=lifespan,
        description='Development only. TestDetector produces TEST_SYNTHETIC fixtures, never YOLO predictions.',
        telemetry={'tracing': False, 'metrics': False, 'logs': False, 'operation_spans': False, 'auto_configure': False},
        docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings, app.state.engine = settings, engine
    app.add_middleware(BodyLimit)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost', 'testserver'])
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.allowed_origins),
        allow_credentials=False, allow_methods=['GET', 'POST', 'PUT'], allow_headers=['Authorization', 'Content-Type'])

    @app.exception_handler(ApiError)
    async def policy_error(request: Request, error: ApiError):
        return JSONResponse(status_code=error.status, content={'error': {'code': error.code, 'requestId': uuid4().hex}},
            headers={'Cache-Control': 'no-store', **({'WWW-Authenticate': 'Bearer'} if error.status == 401 else {})})

    async def invalid_contract(request: Request, error):
        # Deliberately exclude Pydantic input/context and exception strings.
        return JSONResponse(status_code=422, content={'error': {'code': 'invalid_contract', 'requestId': uuid4().hex}}, headers={'Cache-Control': 'no-store'})

    app.add_exception_handler(RequestValidationError, invalid_contract)
    app.add_exception_handler(ValidationError, invalid_contract)
    app.add_exception_handler(ValueError, invalid_contract)

    @app.exception_handler(sqlite3.Error)
    async def database_error(request: Request, error):
        return JSONResponse(status_code=503, content={'error': {'code': 'storage_unavailable', 'requestId': uuid4().hex}})

    @app.get('/health')
    def health():
        return {'status': 'ok', 'profile': 'TEST', 'resultLabel': 'TEST_SYNTHETIC', 'contractVersion': 1}

    # The schema contains no credentials/media and is useful to M3; no hosted docs scripts.
    @app.get('/openapi.json', include_in_schema=False)
    def openapi():
        schema = app.openapi()
        schema.setdefault('components', {})['securitySchemes'] = {'LocalBearer': {'type': 'http', 'scheme': 'bearer', 'description': 'Locally provisioned development token; not a JWT or production identity provider.'}}
        for path, operations in schema['paths'].items():
            if path.startswith('/v1/'):
                for operation in operations.values():
                    if isinstance(operation, dict) and 'responses' in operation:
                        operation['security'] = [{'LocalBearer': []}]
        return schema

    app.include_router(sessions.router)
    app.include_router(analysis.router)
    app.include_router(candidates.router)
    app.include_router(review.router)
    return app
