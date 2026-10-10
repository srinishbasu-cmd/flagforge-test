from __future__ import annotations

class LabError(Exception):
    """An error that is safe to show to the user; code is stable for the extension."""

    def __init__(self, code: str, message: str, hint: str | None = None, **extra):
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.extra = extra

    def to_dict(self) -> dict:
        d = {"code": self.code, "message": self.message}
        if self.hint:
            d["hint"] = self.hint
        d.update(self.extra)
        return d
