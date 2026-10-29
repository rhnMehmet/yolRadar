"""Bounded opaque-path upload and JPEG/PNG verification. No EXIF is extracted."""
import asyncio
from contextlib import nullcontext
import hashlib
import warnings
from uuid import uuid4
from PIL import Image
from .contracts import ApiError

MIME_FORMAT = {'image/jpeg': 'JPEG', 'image/png': 'PNG'}
MAX_PIXELS = 16_000_000


async def receive_image(request, store, domain, kind, remaining_bytes, *, hash_only=False):
    mime = request.headers.get('content-type', '').split(';', 1)[0].strip().lower()
    if mime not in MIME_FORMAT:
        raise ApiError(415, 'jpeg_or_png_required')
    limit = 4 * 1024 * 1024 if kind == 'frame' else 8 * 1024 * 1024
    name = uuid4().hex + '.upload'
    target = store.path(domain, name)
    digest = hashlib.sha256()
    size = 0
    try:
        async with asyncio.timeout(store.settings.upload_timeout):
            with (nullcontext(None) if hash_only else target.open('xb')) as out:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > limit:
                        raise ApiError(413, 'image_too_large')
                    if not hash_only and size > remaining_bytes:
                        raise ApiError(507, 'media_quota_exceeded')
                    digest.update(chunk)
                    if out is not None:
                        out.write(chunk)
        if not size:
            raise ApiError(422, 'empty_image')
        return {'mediaName': name, 'sha256': digest.hexdigest(), 'mime': mime, 'bytes': size}
    except TimeoutError:
        target.unlink(missing_ok=True)
        raise ApiError(408, 'upload_timeout') from None
    except BaseException:
        target.unlink(missing_ok=True)
        raise


def verify_image(path, mime, frame):
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with Image.open(path, formats=['JPEG', 'PNG']) as image:
            if image.format != MIME_FORMAT[mime] or image.width * image.height > MAX_PIXELS or image.size != (frame['width'], frame['height']) or getattr(image, 'n_frames', 1) != 1:
                raise ValueError('invalid_image')
            image.verify()
        with Image.open(path, formats=['JPEG', 'PNG']) as image:
            image.load()
    # Original bytes are private, short-lived test media, never a public static URL.
