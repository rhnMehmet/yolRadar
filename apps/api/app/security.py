"""Local development credentials are provisioned out of band, never in source."""
from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import secrets
from fastapi import Request
from .contracts import ApiError, identifier

DOMAINS = ('REAL', 'SIM', 'REPLAY')


@dataclass(frozen=True)
class Principal:
    id: str
    digest: str = field(repr=False)
    domains: tuple[str, ...] = DOMAINS
    reviewer: bool = False

    @classmethod
    def create(cls, user_id, token, domains=DOMAINS, reviewer=False):
        identifier(user_id)
        if not isinstance(token, str) or len(token) < 32 or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise ValueError('A random development token of at least 32 ASCII characters is required')
        if not domains or not set(domains) <= set(DOMAINS) or type(reviewer) is not bool:
            raise ValueError('Invalid server-side principal permissions')
        return cls(user_id, hashlib.sha256(token.encode()).hexdigest(), tuple(domains), reviewer)


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    principals: tuple[Principal, ...]
    queue_limit: int = 8
    worker_timeout: float = 20.0
    upload_timeout: float = 30.0
    retention_seconds: int = 24 * 60 * 60
    max_media_bytes: int = 256 * 1024 * 1024
    allowed_origins: tuple[str, ...] = ('http://127.0.0.1:5173', 'http://localhost:5173')
    profile: str = 'TEST'

    def __post_init__(self):
        project = Path(__file__).resolve().parents[3]
        if self.data_dir.resolve().is_relative_to(project) or self.profile != 'TEST':
            raise ValueError('M2 requires TEST profile and data outside the repository')
        if not self.principals or len({p.id for p in self.principals}) != len(self.principals) or len({p.digest for p in self.principals}) != len(self.principals):
            raise ValueError('Unique server-side credentials are required')
        if not 1 <= self.queue_limit <= 8 or self.worker_timeout <= 0 or self.upload_timeout <= 0:
            raise ValueError('Invalid bounded worker settings')

    @classmethod
    def from_env(cls):
        auth_file = os.environ.get('ROADSENSE_API_AUTH_FILE')
        if not auth_file:
            raise RuntimeError('ROADSENSE_API_AUTH_FILE must reference a private local credential file')
        auth_path = Path(auth_file).resolve()
        project = Path(__file__).resolve().parents[3]
        if auth_path.is_relative_to(project):
            raise ValueError('Credentials must remain outside source control')
        entries = json.loads(auth_path.read_text(encoding='utf-8-sig'))
        principals = tuple(Principal.create(item['id'], item['token'], item['domains'], item.get('reviewer', False)) for item in entries)
        root = Path(os.environ.get('ROADSENSE_API_DATA_DIR', str(Path(os.environ['LOCALAPPDATA']) / 'RoadSense/api-data')))
        return cls(root, principals)


def authenticate(request: Request) -> Principal:
    header = request.headers.get('authorization', '')
    if not header.startswith('Bearer ') or len(header) > 512:
        raise ApiError(401, 'authentication_required')
    digest = hashlib.sha256(header[7:].encode()).hexdigest()
    matches = [principal for principal in request.app.state.settings.principals if secrets.compare_digest(principal.digest, digest)]
    if len(matches) != 1:
        raise ApiError(401, 'authentication_required')
    return matches[0]
