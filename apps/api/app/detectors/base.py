from typing import Protocol


class Detector(Protocol):
    detector_kind: str
    model_version: str
    class_map_version: str

    def detect(self, frame: dict, profile: str) -> list[dict]: ...
