"""One TEST partition database per source domain; all writes are transactional."""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import time
import msvcrt
from .contracts import ApiError
from .security import DOMAINS


class Store:
    def __init__(self, settings):
        self.settings = settings
        self.root = settings.data_dir.resolve() / 'TEST'
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = None
        self.locked = False

    def acquire(self):
        self.lock = (self.root / 'instance.lock').open('a+b')
        try:
            if self.lock.seek(0, 2) == 0:
                self.lock.write(b'0')
                self.lock.flush()
            self.lock.seek(0)
            msvcrt.locking(self.lock.fileno(), msvcrt.LK_NBLCK, 1)
            self.locked = True
        except OSError:
            self.lock.close()
            self.lock = None
            raise RuntimeError('Another RoadSense API instance owns this data directory') from None
        for domain in DOMAINS:
            folder = self.folder(domain)
            folder.mkdir(parents=True, exist_ok=True)
            (folder / 'media').mkdir(exist_ok=True)
            with self.tx(domain) as db:
                if db.execute('PRAGMA user_version').fetchone()[0] not in (0, 1):
                    raise RuntimeError('Unsupported database schema; no automatic migration')
                db.execute('PRAGMA user_version=1')
                db.execute('CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, sid TEXT NOT NULL, run TEXT NOT NULL, payload TEXT NOT NULL, created REAL NOT NULL, PRIMARY KEY(kind,id))')
                db.execute('CREATE INDEX IF NOT EXISTS records_scope ON records(kind,owner,sid,run)')
            self.recover(domain)

    def close(self):
        if self.lock is not None:
            try:
                if self.locked:
                    self.lock.seek(0)
                    msvcrt.locking(self.lock.fileno(), msvcrt.LK_UNLCK, 1)
            finally:
                self.lock.close()
                self.lock = None
                self.locked = False

    def folder(self, domain):
        if domain not in DOMAINS:
            raise ApiError(403, 'domain_not_allowed')
        return self.root / domain

    @contextmanager
    def tx(self, domain):
        db = sqlite3.connect(self.folder(domain) / 'api.sqlite3', timeout=3, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('PRAGMA synchronous=FULL')
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.execute('COMMIT')
        except BaseException:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        finally:
            db.close()

    @staticmethod
    def get(db, kind, key):
        row = db.execute('SELECT * FROM records WHERE kind=? AND id=?', (kind, key)).fetchone()
        return dict(row, payload=json.loads(row['payload'])) if row else None

    @staticmethod
    def find(db, kind, *, owner=None, sid=None, run=None):
        filters, args = ['kind=?'], [kind]
        for key, value in [('owner', owner), ('sid', sid), ('run', run)]:
            if value is not None:
                filters.append(key + '=?')
                args.append(value)
        rows = db.execute('SELECT * FROM records WHERE ' + ' AND '.join(filters) + ' ORDER BY created,id', args).fetchall()
        return [dict(row, payload=json.loads(row['payload'])) for row in rows]

    @staticmethod
    def put(db, kind, key, payload, owner, sid, run):
        prior = Store.get(db, kind, key)
        if prior and (prior['owner'], prior['sid']) != (owner, sid):
            raise ApiError(409, 'record_identity_conflict')
        encoded = json.dumps(payload, allow_nan=False, separators=(',', ':'), sort_keys=True)
        db.execute('INSERT INTO records VALUES (?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,run=excluded.run', (kind, key, owner, sid, run, encoded, time.time()))

    def path(self, domain, name):
        if not isinstance(name, str) or len(name) > 100 or '/' in name or '\\' in name or '..' in name:
            raise ApiError(500, 'invalid_internal_media_path')
        root = (self.folder(domain) / 'media').resolve()
        target = (root / name).resolve()
        if target.parent != root:
            raise ApiError(500, 'invalid_internal_media_path')
        return target

    def recover(self, domain):
        # Called only with exclusive ownership and no live workers.
        with self.tx(domain) as db:
            for row in self.find(db, 'job'):
                job = row['payload']
                if job['status'] in ('queued', 'running'):
                    job.update(status='failed', errorCode='worker_interrupted')
                    self.put(db, 'job', row['id'], job, row['owner'], row['sid'], row['run'])
                    frame = self.get(db, 'frame', job['frameKey'])
                    if frame:
                        frame['payload']['outcome'] = 'failed'
                        self.put(db, 'frame', frame['id'], frame['payload'], frame['owner'], frame['sid'], frame['run'])
            sessions = self.find(db, 'session')
            for row in sessions:
                if time.time() - row['created'] > self.settings.retention_seconds:
                    db.execute('DELETE FROM records WHERE sid=?', (row['sid'],))
            referenced = {row['payload'].get('mediaName') for row in self.find(db, 'frame')}
        for file in (self.folder(domain) / 'media').iterdir():
            # Only UUID/hash names created by this API can be removed.
            if file.is_file() and file.suffix in ('.upload', '.image') and len(file.stem) == 32 and all(c in '0123456789abcdef' for c in file.stem) and file.name not in referenced:
                file.unlink()

    def media_bytes(self):
        return sum(file.stat().st_size for domain in DOMAINS for file in (self.folder(domain) / 'media').glob('*') if file.is_file())
